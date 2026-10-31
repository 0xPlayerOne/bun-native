use crate::{channel::EventSink, evidence::Evidence, input::TextInput};
use bun_native_protocol::Event;
use gpui::{Context, Entity, Window, canvas, div, prelude::*, px, rgb};

pub(crate) struct NativeView {
    pub(crate) text: String,
    pub(crate) input: Entity<TextInput>,
    events: EventSink,
    evidence: Evidence,
}

impl NativeView {
    pub(crate) fn new(
        text: String,
        input: Entity<TextInput>,
        events: EventSink,
        evidence: Evidence,
    ) -> Self {
        Self {
            text,
            input,
            events,
            evidence,
        }
    }
}

impl Render for NativeView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let evidence = self.evidence.clone();
        let text = self.text.clone();
        let input = self.input.clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .gap_4()
            .p_6()
            .bg(rgb(0xf4f5f7))
            .text_color(rgb(0x17212b))
            .text_size(px(18.))
            .child(div().text_size(px(28.)).child("Bun Native"))
            .child(div().id("app-text").child(self.text.clone()))
            .child(
                div()
                    .id("increment")
                    .w(px(160.))
                    .h(px(44.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_md()
                    .bg(rgb(0x2255cc))
                    .text_color(rgb(0xffffff))
                    .cursor_pointer()
                    .hover(|style| style.bg(rgb(0x1744aa)))
                    .on_click(cx.listener(|view, _, _, cx| view.events.send(Event::Click, cx)))
                    .child("Increment"),
            )
            .child(div().child("Native editable input"))
            .child(self.input.clone())
            .child(
                div()
                    .text_size(px(13.))
                    .child("TypeScript controls the label. GPUI renders every pixel."),
            )
            .child(
                canvas(
                    |_, _, _| (),
                    move |_, (), _, cx| {
                        evidence.painted(&text, input.read(cx).content());
                    },
                )
                .size(px(1.)),
            )
    }
}
