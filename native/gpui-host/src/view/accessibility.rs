//! Accessibility roles for container elements, the states shared by every
//! element kind, and the input sync that keeps content beneath an open modal
//! layer out of the tree. Leaf roles (label, button, text input) and the split
//! divider's splitter are set where those elements render. A plain box is
//! layout only and contributes no accessible node; its children appear under
//! the nearest exposed ancestor.

use super::NativeView;
use bun_native_protocol::{AccessibleRole, Element as NativeElement, Live, NodeId, Tree};
use gpui::{Context, Div, Role, Stateful, prelude::*};

/// Whether a node lies beneath the open modal layer: neither inside it nor on
/// its route. Such nodes stay rendered but are hidden from assistive
/// technology, as `aria-modal` content beneath a dialog is, so a screen reader
/// cannot browse out of the dialog any more than Tab can.
pub(super) fn beneath_modal(tree: &Tree, node: NodeId, modal: Option<NodeId>) -> bool {
    let Some(modal) = modal else { return false };
    let contains =
        |path: Option<Vec<NodeId>>, id: NodeId| path.is_some_and(|path| path.contains(&id));
    !contains(tree.path(node), modal) && !contains(tree.path(modal), node)
}

/// The disabled and hidden states of a node that has a role.
pub(super) fn states(base: Stateful<Div>, disabled: bool, hidden: bool) -> Stateful<Div> {
    live_states(base, disabled, hidden, None)
}

/// [`states`] plus a text node's `accessible_live` politeness. AccessKit
/// announces a live node's name when the node is added and whenever the name
/// changes (AT-SPI `object:announcement`).
pub(super) fn live_states(
    base: Stateful<Div>,
    disabled: bool,
    hidden: bool,
    live: Option<Live>,
) -> Stateful<Div> {
    if !disabled && !hidden && live.is_none() {
        return base;
    }
    base.a11y_synthetic_children(move |builder| {
        let node = builder.parent_node();
        if disabled {
            node.set_disabled();
        }
        if hidden {
            node.set_hidden();
        }
        match live {
            Some(Live::Polite) => node.set_live(accesskit::Live::Polite),
            Some(Live::Assertive) => node.set_live(accesskit::Live::Assertive),
            None => {}
        }
    })
}

/// A box with an `accessible_role` is a list or list item, named by its
/// `accessible_label`, with its set size, 1-based position (AccessKit counts
/// from 0) and selection; otherwise a scrolling box is a scroll view. An
/// overlay is a dialog named by its `accessible_label`, with AccessKit's
/// modal state when it traps focus.
pub(super) fn container(
    base: Stateful<Div>,
    element: &NativeElement,
    hidden: bool,
) -> Stateful<Div> {
    match element {
        NativeElement::Box {
            accessibility,
            style,
        } => {
            let mut node = match accessibility.accessible_role {
                Some(AccessibleRole::List) => base.role(Role::List),
                Some(AccessibleRole::ListItem) => base.role(Role::ListItem),
                None if style.overflow.is_some_and(|mode| mode.scrolls()) => {
                    base.role(Role::ScrollView)
                }
                None => return base,
            };
            if let Some(label) = &accessibility.accessible_label {
                node = node.aria_label(label.clone());
            }
            if let Some(size) = accessibility.accessible_set_size {
                node = node.aria_size_of_set(size as usize);
            }
            if let Some(position) = accessibility.accessible_position {
                node = node.aria_position_in_set(position as usize - 1);
            }
            if let Some(selected) = accessibility.accessible_selected {
                node = node.aria_selected(selected);
            }
            states(node, false, hidden)
        }
        NativeElement::Overlay {
            modal,
            accessible_label,
            ..
        } => {
            let mut dialog = base.role(Role::Dialog);
            if let Some(label) = accessible_label {
                dialog = dialog.aria_label(label.clone());
            }
            let modal = *modal;
            if !modal && !hidden {
                return dialog;
            }
            dialog.a11y_synthetic_children(move |builder| {
                let node = builder.parent_node();
                if modal {
                    node.set_modal();
                }
                if hidden {
                    node.set_hidden();
                }
            })
        }
        _ => base,
    }
}

impl NativeView {
    /// Inputs render their own node, so their hidden state is pushed to them
    /// whenever the open modal layer changes.
    pub(super) fn sync_input_accessibility(&self, cx: &mut Context<Self>) {
        let modal = self.overlays.active_modal();
        let hidden: Vec<_> = {
            let state = self.state.borrow();
            self.inputs
                .iter()
                .map(|(id, input)| (input.clone(), beneath_modal(&state.tree, *id, modal)))
                .collect()
        };
        for (input, hidden) in hidden {
            input.update(cx, |input, cx| input.set_accessibility_hidden(hidden, cx));
        }
    }
}
