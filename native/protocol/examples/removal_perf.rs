//! Release-mode native tree preflight benchmark; no IPC or GPUI rendering.
use bun_native_protocol::{Element, NodeId, Operation, Style, Tree};
use std::collections::HashSet;
fn id(value: u64) -> NodeId {
    NodeId::try_from(value).unwrap()
}
fn main() {
    let mut mount = Vec::new();
    for n in 2..=4096 {
        mount.push(Operation::Create {
            node_id: id(n),
            element: Element::Text {
                accessible_live: None,
                text: "x".into(),
                style: Style::default(),
            },
        });
        mount.push(Operation::Insert {
            parent_id: id(1),
            child_id: id(n),
            index: (n - 2) as usize,
        });
    }
    let tree = Tree::new(id(1)).prepare(0, mount, 1).unwrap().tree;
    for pattern in ["front", "tail", "alternate"] {
        let chosen: Vec<u64> = match pattern {
            "front" => (2..=2049).collect(),
            "tail" => (2049..=4096).rev().collect(),
            _ => (2..=4096).step_by(2).collect(),
        };
        let ops: Vec<Operation> = chosen
            .iter()
            .map(|&n| Operation::Delete { node_id: id(n) })
            .collect();
        let removed: HashSet<_> = chosen.iter().copied().collect();
        let expected: Vec<_> = (2..=4096)
            .filter(|n| !removed.contains(n))
            .map(id)
            .collect();
        let mut times = Vec::new();
        for trial in 0..35 {
            let prepared = tree.prepare(tree.revision(), ops.clone(), 4096).unwrap();
            assert_eq!(prepared.metrics.node_count, 4096 - chosen.len());
            assert_eq!(prepared.tree.node(id(1)).unwrap().children(), expected);
            if trial >= 5 {
                times.push(prepared.metrics.preflight_nanos);
            }
        }
        times.sort();
        println!("{pattern} {:?}", times);
    }
}
