//! Tree mount probe, optionally with four concurrent independent trees.
//! This is not a native-window benchmark.
use bun_native_protocol::{Element, NodeId, Operation, Style, Tree};
use std::hint::black_box;
use std::sync::{Arc, Barrier};

fn id(value: u64) -> NodeId {
    NodeId::try_from(value).unwrap()
}
fn run(worker: usize, barrier: &Barrier) -> Vec<(u64, usize, u64)> {
    let mut results = Vec::new();
    barrier.wait();
    for size in [32u64, 1024] {
        let tree = Tree::new(id(1));
        let mut operations = Vec::new();
        for n in 2..size + 2 {
            operations.push(Operation::Create {
                node_id: id(n),
                element: Element::Text {
                    accessible_live: None,
                    text: "x".into(),
                    style: Style::default(),
                },
            });
            operations.push(Operation::Insert {
                parent_id: id(1),
                child_id: id(n),
                index: (n - 2) as usize,
            });
        }
        for trial in 0..35 {
            let input = operations.clone();
            let prepared = tree.prepare(0, input, 1).unwrap();
            assert_eq!(prepared.metrics.node_count, size as usize + 1);
            assert_eq!(
                prepared.tree.node(id(1)).unwrap().children().len(),
                size as usize
            );
            if trial >= 5 {
                results.push((size, trial, prepared.metrics.preflight_nanos));
            }
            black_box(prepared);
        }
    }
    black_box(worker);
    results
}
fn main() {
    let workers = if std::env::args().nth(1).as_deref() == Some("parallel") {
        4
    } else {
        1
    };
    let barrier = Arc::new(Barrier::new(workers));
    let threads: Vec<_> = (0..workers)
        .map(|worker| {
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || run(worker, &barrier))
        })
        .collect();
    for thread in threads {
        for (size, trial, nanos) in thread.join().unwrap() {
            println!("{size},{trial},{nanos}");
        }
    }
}
