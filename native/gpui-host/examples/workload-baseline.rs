//! Direct Rust GPUI baseline for the matched renderer workload (#244).
//!
//! The same window, tree shape and phase counts as `benchmarks/solid/workload.ts`,
//! written as an ordinary GPUI application: no Bun, no protocol, no IPC and no
//! retained native tree. Each operation mutates view state, calls `notify` and
//! yields one turn of the foreground executor so input and paint can run, which
//! is what the host does between commands. `benchmarks/rust-gpui/run.ts` launches
//! it and records the same process metrics as the Bun Native comparison.
//!
//! Timing meanings (they are not the Bun Native acknowledgement):
//! - `apply`: the state mutation and `notify` only.
//! - `turn`: `apply` plus one yielded foreground turn.
//! - `toPaint` (separate, `--paint-samples N`, 0 by default so process wall and CPU
//!   stay comparable): from the mutation until GPUI paints that revision.

use gpui::{
    App, AsyncApp, Bounds, Context, Entity, IntoElement, Render, Role, SharedString,
    TitlebarOptions, Window, WindowBounds, WindowOptions, canvas, div, prelude::*, px, rgb, size,
};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context as TaskContext, Poll};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const TITLE: &str = "Bun Native matched renderer workload";
const WARMUP: usize = 20;

#[derive(Clone)]
struct Options {
    output: std::path::PathBuf,
    iterations: usize,
    rotations: usize,
    mounts: usize,
    rows: usize,
    paint_samples: usize,
}

fn parse_options() -> Result<Options, String> {
    let mut output = None;
    let (mut iterations, mut rotations, mut mounts, mut rows) = (1000, 1000, 100, 32);
    let mut paint_samples = 0;
    let mut args = std::env::args().skip(1);
    while let Some(name) = args.next() {
        let value = args.next().ok_or(format!("{name} needs a value"))?;
        let number = |maximum: usize| -> Result<usize, String> {
            match value.parse::<usize>() {
                Ok(parsed) if (1..=maximum).contains(&parsed) => Ok(parsed),
                _ => Err(format!("{name} must be an integer in 1..{maximum}")),
            }
        };
        match name.as_str() {
            "--output" => output = Some(std::path::PathBuf::from(&value)),
            "--iterations" => iterations = number(10_000)?,
            "--rotations" => rotations = number(10_000)?,
            "--mounts" => mounts = number(1_000)?,
            "--rows" => rows = number(128)?,
            "--paint-samples" if value == "0" => paint_samples = 0,
            "--paint-samples" => paint_samples = number(1_000)?,
            _ => return Err(format!("unknown option {name}")),
        }
    }
    let output = output.ok_or("--output is required")?;
    if !output.is_absolute() {
        return Err("--output must be absolute".into());
    }
    if iterations % 10 != 0 {
        return Err("--iterations must be a multiple of 10".into());
    }
    Ok(Options {
        output,
        iterations,
        rotations,
        mounts,
        rows,
        paint_samples,
    })
}

/// One pending poll: returns control to the platform loop so it can dispatch
/// input and frames, then resumes. GPUI's zero-duration timer is ready at once.
struct YieldNow(bool);

