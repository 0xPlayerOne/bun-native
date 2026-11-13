//! Accessibility roles for container elements, the states shared by every
//! element kind, and the input sync that keeps content beneath an open modal
//! layer out of the tree. Leaf roles (label, button, text input) and the split
//! divider's splitter are set where those elements render. A plain box is
//! layout only and contributes no accessible node; its children appear under
//! the nearest exposed ancestor. A node's [`Semantics`] are written the same
//! way whether GPUI renders it or a culled row stands in for it ([`Stub`]).

use super::NativeView;
use bun_native_protocol::{AccessibleRole, Element as NativeElement, Live, NodeId, Tree};
use gpui::{
    A11ySubtreeBuilder, AnyElement, App, Bounds, Context, Div, ElementId, GlobalElementId,
    InspectorElementId, LayoutId, Pixels, Role, SharedString, Stateful, Style, Window, prelude::*,
};
use std::hash::{Hash, Hasher};
use std::panic::Location;

/// Where a rendered node lies relative to the open modal layer. Content
/// neither inside the layer nor on its route stays rendered but is hidden
/// from assistive technology, as `aria-modal` content beneath a dialog is, so
/// a screen reader cannot browse out of the dialog any more than Tab can.
///
/// The modal's route is computed once per frame; each child's position
/// follows from its parent's, so the render pass decides this in constant
/// time per node instead of snapshotting two routes per node.
#[derive(Clone, Copy)]
pub(super) struct ModalScope<'a> {
    /// Root-to-modal route; empty while no modal layer is open.
    route: &'a [NodeId],
    position: Position,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Position {
    /// No modal layer is open.
    Free,
    /// The node is `route[index]`, a strict ancestor of the modal layer.
    Route(usize),
    /// The modal layer or a node inside it.
    Inside,
    /// Beneath the modal layer: hidden.
    Beneath,
}

impl<'a> ModalScope<'a> {
    /// `route` is `tree.path(modal)` for the active modal, or empty.
    pub(super) fn of(tree: &Tree, route: &'a [NodeId], node: NodeId) -> Self {
        let position = match route.last() {
            None => Position::Free,
            Some(modal) if tree.is_within(node, *modal) => Position::Inside,
            Some(_) => match route.iter().position(|id| *id == node) {
                Some(index) => Position::Route(index),
                None => Position::Beneath,
            },
        };
        Self { route, position }
    }

    /// The position of `child`, a child of this scope's node.
    pub(super) fn child(self, child: NodeId) -> Self {
        let position = match self.position {
            Position::Route(index) => match self.route.get(index + 1) {
                Some(next) if *next == child && index + 2 == self.route.len() => Position::Inside,
                Some(next) if *next == child => Position::Route(index + 1),
                _ => Position::Beneath,
            },
            position => position,
        };
        Self { position, ..self }
    }

    pub(super) fn hidden(self) -> bool {
        self.position == Position::Beneath
    }

    pub(super) fn position(self) -> Position {
        self.position
    }

    /// A scope taken with [`Self::position`], on the same route.
    pub(super) fn resume(route: &'a [NodeId], position: Position) -> Self {
        Self { route, position }
    }
}

/// Whether a node lies beneath the open modal layer: neither inside it nor on
/// its route.
pub(super) fn beneath_modal(tree: &Tree, node: NodeId, modal: NodeId) -> bool {
    !tree.is_within(node, modal) && !tree.is_within(modal, node)
}

/// The disabled and hidden states of a node that has a role.
pub(super) fn states(base: Stateful<Div>, disabled: bool, hidden: bool) -> Stateful<Div> {
    Semantics {
        disabled,
        hidden,
        ..Semantics::default()
    }
    .states(base)
}

/// What the accessibility tree reads from a node's element: its role, name,
/// list attributes and states. Rendered elements and culled stand-ins
/// ([`Stub`]) write it the same way, so a node's AccessKit data is the same
/// whether or not its row is culled.
#[derive(Clone, Default)]
pub(super) struct Semantics {
    role: Option<Role>,
    label: Option<SharedString>,
    value: Option<SharedString>,
    selected: Option<bool>,
    /// 0-based, as AccessKit counts.
    position: Option<usize>,
    size: Option<usize>,
    modal: bool,
    disabled: bool,
    hidden: bool,
    live: Option<Live>,
}

