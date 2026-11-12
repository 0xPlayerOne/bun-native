//! Deterministic evidence-writer controls, not a native GUI qualification.

use super::*;
use crate::evidence::frame_schedule_tests::make_log;
use crate::input::PaintedInputDecorations;
use bun_native_protocol::{Element, Operation, Style, Tree, WindowId};
use gpui::{point, px, size};
use std::{fs::File, path::Path};

fn id(value: u64) -> NodeId {
    NodeId::try_from(value).unwrap()
}

fn input_tree() -> Tree {
    Tree::new(id(1))
        .prepare(
            0,
            vec![
                Operation::Create {
                    node_id: id(2),
                    element: Element::Input {
                        value: String::new(),
                        placeholder: String::new(),
                        disabled: false,
                        read_only: false,
                        style: Style::default(),
                    },
                },
                Operation::Insert {
                    parent_id: id(1),
                    child_id: id(2),
                    index: 0,
                },
            ],
            1,
        )
        .unwrap()
        .tree
}

fn recolor(tree: &Tree) -> Tree {
    tree.prepare(
        tree.revision(),
        vec![Operation::Set {
            node_id: id(1),
            element: Element::Box {
                accessibility: Default::default(),
                style: Style {
                    background: Some(0xffffff),
                    ..Style::default()
                },
            },
            expected_input_revision: None,
        }],
        2,
    )
    .unwrap()
    .tree
}

fn geometry(offset: f32) -> LayoutSnapshot {
    let bounds = [0., 0., 200., 100.];
    LayoutSnapshot {
        viewport: [200., 100.],
        scale_factor: 1.,
        node_count: 2,
        focused: None,
        nodes: [1, 2]
            .map(|node| {
                (
                    id(node),
                    NodeLayout {
                        bounds,
                        ancestor_clip: bounds,
                    },
                )
            })
            .into(),
        scrolls: vec![ScrollLayout {
            node_id: id(1),
            offset: [0., offset],
            maximum: [0., 100.],
            viewport: bounds,
        }],
        inputs: None,
    }
}

fn records(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn changed_geometry_precedes_tree_and_input_paint_at_every_log_prefix() {
    let (file, evidence) = make_log(false);
    let window = WindowId::try_from(1).unwrap();
    let first = input_tree();
    evidence.painted(window, &first, Some(geometry(-100.)));
    let mut changed = recolor(&first);
    evidence.painted(window, &changed, Some(geometry(0.)));
    // Input edits advance their own revision, not the tree revision.
    changed.replace_input(id(2), "typed".into()).unwrap();
    evidence.painted(window, &changed, Some(geometry(-50.)));
    let rows = records(&file.0);
    assert_eq!(rows.len(), 6);
    let mut offset = None;
    let mut observed = Vec::new();
    for record in &rows {
        if record["type"] == "layout" {
            offset = record["layout"]["scrolls"][0]["offset"][1].as_f64();
        } else if record["type"] == "rendered" {
            let input = record["nodes"][1]["input_revision"].as_u64().unwrap();
            observed.push((record["tree_revision"].as_u64().unwrap(), input, offset));
        }
    }
    // With the previous rendered-before-layout order, the new-theme paint
    // would still observe -100 and could falsely pass scroll preservation.
    assert_eq!(
        observed,
        vec![(1, 0, Some(-100.)), (2, 0, Some(0.)), (2, 1, Some(-50.))]
    );
}

#[test]
fn unchanged_geometry_is_reused_and_geometry_only_frames_are_not_lost() {
    let (file, evidence) = make_log(false);
    let window = WindowId::try_from(1).unwrap();
    let first = input_tree();
    evidence.painted(window, &first, Some(geometry(-100.)));
    let changed = recolor(&first);
    evidence.painted(window, &changed, Some(geometry(-100.)));
    evidence.painted(window, &changed, Some(geometry(-100.)));
    let mut focused = geometry(-50.);
    focused.focused = Some(id(2));
    evidence.painted(window, &changed, Some(focused.clone()));
    evidence.painted(window, &changed, Some(focused));
    let rows = records(&file.0);
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[0]["type"], "layout");
    assert_eq!(rows[1]["type"], "rendered");
    assert_eq!(rows[2]["type"], "rendered");
    assert_eq!(rows[2]["tree_revision"], 2);
    assert_eq!(rows[3]["type"], "layout");
    assert_eq!(rows[3]["tree_revision"], 2);
    assert_eq!(rows[3]["layout"]["focused_node_id"], 2);
    assert_eq!(rows[3]["layout"]["scrolls"][0]["offset"], json!([0., -50.]));
}

