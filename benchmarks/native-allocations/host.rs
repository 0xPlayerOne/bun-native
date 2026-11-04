//! Inserted only into exact historical diagnostic copies, never the host API.
use bun_native_allocation_diagnostic::{self as diagnostic, Observation, Result};
use bun_native_protocol::{Element, Operation, RequestId, Style, Tree, WindowId};

fn checked(result: Result<()>) {
    if let Err(error) = result {
        let _ = diagnostic::failed(error);
        eprintln!("Bun Native allocation diagnostic failed: {error}");
        std::process::exit(78);
    }
}
pub(crate) fn initialize() {
    checked(diagnostic::initialize());
}
pub(crate) fn before(
    id: RequestId,
    window_id: WindowId,
    base_revision: u64,
    operations: &[Operation],
    tree: &Tree,
) {
    let Some(phase) = diagnostic::phase() else {
        return;
    };
    let (first, last) = phase.request_range();
    let valid_sets=(first..=last).contains(&id.get()) && operations.iter().enumerate().all(|(offset,operation)| {
        matches!(operation,Operation::Set {node_id,element:Element::Text{text,style},expected_input_revision:None}
            if *style==Style::default() && phase.valid_set(id.get(),offset,node_id.get(),text))
    });
    checked(diagnostic::before_prepare(Observation {
        id: id.get(),
        window: window_id.get(),
        base_revision,
        operation_count: operations.len(),
        valid_sets,
        root: tree.root_id().get(),
        // The selected Set operations cannot change node ownership/count.
        retained_nodes: if id.get() == first {
            tree.nodes().count()
        } else {
            0
        },
    }));
}
pub(crate) fn after(id: RequestId, applied: bool) {
    checked(diagnostic::after_apply(id.get(), applied));
}
pub(crate) fn render(window_id: WindowId) {
    diagnostic::root_render(window_id.get());
}
pub(crate) fn finish() {
    checked(diagnostic::finish());
}