impl Semantics {
    /// A box with an `accessible_role` is a list or list item, named by its
    /// `accessible_label`, with its set size, 1-based position (AccessKit
    /// counts from 0) and selection; otherwise a scrolling box is a scroll
    /// view. An overlay is a dialog named by its `accessible_label`, with
    /// AccessKit's modal state when it traps focus. A text is a label valued
    /// by its text (AccessKit names labels from their value), with its live
    /// politeness; a button is named by its text. `text` gives a text's or
    /// button's label.
    pub(super) fn of(
        element: &NativeElement,
        hidden: bool,
        text: impl FnOnce() -> SharedString,
    ) -> Self {
        let base = Self {
            hidden,
            ..Self::default()
        };
        match element {
            NativeElement::Box {
                accessibility,
                style,
            } => Self {
                role: match accessibility.accessible_role {
                    Some(AccessibleRole::List) => Some(Role::List),
                    Some(AccessibleRole::ListItem) => Some(Role::ListItem),
                    None if style.overflow.is_some_and(|mode| mode.scrolls()) => {
                        Some(Role::ScrollView)
                    }
                    None => return Self::default(),
                },
                label: accessibility.accessible_label.clone().map(Into::into),
                size: accessibility.accessible_set_size.map(|size| size as usize),
                position: accessibility
                    .accessible_position
                    .map(|position| position as usize - 1),
                selected: accessibility.accessible_selected,
                ..base
            },
            NativeElement::Overlay {
                modal,
                accessible_label,
                ..
            } => Self {
                role: Some(Role::Dialog),
                label: accessible_label.clone().map(Into::into),
                modal: *modal,
                ..base
            },
            NativeElement::Text {
                accessible_live, ..
            } => Self {
                role: Some(Role::Label),
                value: Some(text()),
                live: *accessible_live,
                ..base
            },
            NativeElement::Button { disabled, .. } => Self {
                role: Some(Role::Button),
                label: Some(text()),
                disabled: *disabled,
                ..base
            },
            _ => Self::default(),
        }
    }

    /// The semantics of an element GPUI renders.
    pub(super) fn apply(self, base: Stateful<Div>) -> Stateful<Div> {
        let Some(role) = self.role else {
            return base;
        };
        let mut node = base.role(role);
        if let Some(label) = &self.label {
            node = node.aria_label(label.clone());
        }
        if let Some(value) = &self.value {
            node = node.aria_value(value.clone());
        }
        if let Some(size) = self.size {
            node = node.aria_size_of_set(size);
        }
        if let Some(position) = self.position {
            node = node.aria_position_in_set(position);
        }
        if let Some(selected) = self.selected {
            node = node.aria_selected(selected);
        }
        self.states(node)
    }

    fn states(self, base: Stateful<Div>) -> Stateful<Div> {
        if !self.modal && !self.disabled && !self.hidden && self.live.is_none() {
            return base;
        }
        base.a11y_synthetic_children(move |builder| self.write_states(builder.parent_node()))
    }

    /// What GPUI's `Div` writes from its ARIA properties, in its order:
    /// AccessKit compares nodes property by property in insertion order.
    fn write_properties(&self, node: &mut accesskit::Node) {
        if let Some(label) = &self.label {
            node.set_label(label.to_string());
        }
        if let Some(selected) = self.selected {
            node.set_selected(selected);
        }
        if let Some(value) = &self.value {
            node.set_value(value.to_string());
        }
        if let Some(position) = self.position {
            node.set_position_in_set(position);
        }
        if let Some(size) = self.size {
            node.set_size_of_set(size);
        }
    }

    /// The states, written after the node's children, as `Div` writes them
    /// from its synthetic-children callback.
    fn write_states(&self, node: &mut accesskit::Node) {
        if self.modal {
            node.set_modal();
        }
        if self.disabled {
            node.set_disabled();
        }
        if self.hidden {
            node.set_hidden();
        }
        match self.live {
            Some(Live::Polite) => node.set_live(accesskit::Live::Polite),
            Some(Live::Assertive) => node.set_live(accesskit::Live::Assertive),
            None => {}
        }
    }
}

/// The semantics of a box or overlay: see [`Semantics::of`].
pub(super) fn container(
    base: Stateful<Div>,
    element: &NativeElement,
    hidden: bool,
) -> Stateful<Div> {
    match element {
        NativeElement::Box { .. } | NativeElement::Overlay { .. } => {
            Semantics::of(element, hidden, SharedString::default).apply(base)
        }
        _ => base,
    }
}

/// A culled node's stand-in in the accessibility tree (`view/culling.rs`):
/// an absolutely placed, empty element with the node's element id and
/// [`Semantics`], holding its children's stand-ins. Unlike a `Div` it keeps
/// no element state, hit box, style cascade or listeners, so the many
/// culled rows of a long list cost little while assistive technology is
/// active. A culled enabled button takes AccessKit's focus and click
/// actions directly.
pub(super) struct Stub {
    id: ElementId,
    semantics: Semantics,
    style: Style,
    actions: Option<StubActions>,
    children: Vec<AnyElement>,
}

