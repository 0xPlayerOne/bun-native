use super::*;
use bun_native_protocol::{Operation, Style};

fn id(value: u64) -> NodeId {
    NodeId::try_from(value).unwrap()
}

/// Children 2..2+count, each measured at `extent` on the main axis and 50
/// across, starting at `start`.
fn measured(count: u64, extent: f32, start: f32, row: bool) -> (Vec<NodeId>, Measure) {
    let children: Vec<_> = (2..2 + count).map(id).collect();
    let size = if row {
        size(px(extent), px(50.))
    } else {
        size(px(50.), px(extent))
    };
    let measure = Measure {
        sizes: children.iter().map(|child| (*child, size)).collect(),
        start: px(start),
        cross: (px(0.), px(50.)),
        mean: px(extent),
        ..Measure::default()
    };
    (children, measure)
}

/// A vertical keep window from `top` to `bottom`.
fn keep(top: f32, bottom: f32) -> Option<Bounds<Pixels>> {
    Some(Bounds::from_corners(
        point(px(-1000.), px(top)),
        point(px(1000.), px(bottom)),
    ))
}

fn run(slot: &Slot) -> &Run {
    match slot {
        Slot::Run(run) => run,
        Slot::Child(index) => panic!("child {index} where a run was expected"),
    }
}

#[test]
fn far_children_collapse_into_runs_around_the_kept_window() {
    let (children, measure) = measured(100, 10., 0., false);
    let (slots, laid, culled) =
        lay_out(&children, &measure, false, px(0.), keep(300., 600.), |_| {
            true
        });
    // Children 30..60 intersect [300, 600); a touching edge does not.
    assert_eq!(culled, 70);
    assert_eq!(slots.len(), 32);
    let before = run(&slots[0]);
    assert_eq!(before.children, 0..30);
    assert_eq!(before.size, size(px(50.), px(300.)));
    assert_eq!(before.places[29], (px(290.), size(px(50.), px(10.))));
    assert!(matches!(slots[1], Slot::Child(30)));
    assert!(matches!(slots[30], Slot::Child(59)));
    assert_eq!(run(&slots[31]).children, 60..100);
    assert_eq!(laid.len(), 32);
    assert_eq!(laid[0], Laid::Run(0..30));
    assert_eq!(laid[1], Laid::Child(30, Fate::Clean));
    assert_eq!(laid[31], Laid::Run(60..100));
}

#[test]
fn unmeasured_and_unclean_children_render_and_split_runs() {
    let (children, mut measure) = measured(100, 10., 0., false);
    // Never measured: estimated at the mean, rendered fresh.
    measure.sizes.remove(&children[10]);
    let dirty = children[80];
    let (slots, laid, culled) = lay_out(
        &children,
        &measure,
        false,
        px(0.),
        keep(400., 500.),
        |child| child != dirty,
    );
    assert_eq!(culled, 100 - 10 - 2);
    let kinds: Vec<_> = slots
        .iter()
        .map(|slot| match slot {
            Slot::Child(index) => format!("{index}"),
            Slot::Run(run) => format!("{}..{}", run.children.start, run.children.end),
        })
        .collect();
    let mut expected = vec!["0..10".to_owned(), "10".to_owned(), "11..40".to_owned()];
    expected.extend((40..50).map(|index| index.to_string()));
    expected.extend(["50..80".to_owned(), "80".to_owned(), "81..100".to_owned()]);
    assert_eq!(kinds, expected);
    assert_eq!(laid[1], Laid::Child(10, Fate::Fresh));
    assert_eq!(laid[3], Laid::Child(40, Fate::Clean));
    assert!(laid.contains(&Laid::Child(80, Fate::Fresh)));
}

#[test]
fn rows_offset_by_gap_and_a_held_viewport_culls_nothing() {
    let (children, measure) = measured(80, 20., 5., true);
    let horizontal = Some(Bounds::from_corners(
        point(px(0.), px(-1000.)),
        point(px(100.), px(1000.)),
    ));
    let (slots, _, culled) = lay_out(&children, &measure, true, px(4.), horizontal, |_| true);
    // Child n spans [5 + 24n, 25 + 24n): children 0..4 intersect [0, 100).
    assert_eq!(culled, 76);
    let rest = run(&slots[4]);
    assert_eq!(rest.children, 4..80);
    assert_eq!(rest.places[1], (px(24.), size(px(20.), px(50.))));
    // 76 children and 75 gaps.
    assert_eq!(rest.size, size(px(76. * 20. + 75. * 4.), px(50.)));
    assert!(rest.row);

    let (slots, laid, culled) = lay_out(&children, &measure, true, px(4.), None, |_| true);
    assert_eq!(culled, 0);
    assert_eq!(slots.len(), 80);
    assert!(
        laid.iter()
            .all(|laid| matches!(laid, Laid::Child(_, Fate::Clean)))
    );
}

#[test]
fn changes_mark_every_ancestor_dirty_and_only_set_elements_restyled() {
    let element = NativeElement::Box {
        accessibility: Default::default(),
        style: Style::default(),
    };
    let operations = [(2, 1), (3, 2), (4, 3), (5, 2)]
        .into_iter()
        .flat_map(|(child, parent)| {
            [
                Operation::Create {
                    node_id: id(child),
                    element: element.clone(),
                },
                Operation::Insert {
                    parent_id: id(parent),
                    child_id: id(child),
                    index: 0,
                },
            ]
        })
        .collect();
    let tree = Tree::new(id(1)).prepare(0, operations, 1).unwrap().tree;
    let mut culling = Culling::default();
    culling.changed(&tree, id(4), false);
    culling.changed(&tree, id(5), true);
    let dirty: std::collections::BTreeSet<_> = culling.dirty.iter().map(|id| id.get()).collect();
    assert_eq!(dirty, [1, 2, 3, 4, 5].into());
    assert_eq!(culling.restyled, [id(5)].into());

    // A frame takes the changes; the next starts clean.
    let frame = culling.frame(
        &tree,
        true,
        false,
        1.,
        [id(3)],
        WeakEntity::new_invalid(),
        None,
    );
    assert!(!frame.clean(&tree, id(4)));
    assert!(frame.pins.contains(&id(2)) && frame.pins.contains(&id(1)));
    assert!(!frame.pins.contains(&id(5)));
    assert_eq!(frame.culled(), 0);
    culling.finish(&frame, |_| false);
    let frame = culling.frame(&tree, true, false, 1., [], WeakEntity::new_invalid(), None);
    assert!(frame.clean(&tree, id(4)));
    assert!(!frame.clean(&tree, id(99)));
}