impl Future for YieldNow {
    type Output = ();
    fn poll(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<()> {
        if self.0 {
            Poll::Ready(())
        } else {
            self.0 = true;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }
}

#[derive(Default, Clone, Copy)]
struct Mutations {
    create: usize,
    set: usize,
    insert: usize,
    remove: usize,
}

impl Mutations {
    fn json(self) -> Value {
        json!({"create": self.create, "set": self.set, "insert": self.insert, "remove": self.remove})
    }
    fn minus(self, before: Mutations) -> Mutations {
        Mutations {
            create: self.create - before.create,
            set: self.set - before.set,
            insert: self.insert - before.insert,
            remove: self.remove - before.remove,
        }
    }
}

/// The content subtree: label, button and keyed rows. Dropping it disposes it.
struct Content {
    label: SharedString,
    rows: Vec<(usize, SharedString)>,
}

/// The last painted revision, label and row order, written from the paint phase.
#[derive(Default)]
struct Painted {
    revision: u64,
    label: String,
    order: Vec<usize>,
    paints: u64,
}

struct Workload {
    content: Option<Content>,
    revision: u64,
    mutations: Mutations,
    painted: Rc<RefCell<Painted>>,
}

impl Workload {
    fn mount(&mut self, rows: usize, cx: &mut Context<Self>) {
        self.content = Some(Content {
            label: "Initial".into(),
            rows: (0..rows)
                .map(|id| (id, SharedString::from(format!("Row {id}"))))
                .collect(),
        });
        self.mutations.create += 5 + rows;
        self.mutations.insert += 5 + rows;
        self.changed(cx);
    }
    fn set_label(&mut self, values: &[String], cx: &mut Context<Self>) {
        let content = self.content.as_mut().expect("mounted");
        if let Some(last) = values.last() {
            content.label = last.clone().into();
        }
        self.mutations.set += 1;
        self.changed(cx);
    }
    fn rotate(&mut self, cx: &mut Context<Self>) {
        let content = self.content.as_mut().expect("mounted");
        if content.rows.len() > 1 {
            content.rows.rotate_left(1);
            self.mutations.insert += 1;
        }
        self.changed(cx);
    }
    fn dispose(&mut self, cx: &mut Context<Self>) {
        if self.content.take().is_some() {
            self.mutations.remove += 1;
        }
        self.changed(cx);
    }
    fn changed(&mut self, cx: &mut Context<Self>) {
        self.revision += 1;
        cx.notify();
    }
}

impl Render for Workload {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let revision = self.revision;
        let painted = self.painted.clone();
        let (label, order): (String, Vec<usize>) = match &self.content {
            Some(content) => (
                content.label.to_string(),
                content.rows.iter().map(|(id, _)| *id).collect(),
            ),
            None => (String::new(), Vec::new()),
        };
        let mut root = div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(0xffffff))
            .text_color(rgb(0x17212b))
            .text_size(px(18.));
        if let Some(content) = &self.content {
            // The same native element tree and default look the host paints for
            // the core adapter: box > box(column, gap 8, padding 16) > text,
            // button, box(column, gap 0) > keyed text rows (font size 12).
            root = root.child(
                div().flex_shrink_0().flex().flex_col().child(
                    div()
                        .flex_shrink_0()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .p(px(16.))
                        .child(
                            div()
                                .id("label")
                                .flex_shrink_0()
                                .role(Role::Label)
                                .aria_value(content.label.clone())
                                .child(content.label.clone()),
                        )
                        .child(
                            div()
                                .id("button")
                                .flex_shrink_0()
                                .flex()
                                .items_center()
                                .justify_center()
                                .h(px(44.))
                                .px(px(12.))
                                .bg(rgb(0x2255cc))
                                .text_color(rgb(0xffffff))
                                .role(Role::Button)
                                .aria_label("Benchmark fixture")
                                .cursor_pointer()
                                .child("Benchmark fixture"),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .flex()
                                .flex_col()
                                .gap(px(0.))
                                .children(content.rows.iter().map(|(id, text)| {
                                    div()
                                        .id(("row", *id))
                                        .flex_shrink_0()
                                        .text_size(px(12.))
                                        .role(Role::Label)
                                        .aria_value(text.clone())
                                        .child(text.clone())
                                })),
                        ),
                ),
            );
        }
        root.child(
            canvas(
                |_, _, _| (),
                move |_: Bounds<gpui::Pixels>, (), _, _| {
                    let mut painted = painted.borrow_mut();
                    painted.revision = revision;
                    painted.label = label;
                    painted.order = order;
                    painted.paints += 1;
                },
            )
            .absolute()
            .size(px(1.)),
        )
    }
}

fn distribution(samples: &[f64]) -> Value {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let rank = |fraction: f64| {
        let index = (sorted.len() as f64 * fraction).ceil() as usize;
        index.checked_sub(1).and_then(|i| sorted.get(i)).copied()
    };
    json!({
        "count": samples.len(),
        "p50Ms": rank(0.5),
        "p95Ms": rank(0.95),
        "p99Ms": rank(0.99),
        "totalMs": samples.iter().sum::<f64>(),
        "samplesMs": samples,
    })
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1_000.
}

struct Driver {
    view: Entity<Workload>,
    painted: Rc<RefCell<Painted>>,
}

impl Driver {
    fn revision(&self, cx: &mut AsyncApp) -> u64 {
        cx.update(|cx| self.view.read(cx).revision)
    }
    fn mutations(&self, cx: &mut AsyncApp) -> Mutations {
        cx.update(|cx| self.view.read(cx).mutations)
    }
    /// Apply one operation, then yield one foreground turn. Returns (apply, turn).
    async fn step(
        &self,
        cx: &mut AsyncApp,
        operation: impl FnOnce(&mut Workload, &mut Context<Workload>),
    ) -> (f64, f64) {
        let start = Instant::now();
        cx.update(|cx| self.view.update(cx, operation));
        let apply = ms(start);
        YieldNow(false).await;
        (apply, ms(start))
    }
    /// Wait until GPUI paints at least `revision`, polling once per turn.
    async fn painted(
        &self,
        revision: u64,
        cx: &mut AsyncApp,
        deadline: Instant,
    ) -> Result<(), String> {
        while self.painted.borrow().revision < revision {
            if Instant::now() > deadline {
                return Err(format!("revision {revision} was not painted"));
            }
            cx.background_executor()
                .timer(std::time::Duration::from_millis(1))
                .await;
        }
        Ok(())
    }
}