#[test]
fn caret_only_paints_publish_new_input_geometry_without_a_tree_revision() {
    let (file, evidence) = make_log(false);
    let window = WindowId::try_from(1).unwrap();
    let mut tree = input_tree();
    tree.replace_input(id(2), "a long line".into()).unwrap();
    let bounds = Bounds::new(point(px(0.), px(0.)), size(px(100.), px(24.)));
    let mut frame = geometry(0.);
    let observation = InputViewportSnapshot {
        viewport: bounds,
        offset: px(202.),
        line_width: px(300.),
        decorations: PaintedInputDecorations {
            clip: bounds,
            caret: Some(Bounds::new(point(px(98.), px(0.)), size(px(2.), px(24.)))),
            selection: None,
            selected_bytes: [11, 11],
            cursor_byte: 11,
        },
    };
    frame.inputs = Some([(id(2), observation)].into());
    evidence.painted(window, &tree, Some(frame.clone()));
    let input = frame.inputs.as_mut().unwrap().get_mut(&id(2)).unwrap();
    input.offset = px(0.);
    input.decorations.cursor_byte = 0;
    input.decorations.selected_bytes = [0, 0];
    input.decorations.caret.as_mut().unwrap().origin.x = px(0.);
    evidence.painted(window, &tree, Some(frame.clone()));
    evidence.painted(window, &tree, Some(frame));
    let rows = records(&file.0);
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["type"], "layout");
    assert_eq!(rows[1]["type"], "rendered");
    assert_eq!(rows[2]["type"], "layout");
    assert_eq!(rows[0]["tree_revision"], rows[2]["tree_revision"]);
    assert_eq!(rows[2]["layout"]["inputs"][0]["offset"], 0.);
    assert_eq!(
        rows[2]["layout"]["inputs"][0]["caret"],
        json!([0., 0., 2., 24.])
    );
    assert_eq!(
        rows[2]["layout"]["inputs"][0]["selected_bytes"],
        json!([0, 0])
    );
    assert!(geometry(0.).json().get("inputs").is_none());
}

#[test]
fn failed_layout_append_cannot_certify_a_new_paint_or_advance_caches() {
    let (file, evidence) = make_log(false);
    let window = WindowId::try_from(1).unwrap();
    let first = input_tree();
    evidence.painted(window, &first, Some(geometry(-100.)));
    let changed = recolor(&first);
    let old_rows = records(&file.0);
    let log = evidence.0.as_ref().unwrap();
    let writable = {
        let mut log = log.borrow_mut();
        std::mem::replace(&mut log.file, File::open(&file.0).unwrap())
    };
    evidence.painted(window, &changed, Some(geometry(0.)));
    assert_eq!(records(&file.0), old_rows);
    {
        let mut log = log.borrow_mut();
        assert_eq!(log.last_state[&window].0, first.revision());
        assert!(log.last_layout[&window] == geometry(-100.));
        log.file = writable;
    }
    evidence.painted(window, &changed, Some(geometry(0.)));
    let rows = records(&file.0);
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[2]["type"], "layout");
    assert_eq!(rows[2]["layout"]["scrolls"][0]["offset"], json!([0., 0.]));
    assert_eq!(rows[3]["type"], "rendered");
    assert_eq!(rows[3]["tree_revision"], changed.revision());
}
