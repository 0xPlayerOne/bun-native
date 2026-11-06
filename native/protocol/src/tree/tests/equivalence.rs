//! Random batches, many of them rejected, against the whole-graph-clone
//! oracle: same verdict, error and committed state, failures leave the
//! committed tree untouched, and successes keep sharing every element the
//! batch did not set (what the view's incremental index relies on).

use super::reference::{self, Model};
use super::*;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, bound: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(bound).unwrap()).unwrap()
    }
    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }
}

fn snapshot(tree: &Tree) -> Model {
    Model {
        root_id: tree.root_id,
        revision: tree.revision,
        text_bytes: tree.text_bytes,
        nodes: tree
            .nodes()
            .map(|(id, node)| {
                let node = reference::Node {
                    element: node.element().clone(),
                    parent: node.parent,
                    children: node.children().to_vec(),
                    input_revision: node.input_revision,
                };
                (id, node)
            })
            .collect(),
    }
}

fn element(rng: &mut Rng, kind: Option<&Element>) -> Element {
    let label = ["", "a", "label", "longer label text"][rng.below(4)].to_owned();
    let pick = match kind {
        Some(Element::Box { .. }) if !rng.chance(10) => 0,
        Some(Element::Text { .. }) if !rng.chance(10) => 1,
        Some(Element::Input { .. }) if !rng.chance(10) => 2,
        _ => rng.below(3),
    };
    match pick {
        0 => box_element(),
        1 => text(&label),
        _ => input(&label),
    }
}

struct Batch {
    operations: Vec<Operation>,
    sets: Vec<NodeId>,
}

fn batch(rng: &mut Rng, model: &Model, last_id: u64) -> Batch {
    let live: Vec<NodeId> = model.nodes.keys().copied().collect();
    let mut next_id = last_id;
    let mut created = Vec::new();
    let mut operations = Vec::new();
    let mut sets = Vec::new();
    let any = |rng: &mut Rng, created: &[NodeId]| -> NodeId {
        if !created.is_empty() && rng.chance(40) {
            created[rng.below(created.len())]
        } else if rng.chance(4) {
            id(1 + u64::try_from(rng.below(usize::try_from(last_id).unwrap() + 3)).unwrap())
        } else {
            live[rng.below(live.len())]
        }
    };
    if rng.chance(6) {
        // A chain around the depth limit, attached under a random node.
        let parent = any(rng, &created);
        let length = 55 + rng.below(15);
        let mut above = parent;
        for _ in 0..length {
            next_id += 1;
            operations.push(create(next_id, box_element()));
            operations.push(insert(above.get(), next_id, 0));
            above = id(next_id);
        }
        return Batch { operations, sets };
    }
    for _ in 0..1 + rng.below(4) {
        match rng.below(10) {
            0..=2 => {
                next_id += if rng.chance(5) { 0 } else { 1 };
                operations.push(create(next_id, element(rng, None)));
                created.push(id(next_id));
                if rng.chance(85) {
                    let parent = any(rng, &created);
                    let siblings = model.nodes.get(&parent).map_or(0, |n| n.children.len());
                    operations.push(insert(parent.get(), next_id, rng.below(siblings + 2)));
                }
            }
            3..=5 => {
                let target = any(rng, &created);
                let current = model.nodes.get(&target);
                let expected = match current.and_then(|node| node.input_revision) {
                    Some(revision) if rng.chance(80) => Some(revision),
                    Some(revision) if rng.chance(50) => Some(revision + 1),
                    _ if rng.chance(10) => Some(0),
                    _ => None,
                };
                sets.push(target);
                operations.push(Operation::Set {
                    node_id: target,
                    element: element(rng, current.map(|node| &node.element)),
                    expected_input_revision: expected,
                });
            }
            6..=8 => {
                let parent = any(rng, &created);
                let child = any(rng, &created);
                let siblings = model.nodes.get(&parent).map_or(0, |n| n.children.len());
                operations.push(insert(parent.get(), child.get(), rng.below(siblings + 2)));
            }
            _ => operations.push(delete(any(rng, &created).get())),
        }
    }
    if rng.chance(2) {
        operations.clear();
    }
    Batch { operations, sets }
}

#[test]
fn random_batches_match_whole_graph_clone_preflight() {
    let mut accepted = 0;
    let mut rejected = std::collections::BTreeMap::<&str, usize>::new();
    for seed in 1..=48u64 {
        let mut rng = Rng(seed.wrapping_mul(0x2545_F491_4F6C_DD1D));
        let mut tree = Tree::new(id(1));
        let mut model = Model::new(id(1));
        let mut last_id = 1;
        for _ in 0..240 {
            let Batch { operations, sets } = batch(&mut rng, &model, last_id);
            let base = if rng.chance(3) {
                tree.revision + 1
            } else {
                tree.revision
            };
            let before = tree.clone();
            let expected = model.prepare(base, &operations, last_id);
            match (tree.prepare(base, operations, last_id), expected) {
                (Ok(prepared), Ok((next_model, next_id))) => {
                    accepted += 1;
                    assert_eq!(prepared.last_node_id, next_id);
                    assert_eq!(snapshot(&prepared.tree), next_model);
                    assert_eq!(prepared.metrics.node_count, next_model.nodes.len());
                    for (node_id, node) in prepared.tree.nodes() {
                        if let Some(old) = before.node(node_id).filter(|_| !sets.contains(&node_id))
                        {
                            assert!(Arc::ptr_eq(&old.element, &node.element));
                        }
                    }
                    assert_eq!(snapshot(&before), model, "commit altered its base");
                    // Mimic a native apply failure now and then: the old tree
                    // must remain the usable committed state.
                    if !rng.chance(5) {
                        tree = prepared.tree;
                        model = next_model;
                        last_id = next_id;
                    }
                }
                (Err(error), Err((code, message))) => {
                    *rejected.entry(message).or_default() += 1;
                    assert_eq!((error.code, error.message), (code, message));
                    assert_eq!(tree, before, "failure changed committed state");
                }
                (actual, expected) => panic!(
                    "verdicts differ: {:?} vs {:?}",
                    actual.map(|prepared| prepared.last_node_id),
                    expected.map(|(_, last_id)| last_id)
                ),
            }
            assert_eq!(snapshot(&tree), model);
            if rng.chance(15) {
                if let Some((&input_id, _)) = model
                    .nodes
                    .iter()
                    .find(|(_, node)| node.input_revision.is_some())
                {
                    let value = format!("typed {}", rng.next() % 4);
                    if let Some(revision) = tree.replace_input(input_id, value.clone()).unwrap() {
                        let node = model.nodes.get_mut(&input_id).unwrap();
                        if let Element::Input { value: old, .. } = &mut node.element {
                            model.text_bytes = model.text_bytes - old.len() + value.len();
                            *old = value;
                        }
                        node.input_revision = Some(revision);
                    }
                    assert_eq!(snapshot(&tree), model);
                }
            }
        }
    }
    // The generator must exercise acceptance and every rule a batch can break.
    assert!(accepted > 2_000, "{accepted} accepted");
    for message in [
        "batch leaves detached nodes",
        "tree depth exceeds 64 edges",
        "insert would create a cycle",
        "node IDs must increase across the session and cannot be reused",
        "input revision does not match",
        "insert index exceeds child count after detaching",
        "set cannot change an element kind",
        "node is stale or is not owned by this window",
        "tree revision does not match",
        "batch must have between 1 and 256 operations",
    ] {
        assert!(rejected.get(message) > Some(&5), "{message}: {rejected:?}");
    }
}
