//! In-place style conversion must equal the by-value builder chain it replaced.

use super::*;
use bun_native_protocol::Fill;
use gpui::{Div, div};
use std::time::{Duration, Instant};

/// The former render path: every builder call moves the whole `Div`.
fn by_value(element: &Element, root: bool) -> Div {
    let base = div().flex_shrink_0();
    match element {
        Element::Box { style } => {
            let base = if root { base.size_full() } else { base };
            apply(base.flex().flex_col(), style)
        }
        Element::Text { style, .. } => apply(base, style),
        Element::Button {
            disabled, style, ..
        } => apply(
            base.flex()
                .items_center()
                .justify_center()
                .h(px(44.))
                .px(px(12.))
                .bg(rgb(if *disabled { 0x7a8396 } else { 0x2255cc }))
                .text_color(rgb(0xffffff)),
            style,
        ),
        Element::Input { style, .. } => apply(base.bg(rgb(0xffffff)), style),
        Element::Split { style, .. } => apply(base.flex().flex_row(), style),
        Element::Overlay { style, .. } => apply(base.flex().flex_col(), style),
    }
}

fn in_place(element: &Element, root: bool) -> Div {
    let mut base = div();
    super::element(base.style(), element, root);
    base
}

/// Every protocol field both set and unset across seeds, including values
/// that override a kind's defaults (button height and colors, root fill).
fn style(seed: usize) -> Style {
    let bit = |n: usize| (seed >> n) & 1 == 1;
    let dimension = |n: usize| match (seed >> n) % 3 {
        0 => None,
        1 => Some(Dimension::Pixels(17.5)),
        _ => Some(Dimension::Fill(Fill::Fill)),
    };
    Style {
        direction: [None, Some(Direction::Row), Some(Direction::Column)][seed % 3],
        gap: bit(1).then_some(3.),
        padding: bit(2).then_some(5.25),
        width: dimension(3),
        height: dimension(5),
        min_width: bit(7).then_some(1.),
        max_width: bit(8).then_some(900.),
        min_height: bit(9).then_some(2.),
        max_height: bit(10).then_some(800.),
        flex_grow: bit(11).then_some(1.5),
        flex_shrink: bit(12).then_some(0.),
        align_items: [
            None,
            Some(AlignItems::Start),
            Some(AlignItems::Center),
            Some(AlignItems::End),
            Some(AlignItems::Stretch),
        ][seed % 5],
        justify_content: [
            None,
            Some(JustifyContent::Start),
            Some(JustifyContent::Center),
            Some(JustifyContent::End),
            Some(JustifyContent::SpaceBetween),
            Some(JustifyContent::SpaceAround),
            Some(JustifyContent::SpaceEvenly),
        ][seed % 7],
        overflow: [
            None,
            Some(Overflow::Visible),
            Some(Overflow::Hidden),
            Some(Overflow::ScrollX),
            Some(Overflow::ScrollY),
            Some(Overflow::Scroll),
        ][(seed >> 2) % 6],
        background: bit(13).then_some(0x112233),
        color: bit(14).then_some(0x445566),
        font_size: bit(15).then_some(14.),
        border_width: bit(3).then_some(2.),
        border_color: bit(5).then_some(0xaabbcc),
        corner_radius: bit(6).then_some(4.),
        opacity: bit(9).then_some(0.5),
        font_weight: bit(10).then_some(600.),
        ..Style::default()
    }
}

fn elements(seed: usize) -> Vec<Element> {
    let style = style(seed);
    vec![
        Element::Box {
            style: style.clone(),
        },
        Element::Text {
            text: "label".into(),
            style: style.clone(),
        },
        Element::Button {
            text: "go".into(),
            disabled: false,
            style: style.clone(),
        },
        Element::Button {
            text: "stop".into(),
            disabled: true,
            style: style.clone(),
        },
        Element::Input {
            value: String::new(),
            placeholder: String::new(),
            style: style.clone(),
        },
        Element::Split {
            ratio: 0.5,
            min_size: 0.,
            style: style.clone(),
        },
        Element::Overlay {
            anchor: Default::default(),
            modal: false,
            autofocus: false,
            navigation: Default::default(),
            surface: Default::default(),
            style,
        },
    ]
}

#[test]
fn in_place_style_equals_by_value_builders() {
    for seed in 0..1 << 16 {
        for element in elements(seed) {
            for root in [false, true] {
                let mut expected = by_value(&element, root);
                let mut actual = in_place(&element, root);
                assert_eq!(actual.style(), expected.style(), "{element:?} root={root}");
            }
        }
    }
}

/// `cargo test --release -p bun-native-host style_conversion_bench -- --ignored --nocapture`
#[test]
#[ignore = "timing benchmark"]
fn style_conversion_bench() {
    const NODES: usize = 10_000;
    const ROUNDS: usize = 41;
    let nodes: Vec<Element> = (0..NODES)
        .map(|seed| elements(seed.wrapping_mul(0x9e37)).swap_remove(seed % 5))
        .collect();
    let time = |convert: &dyn Fn(&Element) -> Div| {
        let mut rounds: Vec<Duration> = (0..ROUNDS)
            .map(|_| {
                let start = Instant::now();
                let built: Vec<Div> = nodes.iter().map(convert).collect();
                let elapsed = start.elapsed();
                drop(built);
                elapsed
            })
            .collect();
        rounds.sort();
        (rounds[ROUNDS / 2], rounds[ROUNDS * 9 / 10])
    };
    let bare = time(&|_| div());
    let before = time(&|element| by_value(element, false));
    let after = time(&|element| in_place(element, false));
    eprintln!("{NODES} nodes, median / p90 of {ROUNDS} rounds:");
    eprintln!("  div() only      {:?} / {:?}", bare.0, bare.1);
    eprintln!("  by-value style  {:?} / {:?}", before.0, before.1);
    eprintln!("  in-place style  {:?} / {:?}", after.0, after.1);
}
