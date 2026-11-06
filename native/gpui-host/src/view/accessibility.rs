//! Accessibility roles for container elements. Leaf roles (label, button,
//! text input) and the split divider's splitter are set where those elements
//! render. A plain box is layout only and contributes no accessible node; its
//! children appear under the nearest exposed ancestor.

use bun_native_protocol::Element as NativeElement;
use gpui::{Div, Role, Stateful, prelude::*};

/// A scrolling box is a scroll view; an overlay is a dialog named by its
/// `accessible_label`, with AccessKit's modal state when it traps focus.
pub(super) fn container(base: Stateful<Div>, element: &NativeElement) -> Stateful<Div> {
    match element {
        NativeElement::Box { style } if style.overflow.is_some_and(|mode| mode.scrolls()) => {
            base.role(Role::ScrollView)
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
            if *modal {
                dialog = dialog.a11y_synthetic_children(|builder| {
                    builder.parent_node().set_modal();
                });
            }
            dialog
        }
        _ => base,
    }
}