async fn run(driver: Driver, options: Options, cx: &mut AsyncApp) -> Result<Value, String> {
    let deadline = Instant::now() + std::time::Duration::from_secs(120);
    let check = || {
        if Instant::now() > deadline {
            Err("Rust workload exceeded 120 seconds".to_string())
        } else {
            Ok(())
        }
    };
    for index in 0..WARMUP {
        check()?;
        let value = vec![format!("Warmup {index}")];
        driver
            .step(cx, move |view, cx| view.set_label(&value, cx))
            .await;
    }
    let initial = driver.mutations(cx);
    let mut phases = serde_json::Map::new();
    let mut record = |name: &str, apply: Vec<f64>, turn: Vec<f64>, mutations: Mutations| {
        phases.insert(
            name.into(),
            json!({"apply": distribution(&apply), "turn": distribution(&turn), "mutations": mutations.json()}),
        );
    };

    let before = driver.mutations(cx);
    let (mut apply, mut turn) = (Vec::new(), Vec::new());
    for index in 0..options.iterations {
        check()?;
        let value = vec![format!("Update {index}")];
        let (a, t) = driver
            .step(cx, move |view, cx| view.set_label(&value, cx))
            .await;
        apply.push(a);
        turn.push(t);
    }
    record("signals", apply, turn, driver.mutations(cx).minus(before));

    let before = driver.mutations(cx);
    let (mut apply, mut turn) = (Vec::new(), Vec::new());
    for index in 0..options.iterations / 10 {
        check()?;
        let values: Vec<String> = (0..10).map(|v| format!("{index}: Batched {v}")).collect();
        let (a, t) = driver
            .step(cx, move |view, cx| view.set_label(&values, cx))
            .await;
        apply.push(a);
        turn.push(t);
    }
    record("coalesced", apply, turn, driver.mutations(cx).minus(before));

    let before = driver.mutations(cx);
    let (mut apply, mut turn) = (Vec::new(), Vec::new());
    for _ in 0..options.rotations {
        check()?;
        let (a, t) = driver.step(cx, |view, cx| view.rotate(cx)).await;
        apply.push(a);
        turn.push(t);
    }
    record(
        "keyedRotations",
        apply,
        turn,
        driver.mutations(cx).minus(before),
    );

    let changed = driver.mutations(cx).minus(initial);
    let expected_insert = if options.rows == 1 {
        0
    } else {
        options.rotations
    };
    if (changed.create, changed.set, changed.insert, changed.remove)
        != (
            0,
            options.iterations + options.iterations / 10,
            expected_insert,
            0,
        )
    {
        return Err(format!("unexpected mutation counts {}", changed.json()));
    }

    // The final state must actually paint: label and row order, like the Bun
    // Native calibration's final native paint.
    let revision = driver.revision(cx);
    driver.painted(revision, cx, deadline).await?;
    let expected_label = format!("{}: Batched 9", options.iterations / 10 - 1);
    let shift = options.rotations % options.rows;
    let expected_order: Vec<usize> = (0..options.rows)
        .map(|i| (i + shift) % options.rows)
        .collect();
    let final_paint = {
        let painted = driver.painted.borrow();
        if painted.label != expected_label || painted.order != expected_order {
            return Err(format!(
                "final paint differs: label {:?}, order {:?}",
                painted.label, painted.order
            ));
        }
        json!({"revision": painted.revision, "label": painted.label, "rows": painted.order.len()})
    };

    // Separate, not comparable with acknowledgement: mutation to painted revision.
    let mut to_paint = Vec::new();
    for index in 0..options.paint_samples {
        check()?;
        let value = vec![format!("Paint {index}")];
        let start = Instant::now();
        driver
            .step(cx, move |view, cx| view.set_label(&value, cx))
            .await;
        let revision = driver.revision(cx);
        driver.painted(revision, cx, deadline).await?;
        to_paint.push(ms(start));
    }

    driver.step(cx, |view, cx| view.dispose(cx)).await;
    let mut lifecycle = Vec::new();
    let rows = options.rows;
    for index in 0..options.mounts {
        check()?;
        let start = Instant::now();
        driver.step(cx, move |view, cx| view.mount(rows, cx)).await;
        let value = vec![format!("Lifecycle {index}")];
        driver
            .step(cx, move |view, cx| view.set_label(&value, cx))
            .await;
        driver.step(cx, |view, cx| view.dispose(cx)).await;
        lifecycle.push(ms(start));
    }
    let mut lifecycles = distribution(&lifecycle);
    lifecycles["rowsCreated"] = json!(rows * options.mounts);
    lifecycles["rowsDisposed"] = json!(rows * options.mounts);
    let paints = driver.painted.borrow().paints;
    Ok(json!({
        "phases": phases,
        "lifecycles": lifecycles,
        "toPaint": distribution(&to_paint),
        "finalPaint": final_paint,
        "paints": paints,
        "mutations": driver.mutations(cx).json(),
    }))
}

