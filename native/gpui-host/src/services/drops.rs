//! Owned file drop targets. GPUI turns an external file drag (XDND on X11,
//! an AppKit `NSDraggingDestination` on macOS, an OLE `IDropTarget` on
//! Windows) into an `ExternalPaths` drag over the window; this UI-thread registry
//! decides which live owned target sees it, keeps the dropped paths in the
//! host and publishes only bounded display names. No path crosses the wire.
//!
//! Removing a target, its node or its window drops it from the registry before
//! any later GPUI callback, so a late drag or drop is never published.

use crate::channel::EventSink;
use bun_native_protocol::{
    DragState, DropId, DropRejection, DropTargetId, DroppedItem, ErrorCode, Event, FilesystemRoot,
    MAX_DROP_ITEMS, MAX_DROP_NAME_BYTES, MAX_DROP_TARGETS, NodeId, Tree, WindowId,
    validate_file_path,
};
use gpui::App;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;

pub(crate) type Failure = (ErrorCode, &'static str);

/// The pinned GPUI X11 backend reads at most 1,024 32-bit units (4,096 bytes)
/// of the `text/uri-list` and does not report whether more remained. A
/// longer list can lose items or end in a truncated path. The AppKit and OLE
/// backends read the whole platform list (`NSFilenamesPboardType`, or each
/// `DragQueryFileW` name at its queried length), so no such bound applies.
#[cfg(target_os = "linux")]
const BACKEND_LIST_BYTES: Option<usize> = Some(4_096);
#[cfg(not(target_os = "linux"))]
const BACKEND_LIST_BYTES: Option<usize> = None;

/// Whether the pinned GPUI backend's file drop delivery is qualified here:
/// local X11 XDND, AppKit or OLE. GPUI's Wayland data-device path is not.
fn qualified_backend(compositor: &str) -> bool {
    match std::env::consts::OS {
        "linux" => compositor == "X11",
        "macos" | "windows" => true,
        _ => false,
    }
}

struct Retained {
    id: DropId,
    paths: Vec<PathBuf>,
}

struct Target {
    window: WindowId,
    node: NodeId,
    hovered: bool,
    drop: Option<Retained>,
}

#[derive(Default)]
struct Registry {
    targets: BTreeMap<DropTargetId, Target>,
    last_target: u64,
    last_drop: u64,
    /// GPUI keeps one app-wide drag. Once a window closes during a drag, that
    /// drag's data can no longer be attributed, so nothing is delivered until
    /// GPUI has no active drag.
    suspended: bool,
}

#[derive(Clone)]
pub(crate) struct Drops {
    registry: Rc<RefCell<Registry>>,
    events: EventSink,
    available: bool,
}

impl Drops {
    pub(crate) fn new(events: EventSink, cx: &App) -> Self {
        Self {
            registry: Rc::default(),
            events,
            available: qualified_backend(cx.compositor_name()),
        }
    }

    pub(crate) fn available(&self) -> bool {
        self.available
    }

    pub(crate) fn register(
        &self,
        window: WindowId,
        target: DropTargetId,
        node: NodeId,
        tree: &Tree,
    ) -> Result<(), Failure> {
        let mut registry = self.registry.borrow_mut();
        if target.get() <= registry.last_target {
            return Err((
                ErrorCode::InvalidHandle,
                "drop target IDs must increase across the session",
            ));
        }
        if tree.node(node).is_none() {
            return Err((
                ErrorCode::InvalidHandle,
                "drop target node is not in the window's committed tree",
            ));
        }
        if registry
            .targets
            .values()
            .any(|item| item.window == window && item.node == node)
        {
            return Err((ErrorCode::Conflict, "this node already is a drop target"));
        }
        if registry.targets.len() >= MAX_DROP_TARGETS {
            return Err((
                ErrorCode::LimitExceeded,
                "session drop target limit exceeded",
            ));
        }
        registry.last_target = target.get();
        registry.targets.insert(
            target,
            Target {
                window,
                node,
                hovered: false,
                drop: None,
            },
        );
        Ok(())
    }

    pub(crate) fn unregister(&self, window: WindowId, target: DropTargetId) -> Result<(), Failure> {
        let mut registry = self.registry.borrow_mut();
        if registry
            .targets
            .get(&target)
            .is_none_or(|item| item.window != window)
        {
            return Err((
                ErrorCode::InvalidHandle,
                "drop target is not live or not owned by this window",
            ));
        }
        registry.targets.remove(&target);
        Ok(())
    }

    pub(crate) fn close_window(&self, window: WindowId, dragging: bool) {
        let mut registry = self.registry.borrow_mut();
        registry.targets.retain(|_, item| item.window != window);
        registry.suspended |= dragging;
    }

    /// GPUI has no active drag: a later drag is attributable again.
    pub(crate) fn resume(&self) {
        self.registry.borrow_mut().suspended = false;
    }

    /// A committed tree that no longer holds a target's node revokes it.
    pub(crate) fn retain_nodes(&self, window: WindowId, tree: &Tree) {
        self.registry
            .borrow_mut()
            .targets
            .retain(|_, item| item.window != window || tree.node(item.node).is_some());
    }

    pub(crate) fn targets(&self, window: WindowId) -> BTreeMap<NodeId, DropTargetId> {
        self.registry
            .borrow()
            .targets
            .iter()
            .filter(|(_, item)| item.window == window)
            .map(|(id, item)| (item.node, *id))
            .collect()
    }

    /// A drag moved within the window. `inside` is the target's bounds test.
    pub(crate) fn drag_moved(&self, target: DropTargetId, inside: bool, cx: &mut App) {
        let window = {
            let mut registry = self.registry.borrow_mut();
            if registry.suspended {
                return;
            }
            let Some(item) = registry.targets.get_mut(&target) else {
                return;
            };
            if item.hovered == inside {
                return;
            }
            item.hovered = inside;
            item.window
        };
        let state = if inside {
            DragState::Entered
        } else {
            DragState::Left
        };
        self.events.ui(
            |sequence| Event::DropTargetDrag {
                sequence,
                window_id: window,
                target_id: target,
                state,
            },
            cx,
        );
    }

    /// GPUI ended the window's drag without a drop on these targets: the
    /// source cancelled, the pointer left the window or another target won.
    pub(crate) fn drag_ended(&self, window: WindowId, cx: &mut App) {
        let ended: Vec<_> = {
            let mut registry = self.registry.borrow_mut();
            registry
                .targets
                .iter_mut()
                .filter(|(_, item)| item.window == window && item.hovered)
                .map(|(id, item)| {
                    item.hovered = false;
                    *id
                })
                .collect()
        };
        for target in ended {
            self.events.ui(
                |sequence| Event::DropTargetDrag {
                    sequence,
                    window_id: window,
                    target_id: target,
                    state: DragState::Left,
                },
                cx,
            );
        }
    }

    /// `chain` is the hit target and its target ancestors, innermost first,
    /// as GPUI last painted them. A frame painted before a commit can still
    /// name a revoked target; the drop then goes to its nearest live ancestor.
    pub(crate) fn dropped(&self, chain: &[DropTargetId], paths: &[PathBuf], cx: &mut App) {
        let (target, outcome) = {
            let mut registry = self.registry.borrow_mut();
            if registry.suspended {
                return;
            }
            let next = registry.last_drop + 1;
            let Some(target) = chain
                .iter()
                .copied()
                .find(|target| registry.targets.contains_key(target))
            else {
                return;
            };
            let item = registry
                .targets
                .get_mut(&target)
                .expect("live target was just found");
            item.hovered = false;
            // A newer drop always replaces the retained one, even if rejected.
            item.drop = None;
            let window = item.window;
            let outcome = match classify(paths) {
                Err(reason) => (window, Err(reason)),
                Ok(items) => {
                    let Ok(drop) = DropId::try_from(next) else {
                        return;
                    };
                    item.drop = Some(Retained {
                        id: drop,
                        paths: paths.to_vec(),
                    });
                    registry.last_drop = next;
                    (window, Ok((drop, items)))
                }
            };
            (target, outcome)
        };
        let (window, outcome) = outcome;
        self.events.ui(
            |sequence| match outcome {
                Ok((drop_id, items)) => Event::DropReceived {
                    sequence,
                    window_id: window,
                    target_id: target,
                    drop_id,
                    items,
                },
                Err(reason) => Event::DropRejected {
                    sequence,
                    window_id: window,
                    target_id: target,
                    reason,
                },
            },
            cx,
        );
    }

    /// Match one retained dropped path lexically beneath a launch root. The
    /// result grants nothing new: the caller already holds that root, and
    /// every later access still resolves beneath its descriptor.
    pub(crate) fn resolve(
        &self,
        window: WindowId,
        target: DropTargetId,
        drop: DropId,
        item: u32,
        root: &FilesystemRoot,
    ) -> Result<String, Failure> {
        let registry = self.registry.borrow();
        let retained = registry
            .targets
            .get(&target)
            .filter(|entry| entry.window == window)
            .and_then(|entry| entry.drop.as_ref())
            .filter(|retained| retained.id == drop)
            .ok_or((
                ErrorCode::InvalidHandle,
                "drop is not the live target's latest drop",
            ))?;
        let path = retained
            .paths
            .get(item as usize)
            .ok_or((ErrorCode::NotFound, "the drop has no item at this index"))?;
        relative(path, &root.path).ok_or((
            ErrorCode::PathDenied,
            "the dropped item is not a representable path beneath this launch root",
        ))
    }
}

fn classify(paths: &[PathBuf]) -> Result<Vec<DroppedItem>, DropRejection> {
    if paths.is_empty() {
        return Err(DropRejection::Empty);
    }
    // Every byte of a path can be percent-encoded as three. If even the
    // largest encoding of these entries fits, GPUI cannot have truncated one.
    let bound: usize = paths
        .iter()
        .map(|path| "file://".len() + 3 * path.as_os_str().len() + "\r\n".len())
        .sum();
    if paths.len() > MAX_DROP_ITEMS || BACKEND_LIST_BYTES.is_some_and(|limit| bound >= limit) {
        return Err(DropRejection::LimitExceeded);
    }
    Ok(paths
        .iter()
        .map(|path| DroppedItem { name: name(path) })
        .collect())
}

/// Untrusted display name: the final component, lossily decoded, without
/// control characters, truncated on a character boundary.
fn name(path: &Path) -> String {
    let raw = path
        .file_name()
        .map_or_else(|| "/".into(), |name| name.to_string_lossy());
    let mut name = String::new();
    for character in raw.chars() {
        let character = if character.is_control() {
            char::REPLACEMENT_CHARACTER
        } else {
            character
        };
        if name.len() + character.len_utf8() > MAX_DROP_NAME_BYTES {
            break;
        }
        name.push(character);
    }
    name
}

fn relative(path: &Path, root: &str) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    let rest = path.strip_prefix(root).ok()?;
    let mut names = Vec::new();
    for component in rest.components() {
        let Component::Normal(name) = component else {
            return None;
        };
        names.push(name.to_str()?);
    }
    let joined = names.join("/");
    validate_file_path(&joined).ok()?;
    Some(joined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_names_are_bounded_untrusted_text() {
        assert_eq!(name(Path::new("/home/a/report.txt")), "report.txt");
        assert_eq!(name(Path::new("/")), "/");
        assert_eq!(name(Path::new("/tmp/a\nb")), "a\u{fffd}b");
        let long = format!("/tmp/{}", "\u{e9}".repeat(200));
        let bounded = name(Path::new(&long));
        assert!(bounded.len() <= MAX_DROP_NAME_BYTES);
        assert_eq!(bounded.chars().count(), 127);
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            let invalid = Path::new(std::ffi::OsStr::from_bytes(b"/tmp/a\xffb"));
            assert_eq!(name(invalid), "a\u{fffd}b");
        }
    }

    #[test]
    fn drops_reject_empty_oversized_and_possibly_truncated_lists() {
        assert_eq!(classify(&[]), Err(DropRejection::Empty));
        let many: Vec<_> = (0..65)
            .map(|index| PathBuf::from(format!("/{index}")))
            .collect();
        assert_eq!(classify(&many), Err(DropRejection::LimitExceeded));
        let allowed: Vec<_> = (0..64)
            .map(|index| PathBuf::from(format!("/{index}")))
            .collect();
        assert_eq!(classify(&allowed).unwrap().len(), 64);
        // 1,363 path bytes may encode to 4,089 bytes, 4,098 with framing.
        // Only the X11 backend truncates; AppKit and OLE read whole lists.
        let near = [PathBuf::from(format!("/{}", "a".repeat(1_362)))];
        if cfg!(target_os = "linux") {
            assert_eq!(classify(&near), Err(DropRejection::LimitExceeded));
        } else {
            assert!(classify(&near).is_ok());
        }
        let fits = [PathBuf::from(format!("/{}", "a".repeat(1_300)))];
        assert!(classify(&fits).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn resolution_is_lexical_beneath_the_launch_root_only() {
        assert_eq!(
            relative(Path::new("/srv/work/a/b.txt"), "/srv/work").as_deref(),
            Some("a/b.txt")
        );
        assert_eq!(
            relative(Path::new("/srv/work"), "/srv/work").as_deref(),
            Some("")
        );
        assert_eq!(relative(Path::new("/x/y"), "/").as_deref(), Some("x/y"));
        for (path, root) in [
            ("/srv/workspace/a", "/srv/work"),
            ("/srv/other/a", "/srv/work"),
            ("/srv/work/../etc/passwd", "/srv/work"),
            ("relative/a", "/"),
            ("/srv/work/a\u{1}b", "/srv/work"),
        ] {
            assert_eq!(relative(Path::new(path), root), None, "{path}");
        }
        let deep = format!("/r/{}", vec!["d"; 33].join("/"));
        assert_eq!(relative(Path::new(&deep), "/r"), None);
    }

    /// Launch roots are POSIX paths, so no Windows drop resolves beneath one.
    #[cfg(windows)]
    #[test]
    fn windows_drops_never_resolve_beneath_posix_launch_roots() {
        for path in [
            r"C:\srv\work\a.txt",
            r"\srv\work\a.txt",
            r"\\?\C:\srv\work\a",
        ] {
            assert_eq!(relative(Path::new(path), "/srv/work"), None, "{path}");
            assert_eq!(relative(Path::new(path), "/"), None, "{path}");
        }
    }
}
