//! Opt-in native CEF Views composition. Every CEF call remains on the UI owner.
//! CUSTOM overlays are the supported absolute-placement primitive. Their native
//! clipping resizes the page viewport; this is deliberately not CSS content crop.
use super::{number, reply, window_state, STATE};
use cef::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{cell::RefCell, collections::BTreeSet};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum LayoutMode {
    #[default]
    Stack,
    Manual,
}
impl LayoutMode {
    pub(super) fn parse(value: Option<&Value>) -> Result<Self, String> {
        match value {
            None => Ok(Self::Stack),
            Some(Value::String(value)) if value == "stack" => Ok(Self::Stack),
            Some(Value::String(value)) if value == "manual" => Ok(Self::Manual),
            _ => Err("Invalid view layout mode".into()),
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Layer {
    #[default]
    Content,
    Overlay,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Rectangle {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}
impl Rectangle {
    fn validate(self, empty: bool) -> Result<Self, String> {
        let minimum = if empty { 0 } else { 1 };
        if !(-32768..=32768).contains(&self.x)
            || !(-32768..=32768).contains(&self.y)
            || !(minimum..=32768).contains(&self.width)
            || !(minimum..=32768).contains(&self.height)
        {
            return Err("View geometry requires bounded integer DIPs".into());
        }
        Ok(self)
    }
    fn empty(self) -> bool {
        self.width == 0 || self.height == 0
    }
    fn intersect(self, other: Self) -> Self {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        Self {
            x,
            y,
            width: (self.x + self.width)
                .min(other.x + other.width)
                .saturating_sub(x)
                .max(0),
            height: (self.y + self.height)
                .min(other.y + other.height)
                .saturating_sub(y)
                .max(0),
        }
    }
    fn native(self) -> Rect {
        Rect {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }
}
fn yes() -> bool {
    true
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Presentation {
    bounds: Rectangle,
    #[serde(default)]
    clip: Option<Rectangle>,
    #[serde(default = "yes")]
    visible: bool,
    #[serde(default = "yes")]
    focusable: bool,
    #[serde(default)]
    tab_index: u8,
}
impl Presentation {
    fn parse(value: &Value) -> Result<Self, String> {
        let result: Self =
            serde_json::from_value(value.clone()).map_err(|_| "Invalid view presentation")?;
        result.bounds.validate(false)?;
        if let Some(clip) = result.clip {
            clip.validate(true)?;
        }
        if result.tab_index > 127 {
            return Err("Invalid view tab index".into());
        }
        Ok(result)
    }
    fn viewport(&self, width: i32, height: i32) -> Rectangle {
        let viewport = self.bounds.intersect(Rectangle {
            x: 0,
            y: 0,
            width: width.clamp(0, 32768),
            height: height.clamp(0, 32768),
        });
        self.clip.map_or(viewport, |clip| viewport.intersect(clip))
    }
}
#[derive(Clone)]
pub(super) struct Placement {
    pub(super) presentation: Presentation,
    pub(super) layer: Layer,
}

pub(super) fn creation(
    args: &Value,
    mode: LayoutMode,
    overlay_exists: bool,
    application_owned: bool,
) -> Result<Option<Placement>, String> {
    if mode == LayoutMode::Stack {
        if args.get("presentation").is_some() || args.get("layer").is_some() {
            return Err("View presentation requires a manual-layout window".into());
        }
        return Ok(None);
    }
    let presentation = Presentation::parse(
        args.get("presentation")
            .ok_or("Manual views require a presentation")?,
    )?;
    let layer = match args.get("layer") {
        None => Layer::Content,
        Some(value) => serde_json::from_value(value.clone()).map_err(|_| "Invalid view layer")?,
    };
    if layer == Layer::Overlay && !application_owned {
        return Err("PERMISSION_DENIED: overlays require an application-owned document".into());
    }
    if layer == Layer::Content && overlay_exists {
        return Err("RESOURCE_IN_USE: create content panes before overlays".into());
    }
    Ok(Some(Placement {
        presentation,
        layer,
    }))
}

struct Target {
    window_id: u64,
    window: Window,
    view: BrowserView,
    overlay: Option<OverlayController>,
    placement: Option<Placement>,
}
fn target(id: u64) -> Result<Target, String> {
    // Clone under the registry borrow; all CEF calls occur after it is released.
    STATE.with(|state| {
        let state = state.borrow();
        let record = state.views.get(&id).ok_or("INVALID_HANDLE: view")?;
        let owner = state
            .windows
            .get(&record.window)
            .ok_or("INVALID_HANDLE: owner window")?;
        if record.close.is_some() || owner.closing.is_some() {
            return Err("View is closing".into());
        }
        Ok(Target {
            window_id: record.window,
            window: owner.window.clone().ok_or("Window not ready")?,
            view: record.view.clone().ok_or("Browser view not ready")?,
            overlay: record.overlay.clone(),
            placement: record.placement.clone(),
        })
    })
}
thread_local! { static APPLYING: RefCell<BTreeSet<u64>> = const { RefCell::new(BTreeSet::new()) }; }
struct LayoutGuard(u64);
impl LayoutGuard {
    fn enter(id: u64) -> Option<Self> {
        APPLYING.with(|set| set.borrow_mut().insert(id).then_some(Self(id)))
    }
}
impl Drop for LayoutGuard {
    fn drop(&mut self) {
        APPLYING.with(|set| {
            set.borrow_mut().remove(&self.0);
        });
    }
}
fn apply_one(id: u64) -> Result<(), String> {
    let current = target(id)?;
    let placement = current
        .placement
        .ok_or("UNSUPPORTED_CAPABILITY: view.composition")?;
    let overlay = current.overlay.ok_or("View placement not ready")?;
    if overlay.is_valid() == 0 {
        return Err("View overlay unavailable".into());
    }
    let client = current.window.client_area_bounds_in_screen();
    let viewport = placement.presentation.viewport(client.width, client.height);
    let visible = placement.presentation.visible && !viewport.empty();
    // CEF ignores empty overlay bounds. Hide without resizing to a fake pixel.
    if !visible {
        if overlay.is_visible() != 0 {
            overlay.set_visible(0);
        }
        target(id)?;
        current.view.set_focusable(0);
    } else {
        let actual = overlay.bounds();
        if actual.x != viewport.x
            || actual.y != viewport.y
            || actual.width != viewport.width
            || actual.height != viewport.height
        {
            overlay.set_bounds(Some(&viewport.native()));
        }
        target(id)?;
        current
            .view
            .set_focusable(i32::from(placement.presentation.focusable));
        target(id)?;
        // Show() may activate a native widget. A resize/no-op update must not
        // request activation again or disturb a sibling's current focus.
        if overlay.is_visible() == 0 {
            overlay.set_visible(1);
        }
    }
    target(id)?;
    Ok(())
}
pub(super) fn apply(id: u64) -> Result<(), String> {
    let owner = target(id)?.window_id;
    let Some(_guard) = LayoutGuard::enter(owner) else {
        return Ok(());
    };
    apply_one(id)
}
pub(super) fn layout_changed(window: u64) {
    let Some(_guard) = LayoutGuard::enter(window) else {
        return;
    };
    let ids = STATE.with(|state| {
        state
            .borrow()
            .views
            .iter()
            .filter(|(_, record)| {
                record.window == window && record.close.is_none() && record.overlay.is_some()
            })
            .map(|(id, _)| *id)
            .collect::<Vec<_>>()
    });
    for id in ids {
        if let Err(message) = apply_one(id) {
            if target(id).is_ok() {
                super::fail(&message);
            }
        }
    }
}

fn read(id: u64) -> Result<Value, String> {
    let current = target(id)?;
    let placement = current
        .placement
        .ok_or("UNSUPPORTED_CAPABILITY: view.composition")?;
    let overlay = current.overlay.ok_or("View placement not ready")?;
    if overlay.is_valid() == 0 {
        return Err("View overlay unavailable".into());
    }
    let visible = overlay.is_visible() != 0;
    let native = overlay.bounds();
    let viewport = Rectangle {
        x: native.x,
        y: native.y,
        width: if visible { native.width } else { 0 },
        height: if visible { native.height } else { 0 },
    };
    let result = json!({"presentation": placement.presentation, "layer": placement.layer,
        "viewport":viewport, "visible":visible, "drawn":overlay.is_drawn()!=0,
        "focused":current.view.has_focus()!=0, "focusable":current.view.is_focusable()!=0});
    target(id)?;
    Ok(result)
}
pub(super) fn dispatch(request: u64, operation: &str, args: &Value) -> Result<(), String> {
    let id = number(args, "id")?;
    if operation == "view.present" {
        let presentation = Presentation::parse(
            args.get("presentation")
                .ok_or("Missing view presentation")?,
        )?;
        target(id)?;
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            let record = state.views.get_mut(&id).ok_or("INVALID_HANDLE: view")?;
            let placement = record
                .placement
                .as_mut()
                .ok_or("UNSUPPORTED_CAPABILITY: view.composition")?;
            placement.presentation = presentation;
            Ok::<_, &str>(())
        })?;
        apply(id)?;
    }
    reply(request, read(id)?);
    Ok(())
}

fn eligible(current: &Target) -> bool {
    current.window.is_visible() != 0
        && current.window.is_minimized() == 0
        && current.view.is_visible() != 0
        && current.view.is_drawn() != 0
        && current.view.is_enabled() != 0
        && current.view.is_focusable() != 0
        && current.view.bounds().width > 0
        && current.view.bounds().height > 0
        && current.placement.as_ref().is_none_or(|placement| {
            placement.presentation.visible && placement.presentation.focusable
        })
        && (current.placement.is_none()
            || current.overlay.as_ref().is_some_and(|overlay| {
                overlay.is_valid() != 0 && overlay.is_visible() != 0 && overlay.is_drawn() != 0
            }))
}
pub(super) fn can_focus(id: u64) -> bool {
    target(id).is_ok_and(|current| eligible(&current))
}
pub(super) fn focus(id: u64) -> Result<(), String> {
    let current = target(id)?;
    if !eligible(&current) {
        return Err("PERMISSION_DENIED: view is hidden, clipped or nonfocusable".into());
    }
    if let Some(overlay) = current.overlay.as_ref() {
        // An activatable overlay has its own native widget/first responder.
        // RequestFocus alone changes the Views FocusManager but does not make
        // that widget key on macOS. Show is intentional only for an explicit
        // focus request; ordinary resize/no-op presentation never reactivates it.
        overlay.set_visible(1);
    }
    let current = target(id)?;
    if !eligible(&current) {
        return Err("PERMISSION_DENIED: focus target changed during activation".into());
    }
    current.view.request_focus();
    target(id)?;
    Ok(())
}
fn traversal(ids: &[(u8, u64)], current: Option<u64>, reverse: bool) -> Option<u64> {
    if ids.is_empty() {
        return None;
    }
    match current.and_then(|id| ids.iter().position(|(_, candidate)| *candidate == id)) {
        Some(_) if ids.len() == 1 => None,
        Some(index) => Some(
            ids[if reverse {
                (index + ids.len() - 1) % ids.len()
            } else {
                (index + 1) % ids.len()
            }]
            .1,
        ),
        None => Some(ids[if reverse { ids.len() - 1 } else { 0 }].1),
    }
}
fn cycle(window: u64, current: Option<u64>, reverse: bool) -> Result<Option<u64>, String> {
    window_state::live(window)?;
    let mut ids = STATE.with(|state| {
        state
            .borrow()
            .views
            .iter()
            .filter(|(_, record)| record.window == window && record.close.is_none())
            .map(|(id, record)| {
                (
                    record
                        .placement
                        .as_ref()
                        .map_or(0, |p| p.presentation.tab_index),
                    *id,
                )
            })
            .collect::<Vec<_>>()
    });
    ids.sort_unstable();
    ids.retain(|(_, id)| can_focus(*id));
    let current = current.or_else(|| {
        ids.iter().find_map(|(_, id)| {
            target(*id)
                .ok()
                .filter(|t| t.view.has_focus() != 0)
                .map(|_| *id)
        })
    });
    let next = traversal(&ids, current, reverse);
    if let Some(id) = next {
        focus(id)?;
    }
    window_state::live(window)?;
    Ok(next)
}
pub(super) fn focus_next(request: u64, args: &Value) -> Result<(), String> {
    let window = number(args, "id")?;
    let reverse = args
        .get("reverse")
        .and_then(Value::as_bool)
        .ok_or("Invalid traversal direction")?;
    let next = cycle(window, None, reverse)?;
    reply(request, next.map_or(Value::Null, |id| json!({"id":id})));
    Ok(())
}
pub(super) fn take_focus(id: u64, next: bool) {
    if let Ok(current) = target(id) {
        let _ = cycle(current.window_id, Some(id), !next);
    }
}
pub(super) fn navigation_allowed(id: u64, url: &str) -> bool {
    // CEF may navigate while destroying its widget. Closing views already have
    // no authority and produce no document callbacks; ordinary URL policy still
    // applies in the caller. Do not obstruct their native teardown.
    if !super::live_view(id) {
        return true;
    }
    STATE.with(|state| {
        state.borrow().views.get(&id).is_none_or(|record| {
            record
                .placement
                .as_ref()
                .is_none_or(|p| p.layer != Layer::Overlay)
                || crate::rpc_authority::exact_origin(url).as_deref() == Some("app://ui")
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn presentation() -> Value {
        json!({"bounds":{"x":10,"y":20,"width":300,"height":200}})
    }
    #[test]
    fn legacy_is_default_and_manual_creation_is_explicit() {
        assert_eq!(LayoutMode::parse(None).unwrap(), LayoutMode::Stack);
        assert!(creation(&json!({}), LayoutMode::Stack, false, false)
            .unwrap()
            .is_none());
        assert!(creation(&json!({}), LayoutMode::Manual, false, false).is_err());
        assert!(creation(
            &json!({"presentation":presentation()}),
            LayoutMode::Stack,
            false,
            false
        )
        .is_err());
        for value in [Value::Null, json!(true), json!("absolute")] {
            assert!(LayoutMode::parse(Some(&value)).is_err());
        }
    }
    #[test]
    fn geometry_is_strict_and_bounded_before_native_calls() {
        let value = presentation();
        let accepted = Presentation::parse(&value).unwrap();
        assert!(accepted.visible && accepted.focusable);
        for invalid in [
            json!(null),
            json!(1.5),
            json!(-1),
            json!(32769),
            json!("300"),
        ] {
            let mut candidate = value.clone();
            candidate["bounds"]["width"] = invalid;
            assert!(Presentation::parse(&candidate).is_err());
        }
        for (key, invalid) in [
            ("focusable", json!(1)),
            ("visible", json!("false")),
            ("tabIndex", json!(128)),
            ("extra", json!(0)),
        ] {
            let mut candidate = value.clone();
            candidate[key] = invalid;
            assert!(Presentation::parse(&candidate).is_err());
        }
    }
    #[test]
    fn clipped_viewports_intersect_window_and_clip_without_negative_dimensions() {
        let mut value = presentation();
        value["bounds"]["x"] = json!(-30);
        value["clip"] = json!({"x":20,"y":30,"width":100,"height":50});
        let spec = Presentation::parse(&value).unwrap();
        assert_eq!(
            spec.viewport(80, 100),
            Rectangle {
                x: 20,
                y: 30,
                width: 60,
                height: 50
            }
        );
        assert!(spec.viewport(10, 10).empty());
        assert!(spec.viewport(0, 0).empty());
    }
    #[test]
    fn overlays_are_application_owned_and_stay_above_content_created_first() {
        let mut args = json!({"presentation":presentation(),"layer":"overlay"});
        assert!(creation(&args, LayoutMode::Manual, false, false).is_err());
        assert!(creation(&args, LayoutMode::Manual, false, true).is_ok());
        args["layer"] = json!("content");
        assert!(creation(&args, LayoutMode::Manual, true, true).is_err());
        assert!(creation(&args, LayoutMode::Manual, false, false).is_ok());
    }
    #[test]
    fn traversal_wraps_in_both_directions_without_reselecting_the_only_view() {
        let ids = [(0, 1), (0, 3), (5, 2)];
        assert_eq!(traversal(&ids, None, false), Some(1));
        assert_eq!(traversal(&ids, None, true), Some(2));
        assert_eq!(traversal(&ids, Some(2), false), Some(1));
        assert_eq!(traversal(&ids, Some(1), true), Some(2));
        assert_eq!(traversal(&[(0, 1)], Some(1), false), None);
        assert_eq!(traversal(&[], None, false), None);
    }
    #[test]
    fn missing_and_stale_views_never_receive_focus() {
        assert!(!can_focus(999));
        assert!(focus(999).is_err());
        assert!(read(999).is_err());
    }
}