fn main() {
    let time_origin = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1_000.)
        .unwrap_or(0.);
    let origin = Instant::now();
    let options = match parse_options() {
        Ok(options) => options,
        Err(message) => {
            eprintln!("workload-baseline: {message}");
            std::process::exit(2);
        }
    };
    let failed = Rc::new(RefCell::new(false));
    let exit_failed = failed.clone();
    gpui_platform::application().run(move |cx: &mut App| {
        let application_ready = ms(origin);
        let painted = Rc::new(RefCell::new(Painted::default()));
        let bounds = Bounds::centered(None, size(px(640.), px(720.)), cx);
        let view_painted = painted.clone();
        let window = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some(TITLE.into()),
                    ..Default::default()
                }),
                app_id: Some("dev.bunnative.rust-baseline".into()),
                ..Default::default()
            },
            move |_, cx| {
                cx.new(|_| Workload {
                    content: None,
                    revision: 0,
                    mutations: Mutations::default(),
                    painted: view_painted,
                })
            },
        );
        let window = match window {
            Ok(window) => window,
            Err(error) => {
                eprintln!("workload-baseline: open_window failed: {error}");
                std::process::exit(1);
            }
        };
        let window_opened = ms(origin);
        let view = window.entity(cx).expect("window root");
        let rows = options.rows;
        view.update(cx, |view, cx| view.mount(rows, cx));
        let view_mounted = ms(origin);
        let failed = failed.clone();
        cx.spawn(async move |cx| {
            let driver = Driver { view, painted };
            let started = Instant::now();
            let first_paint = match driver.painted(1, cx, started + std::time::Duration::from_secs(30)).await {
                Ok(()) => Some(ms(origin)),
                Err(_) => None,
            };
            let outcome = if first_paint.is_some() {
                run(driver, options.clone(), cx).await
            } else {
                Err("the mounted view was never painted".into())
            };
            let mut report = json!({
                "schemaVersion": 1,
                "baseline": "rust-gpui",
                "workload": {
                    "iterations": options.iterations,
                    "rotations": options.rotations,
                    "mounts": options.mounts,
                    "rows": options.rows,
                    "paintSamples": options.paint_samples,
                    "warmup": WARMUP,
                },
                "startup": {
                    "timeOriginEpochMs": time_origin,
                    "applicationReadyMs": application_ready,
                    "windowOpenedMs": window_opened,
                    "viewMountedMs": view_mounted,
                    "firstPaintMs": first_paint,
                    "meaning": "milliseconds from main entry; viewMounted is state applied, firstPaint is the first GPUI paint of the mounted view",
                },
                "methodology": {
                    "apply": "view state mutation plus notify; the nearest analogue of the Bun Native acknowledgement, which also includes IPC, JavaScript and tree preparation",
                    "turn": "apply plus one yielded foreground executor turn",
                    "toPaint": "separate phase: mutation to the GPUI paint of that revision; frame-paced, not comparable with acknowledgement",
                    "lifecycle": "mount, one label update, dispose; each step applied and yielded",
                },
                "totalWorkloadMs": ms(origin),
            });
            match outcome {
                Ok(results) => {
                    for (key, value) in results.as_object().expect("object") {
                        report[key] = value.clone();
                    }
                    report["status"] = json!("passed");
                }
                Err(error) => {
                    report["status"] = json!("failed");
                    report["error"] = json!(error);
                    *failed.borrow_mut() = true;
                }
            }
            report["totalWorkloadMs"] = json!(ms(origin));
            let text = serde_json::to_string_pretty(&report).expect("serializable") + "\n";
            if let Err(error) = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&options.output)
                .and_then(|mut file| std::io::Write::write_all(&mut file, text.as_bytes()))
            {
                eprintln!("workload-baseline: cannot write report: {error}");
                *failed.borrow_mut() = true;
            }
            cx.update(|cx| cx.quit());
        })
        .detach();
    });
    if *exit_failed.borrow() {
        std::process::exit(1);
    }
}
