//! Isolated changed-node traversal probe; excludes rendering and IPC.
use bun_native_protocol::{Element, NodeId, Operation, Style, Tree};
use std::{hint::black_box, time::Instant};

fn id(value: u64) -> NodeId {
    NodeId::try_from(value).unwrap()
}
fn text(value: &str) -> Element {
    Element::Text {
        accessible_live: None,
        text: value.into(),
        style: Style::default(),
    }
}
fn main() {
    let mut operations = Vec::new();
    for n in 2..=1025 {
        operations.push(Operation::Create {
            node_id: id(n),
            element: text("old"),
        });
        operations.push(Operation::Insert {
            parent_id: id(1),
            child_id: id(n),
            index: (n - 2) as usize,
        });
    }
    let tree = Tree::new(id(1)).prepare(0, operations, 1).unwrap().tree;
    let next = tree
        .prepare(
            1,
            vec![Operation::Set {
                node_id: id(513),
                element: text("new"),
                expected_input_revision: None,
            }],
            1025,
        )
        .unwrap()
        .tree;
    for trial in 0..35 {
        let start = Instant::now();
        let mut total = 0;
        for _ in 0..1000 {
            let mut count = 0;
            next.diff_nodes(&tree, |_, _, _| count += 1);
            assert_eq!(count, 1);
            total += count;
        }
        let elapsed = start.elapsed().as_nanos();
        black_box(total);
        if trial >= 5 {
            println!("{trial},{elapsed}");
        }
    }
}
