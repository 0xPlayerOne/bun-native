use super::*;
use crate::{Element, Style, MAX_ID};
use std::collections::BTreeMap;

fn id(value: u64) -> NodeId {
    NodeId::try_from(value).unwrap()
}
fn node(label: u64) -> Node {
    Node {
        element: Arc::new(Element::Text {
            accessible_live: None,
            text: label.to_string(),
            style: Style::default(),
        }),
        parent: None,
        children: Arc::default(),
        input_revision: Some(label),
    }
}

/// Deterministic xorshift: the suite needs reproducible random sequences
/// without a property-testing dependency.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }
}

fn assert_same(map: &NodeMap, model: &BTreeMap<NodeId, Node>) {
    assert_eq!(map.len(), model.len());
    assert_eq!(map.iter().len(), model.len());
    assert!(map.iter().eq(model.iter().map(|(id, node)| (*id, node))));
    assert_eq!(map.last_id(), model.keys().next_back().copied());
}

#[test]
fn random_operations_match_an_ordered_map_and_never_alter_snapshots() {
    for seed in 1..=24u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        // Mix dense small IDs, a sparse mid range and the JavaScript limit so
        // growth, pruning and every trie height are exercised.
        let span = [64, 5_000, 1 << 40, MAX_ID][usize::try_from(seed % 4).unwrap()];
        let mut map = NodeMap::default();
        let mut model = BTreeMap::new();
        let mut snapshots = Vec::new();
        for step in 0..1_500u64 {
            let key = id(1 + rng.below(span.min(MAX_ID)));
            match rng.below(10) {
                0..=4 => assert_eq!(map.insert(key, node(step)), model.insert(key, node(step))),
                5..=6 => assert_eq!(map.remove(key), model.remove(&key)),
                7 => {
                    let expected = model.get_mut(&key).map(|node| {
                        node.input_revision = Some(step);
                        node.clone()
                    });
                    let actual = map.get_mut(key).map(|node| {
                        node.input_revision = Some(step);
                        node.clone()
                    });
                    assert_eq!(actual, expected);
                }
                8 => assert_eq!(map.get(key), model.get(&key)),
                _ => snapshots.push((map.clone(), model.clone())),
            }
        }
        assert_same(&map, &model);
        for (snapshot, expected) in &snapshots {
            assert_same(snapshot, expected);
        }
        while let Some(key) = model.keys().next().copied() {
            assert_eq!(map.remove(key), model.remove(&key));
        }
        assert_same(&map, &model);
        assert!(map.root.is_none(), "removing every node frees every block");
    }
}

#[test]
fn a_write_copies_only_its_path_and_shares_untouched_elements() {
    let mut map = NodeMap::default();
    for key in 1..=2_000 {
        map.insert(id(key), node(key));
    }
    let committed = map.clone();
    map.get_mut(id(7)).unwrap().input_revision = None;
    assert_eq!(committed.get(id(7)).unwrap().input_revision, Some(7));
    for key in (1..=2_000).filter(|key| *key != 7) {
        assert!(Arc::ptr_eq(
            &map.get(id(key)).unwrap().element,
            &committed.get(id(key)).unwrap().element
        ));
    }
    let (Some(Block::Branch(before)), Some(Block::Branch(after))) = (&committed.root, &map.root)
    else {
        panic!("2,000 IDs need branch blocks");
    };
    let shared = before
        .iter()
        .zip(after.iter())
        .filter(|(left, right)| match (left, right) {
            (Some(Block::Branch(left)), Some(Block::Branch(right))) => Arc::ptr_eq(left, right),
            (Some(Block::Leaf(left)), Some(Block::Leaf(right))) => Arc::ptr_eq(left, right),
            _ => false,
        })
        .count();
    let occupied = before.iter().filter(|slot| slot.is_some()).count();
    assert_eq!(shared, occupied - 1, "only the written path is copied");
}

