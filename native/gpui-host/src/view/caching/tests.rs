use super::*;
use bun_native_protocol::{Direction, Fill, Operation, Style};
use gpui::{px, size};

fn id(value: u64) -> NodeId {
    NodeId::try_from(value).unwrap()
}

fn boxed(style: Style) -> NativeElement {
    NativeElement::Box {
        accessibility: Default::default(),
        style,
    }
}

fn text(style: Style) -> NativeElement {
    NativeElement::Text {
        text: "label".into(),
        accessible_live: None,
        style,
    }
}

fn button(style: Style) -> NativeElement {
    NativeElement::Button {
        text: "open".into(),
        disabled: false,
        style,
    }
}

fn column(width: bool, height: bool) -> Sizing {
    Sizing::of_children(width, height, true, true, &boxed(Style::default()))
}

fn row(width: bool, height: bool) -> Sizing {
    Sizing::of_children(
        width,
        height,
        true,
        true,
        &boxed(Style {
            direction: Some(Direction::Row),
            ..Style::default()
        }),
    )
}

#[test]
fn children_hold_their_size_only_against_known_parent_sizes() {
    let content = text(Style::default());
    // A column of known width: content height follows only the child.
    assert!(column(true, false).holds(&content));
    // Content-sized width: a wider sibling stretches every child.
    assert!(!column(false, true).holds(&content));
    // A row's children follow the row's height through stretching.
    assert!(row(false, true).holds(&content));
    assert!(!row(true, false).holds(&content));

    let grows = text(Style {
        flex_grow: Some(1.),
        ..Style::default()
    });
    assert!(!column(true, true).holds(&grows));
    let shrinks = text(Style {
        flex_shrink: Some(1.),
        ..Style::default()
    });
    assert!(!column(true, true).holds(&shrinks));

    // A fill along a content-sized main axis follows the siblings.
    let fills = boxed(Style {
        height: Some(Dimension::Fill(Fill::Fill)),
        ..Style::default()
    });
    assert!(!column(true, false).holds(&fills));
    assert!(column(true, true).holds(&fills));
}

#[test]
fn only_boxes_without_an_alignment_stretch_their_children() {
    assert!(column(true, true).stretch);
    let centered = boxed(Style {
        align_items: Some(bun_native_protocol::AlignItems::Center),
        ..Style::default()
    });
    assert!(!Sizing::of_children(true, true, true, true, &centered).stretch);
    let split = NativeElement::Split {
        ratio: 0.5,
        min_size: 0.,
        accessible_label: None,
        style: Style::default(),
    };
    let sizing = Sizing::of_children(true, true, true, true, &split);
    assert!(sizing.row && !sizing.stretch);
}

#[test]
fn only_children_on_whole_pixels_hold() {
    let content = text(Style::default());
    assert!(column(true, true).whole && column(true, true).holds(&content));
    let sized = |whole: bool, fixed: bool, style: Style| {
        Sizing::of_children(true, true, whole, fixed, &boxed(style))
    };
    // A parent off whole pixels, a growing sibling, centering or spreading
    // can each place a child at a fraction.
    assert!(!sized(false, true, Style::default()).holds(&content));
    assert!(!sized(true, false, Style::default()).holds(&content));
    let centered = Style {
        align_items: Some(bun_native_protocol::AlignItems::Center),
        ..Style::default()
    };
    assert!(!sized(true, true, centered).whole);
    let spread = Style {
        justify_content: Some(bun_native_protocol::JustifyContent::SpaceBetween),
        ..Style::default()
    };
    assert!(!sized(true, true, spread).whole);
    let ended = Style {
        align_items: Some(bun_native_protocol::AlignItems::End),
        justify_content: Some(bun_native_protocol::JustifyContent::End),
        ..Style::default()
    };
    assert!(sized(true, true, ended).whole);
    let split = NativeElement::Split {
        ratio: 0.5,
        min_size: 0.,
        accessible_label: None,
        style: Style::default(),
    };
    // A split's panes refine it from their snapped sizes (`view/split.rs`).
    assert!(Sizing::of_children(true, true, true, true, &split).whole);
    assert!(!Sizing::NONE.holds(&content));
}