/// One of a stand-in's AccessKit actions.
pub(super) type StubAction = Box<dyn Fn(&mut Window, &mut App)>;

/// What an assistive technology can do to a culled enabled button.
pub(super) struct StubActions {
    pub(super) focus: StubAction,
    pub(super) click: StubAction,
}

impl Stub {
    /// `place` is the stand-in's rectangle within its parent; `None` puts
    /// it, empty, at the parent's origin.
    pub(super) fn new(
        id: ElementId,
        semantics: Semantics,
        place: Option<Bounds<Pixels>>,
        actions: Option<StubActions>,
        children: Vec<AnyElement>,
    ) -> Self {
        let mut style = Style {
            position: gpui::Position::Absolute,
            ..Style::default()
        };
        let bounds = place.unwrap_or_default();
        style.inset.left = bounds.origin.x.into();
        style.inset.top = bounds.origin.y.into();
        style.size.width = bounds.size.width.into();
        style.size.height = bounds.size.height.into();
        Self {
            id,
            semantics,
            style,
            actions,
            children,
        }
    }
}

impl IntoElement for Stub {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for Stub {
    type RequestLayoutState = Vec<LayoutId>;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let children: Vec<LayoutId> = self
            .children
            .iter_mut()
            .map(|child| child.request_layout(window, cx))
            .collect();
        let layout = window.request_layout(self.style.clone(), children.iter().copied(), cx);
        (layout, children)
    }

    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) {
        for child in &mut self.children {
            child.prepaint(window, cx);
        }
        if let (Some(actions), Some(id)) = (self.actions.take(), id)
            && window.is_a11y_active()
        {
            let node = accesskit_id(id);
            let StubActions { focus, click } = actions;
            window.on_a11y_action(node, accesskit::Action::Focus, move |_, window, cx| {
                focus(window, cx)
            });
            window.on_a11y_action(node, accesskit::Action::Click, move |_, window, cx| {
                click(window, cx)
            });
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        _: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        for child in &mut self.children {
            child.paint(window, cx);
        }
    }

    fn a11y_role(&self) -> Option<accesskit::Role> {
        self.semantics.role
    }

    fn write_a11y_info(&self, node: &mut accesskit::Node) {
        self.semantics.write_properties(node);
        // As a `Div` with click listeners and a tracked focus handle.
        if self.actions.is_some() {
            node.add_action(accesskit::Action::Click);
            node.add_action(accesskit::Action::Focus);
        }
    }

    fn a11y_synthetic_children(&mut self, _: &mut (), builder: &mut A11ySubtreeBuilder) {
        self.semantics.write_states(builder.parent_node());
    }
}

/// The AccessKit node id GPUI gives the element with this global id: the
/// id path's hash, which is also all that `GlobalElementId` feeds a hasher.
fn accesskit_id(id: &GlobalElementId) -> accesskit::NodeId {
    #[derive(Default)]
    struct Path(u64);
    impl Hasher for Path {
        fn finish(&self) -> u64 {
            self.0
        }
        fn write(&mut self, bytes: &[u8]) {
            for byte in bytes {
                self.0 = self.0.rotate_left(8) ^ u64::from(*byte);
            }
        }
        fn write_u64(&mut self, hash: u64) {
            self.0 = hash;
        }
    }
    let mut path = Path::default();
    id.hash(&mut path);
    accesskit::NodeId(path.finish())
}

impl NativeView {
    /// Inputs render their own node, so their hidden state is pushed to them
    /// whenever the open modal layer or the inputs change. With no modal
    /// layer now or before this batch, every input is already exposed.
    pub(super) fn sync_input_accessibility(
        &self,
        modal_before: Option<NodeId>,
        cx: &mut Context<Self>,
    ) {
        let modal = self.overlays.active_modal();
        if modal.is_none() && modal_before.is_none() {
            return;
        }
        let hidden: Vec<_> = {
            let state = self.state.borrow();
            self.inputs
                .iter()
                .map(|(id, input)| {
                    let hidden = modal.is_some_and(|modal| beneath_modal(&state.tree, *id, modal));
                    (input.clone(), hidden)
                })
                .collect()
        };
        for (input, hidden) in hidden {
            input.update(cx, |input, cx| input.set_accessibility_hidden(hidden, cx));
        }
    }
}

/// The vendored `gpui_linux`'s incremental AccessKit updates, compiled here
/// so the host's tests check them against AccessKit's own consumer.
#[cfg(all(test, target_os = "linux"))]
#[path = "../../../vendor/gpui_linux/src/linux/accesskit_delta.rs"]
mod delta;

#[cfg(all(test, target_os = "linux"))]
mod delta_tests;