#[test]
fn missing_keys_never_copy_shared_blocks() {
    let mut map = NodeMap::default();
    map.insert(id(3), node(3));
    let committed = map.clone();
    assert!(map.get_mut(id(4)).is_none());
    assert!(map.remove(id(1 << 30)).is_none());
    let (Some(Block::Leaf(before)), Some(Block::Leaf(after))) = (&committed.root, &map.root) else {
        panic!("one small ID is a single leaf");
    };
    assert!(Arc::ptr_eq(before, after));
}

type Change = (NodeId, Option<u64>, Option<u64>);

/// What `diff` must report, by comparing both versions key by key. A node is
/// identified by its element allocation, as in `Tree::diff_elements`.
fn naive_diff(old: &NodeMap, new: &NodeMap) -> Vec<Change> {
    let label = |node: &Node| node.input_revision.unwrap();
    let mut keys: Vec<NodeId> = old.iter().chain(new.iter()).map(|(key, _)| key).collect();
    keys.sort();
    keys.dedup();
    keys.into_iter()
        .filter_map(|key| match (old.get(key), new.get(key)) {
            (Some(left), Some(right)) if Arc::ptr_eq(&left.element, &right.element) => None,
            (left, right) => Some((key, left.map(label), right.map(label))),
        })
        .collect()
}

fn trie_diff(old: &NodeMap, new: &NodeMap) -> Vec<Change> {
    let mut changes = Vec::new();
    new.diff(
        old,
        &|left, right| Arc::ptr_eq(&left.element, &right.element),
        &mut |key, left, right| {
            changes.push((
                key,
                left.map(|node| node.input_revision.unwrap()),
                right.map(|node| node.input_revision.unwrap()),
            ));
        },
    );
    changes
}

#[test]
fn diff_matches_a_key_by_key_comparison_across_every_height() {
    for seed in 1..=24u64 {
        let mut rng = Rng(seed.wrapping_mul(0xD1B5_4A32_D192_ED03));
        let span = [64, 5_000, 1 << 40, MAX_ID][usize::try_from(seed % 4).unwrap()];
        let mut map = NodeMap::default();
        let mut versions = vec![map.clone()];
        for step in 0..600u64 {
            let key = id(1 + rng.below(span.min(MAX_ID)));
            match rng.below(10) {
                0..=4 => {
                    map.insert(key, node(step));
                }
                5..=6 => {
                    map.remove(key);
                }
                // A write that keeps the element allocation, like a move.
                7 => {
                    if let Some(found) = map.get_mut(key) {
                        found.input_revision = found.input_revision.map(|value| value + 1);
                    }
                }
                8 if versions.len() < 9 => versions.push(map.clone()),
                _ => {}
            }
        }
        versions.push(map);
        for (left, old) in versions.iter().enumerate() {
            for new in &versions[left..] {
                // `input_revision` differs for a rewritten node, so compare the
                // reported keys and presence; `naive_diff` labels are only for
                // nodes whose element allocation differs.
                assert_eq!(trie_diff(old, new), naive_diff(old, new));
                assert_eq!(trie_diff(new, old), naive_diff(new, old));
            }
        }
    }
}

#[test]
fn diff_of_identical_clones_reads_nothing() {
    let mut map = NodeMap::default();
    for key in 1..=3_000 {
        map.insert(id(key), node(key));
    }
    let clone = map.clone();
    let mut visited = 0;
    map.diff(
        &clone,
        &|_, _| panic!("a shared block is never compared"),
        &mut |_, _, _| {
            visited += 1;
        },
    );
    assert_eq!(visited, 0);
    // One replaced element reports exactly that node.
    let mut changed = map.clone();
    changed.get_mut(id(77)).unwrap().element = Arc::new(Element::Text {
        accessible_live: None,
        text: "new".to_string(),
        style: Style::default(),
    });
    assert_eq!(
        trie_diff(&clone, &changed),
        vec![(id(77), Some(77), Some(77))]
    );
}