#[test]
fn child_sizes_are_known_from_pixels_fills_stretch_and_button_height() {
    let pixels = boxed(Style {
        width: Some(Dimension::Pixels(80.)),
        height: Some(Dimension::Pixels(20.)),
        ..Style::default()
    });
    assert_eq!(column(false, false).child(&pixels), (true, true));
    // A pixel main size can still shrink.
    let shrinking = boxed(Style {
        height: Some(Dimension::Pixels(20.)),
        flex_shrink: Some(1.),
        ..Style::default()
    });
    assert_eq!(column(false, false).child(&shrinking), (false, false));

    let fills = boxed(Style {
        width: Some(Dimension::Fill(Fill::Fill)),
        height: Some(Dimension::Fill(Fill::Fill)),
        ..Style::default()
    });
    assert_eq!(column(true, false).child(&fills), (true, false));
    assert_eq!(column(false, true).child(&fills), (false, true));

    let content = text(Style::default());
    // Stretched across a known width; content height.
    assert_eq!(column(true, true).child(&content), (true, false));
    assert_eq!(row(true, true).child(&content), (false, true));

    // A button is 44 px tall unless styled otherwise.
    assert_eq!(
        column(false, false).child(&button(Style::default())),
        (false, true)
    );
    assert_eq!(
        row(false, false).child(&button(Style::default())),
        (false, true)
    );
}

/// 1 holds 2 and 5; 2 holds 3, which holds 4.
fn tree() -> Tree {
    let operations = [(2, 1), (3, 2), (4, 3), (5, 1)]
        .into_iter()
        .flat_map(|(child, parent)| {
            [
                Operation::Create {
                    node_id: id(child),
                    element: boxed(Style::default()),
                },
                Operation::Insert {
                    parent_id: id(parent),
                    child_id: id(child),
                    index: 0,
                },
            ]
        })
        .collect();
    Tree::new(id(1)).prepare(0, operations, 1).unwrap().tree
}

fn caching() -> Caching {
    Caching {
        enabled: true,
        ..Caching::default()
    }
}

fn frame(caching: &mut Caching, tree: &Tree, active: bool, width: f32) -> Option<CacheFrame> {
    caching.frame(
        tree,
        active,
        size(px(width), px(480.)),
        1.,
        &[],
        &BTreeMap::new(),
        false,
        0,
        false,
    )
}

fn measure(caching: &Caching, nodes: &[u64]) {
    let mut measured = caching.measured.borrow_mut();
    for node in nodes {
        measured.insert(
            id(*node),
            Measured {
                parent: id(1),
                size: size(px(10.), px(10.)),
            },
        );
    }
}

fn measured(caching: &Caching) -> Vec<u64> {
    let mut nodes: Vec<_> = caching
        .measured
        .borrow()
        .keys()
        .map(|id| id.get())
        .collect();
    nodes.sort_unstable();
    nodes
}

#[test]
fn outside_changes_and_inactive_frames_render_every_boundary() {
    let tree = tree();
    let mut caching = caching();
    // The first frame has nothing measured.
    assert!(frame(&mut caching, &tree, true, 640.).unwrap().full);
    measure(&caching, &[2, 3, 4, 5]);
    assert!(!frame(&mut caching, &tree, true, 640.).unwrap().full);
    assert_eq!(measured(&caching), [2, 3, 4, 5]);

    // A resize renders everything and forgets every size.
    assert!(frame(&mut caching, &tree, true, 800.).unwrap().full);
    assert!(measured(&caching).is_empty());

    measure(&caching, &[2, 3]);
    caching.invalidate();
    assert!(frame(&mut caching, &tree, true, 800.).unwrap().full);

    // A frame without boundaries is not tracked: the next starts over.
    measure(&caching, &[2, 3]);
    assert!(frame(&mut caching, &tree, false, 800.).is_none());
    assert!(measured(&caching).is_empty());
    assert!(frame(&mut caching, &tree, true, 800.).unwrap().full);
}

#[test]
fn moved_and_restyled_nodes_forget_their_subtree_sizes() {
    let before = tree();
    let mut caching = caching();
    frame(&mut caching, &before, true, 640.);
    measure(&caching, &[2, 3, 4, 5]);

    // Restyle 3 and move 5 under 4.
    let after = before
        .prepare(
            1,
            vec![
                Operation::Set {
                    node_id: id(3),
                    element: boxed(Style {
                        padding: Some(4.),
                        ..Style::default()
                    }),
                    expected_input_revision: None,
                },
                Operation::Insert {
                    parent_id: id(4),
                    child_id: id(5),
                    index: 0,
                },
            ],
            5,
        )
        .unwrap()
        .tree;
    after.diff_nodes(&before, |node, old, new| caching.changed(node, old, new));
    let cache = frame(&mut caching, &after, true, 640.).unwrap();
    assert!(!cache.full);
    assert_eq!(measured(&caching), [2]);

    // A delete drops the node's boundary state.
    let removed = after
        .prepare(2, vec![Operation::Delete { node_id: id(2) }], 5)
        .unwrap()
        .tree;
    measure(&caching, &[2]);
    removed.diff_nodes(&after, |node, old, new| caching.changed(node, old, new));
    assert!(!measured(&caching).contains(&2));
}
