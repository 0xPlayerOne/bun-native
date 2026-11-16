//! Release tree preflight probe for leaf mounts at different depths and nonleaf moves.
//! Excludes IPC, GPUI and presentation.
use bun_native_protocol::{Element, NodeId, Operation, Style, Tree};
use std::hint::black_box;

fn id(n: u64) -> NodeId {
    NodeId::try_from(n).unwrap()
}
fn create(n: u64, container: bool) -> Operation {
    Operation::Create {
        node_id: id(n),
        element: if container {
            Element::Box {
                accessibility: Default::default(),
                style: Style::default(),
            }
        } else {
            Element::Text {
                accessible_live: None,
                text: "x".into(),
                style: Style::default(),
            }
        },
    }
}
fn insert(parent: u64, child: u64, index: usize) -> Operation {
    Operation::Insert {
        parent_id: id(parent),
        child_id: id(child),
        index,
    }
}
fn mount(depth: u64, size: u64) -> (Tree, Vec<Operation>, u64) {
    let mut chain = Vec::new();
    for n in 2..=depth + 1 {
        chain.push(create(n, true));
        chain.push(insert(n - 1, n, 0));
    }
    let tree = Tree::new(id(1)).prepare(0, chain, 1).unwrap().tree;
    let mut operations = Vec::new();
    for n in 0..size {
        let child = depth + 2 + n;
        operations.push(create(child, false));
        operations.push(insert(depth + 1, child, n as usize));
    }
    (tree, operations, depth + 1)
}
fn nonleaf() -> (Tree, Vec<Operation>, u64) {
    let tree = Tree::new(id(1))
        .prepare(
            0,
            vec![
                create(2, true),
                insert(1, 2, 0),
                create(3, true),
                insert(1, 3, 1),
                create(4, true),
                insert(2, 4, 0),
                create(5, false),
                insert(4, 5, 0),
            ],
            1,
        )
        .unwrap()
        .tree;
    let mut operations = Vec::new();
    for _ in 0..1024 {
        operations.push(insert(3, 4, 0));
        operations.push(insert(2, 4, 0));
    }
    (tree, operations, 5)
}
fn main() {
    for (name, tree, operations, last, count) in [
        ("depth1", mount(1, 512)),
        ("depth8", mount(8, 512)),
        ("depth32", mount(32, 512)),
        ("nonleaf", nonleaf()),
    ]
    .map(|(name, (tree, ops, last))| {
        let count = if name == "nonleaf" {
            5
        } else {
            last as usize + 512
        };
        (name, tree, ops, last, count)
    }) {
        for trial in 0..35 {
            let prepared = tree.prepare(1, operations.clone(), last).unwrap();
            assert_eq!(prepared.metrics.node_count, count);
            if name == "nonleaf" {
                assert_eq!(prepared.tree.parent(id(4)), Some(id(2)));
                assert_eq!(prepared.tree.node(id(4)).unwrap().children(), &[id(5)]);
            } else {
                let children = prepared.tree.node(id(last)).unwrap().children();
                assert_eq!(children.len(), 512);
                assert!(children
                    .iter()
                    .enumerate()
                    .all(|(i, child)| *child == id(last + i as u64 + 1)));
            }
            if trial >= 5 {
                println!("{name},{trial},{}", prepared.metrics.preflight_nanos);
            }
            black_box(prepared);
        }
    }
}
