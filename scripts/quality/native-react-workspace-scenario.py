"""Actual task-workspace actions within the existing owned X11 diagnostic driver."""

INITIAL_TITLES = [
    "Write the project brief",
    "Sketch the workspace navigation",
    "Review the native input flow",
    "Test keyboard navigation",
    "Check light and dark appearances",
    "Review empty and filtered states",
    "Measure the release build",
    "Try the app on a smaller display",
    "Collect feedback from a teammate",
    "Update the getting started guide",
    "Verify window close cleanup",
    "Prepare the next release",
]

PLAN_STEPS = [
    "Clarify the goal",
    "List what is already done",
    "Pick the first concrete change",
    "Note who needs to review it",
    "Decide how to check the result",
    "Estimate the remaining effort",
    "Flag anything that blocks progress",
    "Share the plan with the team",
]
PLAN_LABELS = [f"{index + 1}. {step}" for index, step in enumerate(PLAN_STEPS)]


def require(items, description):
    """Return the first match, or fail with a diagnostic instead of StopIteration."""
    for item in items:
        return item
    raise RuntimeError(f"Native workspace evidence is missing {description}")


def dark_input_pixels(driver, geometry_tools, screenshot, current):
    """Observe actual input fill and readable text, beyond semantic tree records."""
    observations = {}
    for label, expected_background in (
        ("Add a task", "222D3C"),
        ("Search tasks", "222D3C"),
        ("Task title", "151B24"),
    ):
        node = require(
            (
                item
                for item in current["paint"]["nodes"]
                if item["element"]["kind"] == "input"
                and item["element"]["placeholder"] == label
            ),
            f"the {label!r} input paint",
        )
        geometry = require(
            (
                item
                for item in current["layout"]["nodes"]
                if item["node_id"] == node["node_id"]
            ),
            f"the {label!r} input geometry",
        )
        bounds = geometry_tools.rectangle(geometry["bounds"])
        if geometry_tools.intersects(bounds, geometry["ancestor_clip"]) != bounds:
            raise RuntimeError(
                "Input pixel observation requires the whole native input"
            )
        geometry_tools.pointer_point(
            bounds, geometry["ancestor_clip"], current["layout"]["viewport"]
        )
        x, y, width, height = (round(value) for value in bounds)
        sample = driver.run(
            [
                "convert",
                str(screenshot),
                "-alpha",
                "off",
                "-colorspace",
                "sRGB",
                "-depth",
                "8",
                "-format",
                f"%w %h %[hex:p{{{x + width - 2},{y + 2}}}]",
                "info:",
            ]
        ).split()
        if [int(sample[0]), int(sample[1])] != current["layout"]["viewport"]:
            raise RuntimeError("Captured pixels differ from the native viewport")
        # The dark fill and blue caret are below this luminance threshold. Both
        # placeholder text and an entered title must supply visible foreground.
        foreground = float(
            driver.run(
                [
                    "convert",
                    str(screenshot),
                    "-crop",
                    f"{min(width - 8, 256)}x{min(height - 8, 28)}+{x + 4}+{y + 4}",
                    "+repage",
                    "-alpha",
                    "off",
                    "-colorspace",
                    "Gray",
                    "-threshold",
                    "45%",
                    "-format",
                    "%[fx:mean]",
                    "info:",
                ]
            )
        )
        observations[label] = {
            "background": sample[2],
            "expectedBackground": expected_background,
            "visibleForegroundFraction": foreground,
        }
    return observations


def run(
    driver,
    geometry_tools,
    window,
    output,
    native_records,
    application_records,
    wait_for,
    require_owned,
    capture,
):
    """Use native paints/geometry and independent expected task outcomes, never mocks."""
    observations = {}

    def latest(records, kind):
        return next(
            (row for row in reversed(records) if row.get("type") == kind),
            None,
        )

    def frame():
        records = native_records()
        paint, geometry = latest(records, "rendered"), latest(records, "layout")
        if (
            not paint
            or not geometry
            or geometry["tree_revision"] > paint["tree_revision"]
        ):
            return None
        layout = geometry["layout"]
        if layout.get("status") != "complete":
            return None
        if layout.get("scale_factor") != 1:
            raise RuntimeError("Workspace requires scale-1 native geometry")
        # The host suppresses identical geometry across style/text-only commits.
        # Match the entire live node set, rather than requiring a new layout
        # record when only the paint changed. Pointer bounds are checked below.
        if {item["node_id"] for item in layout["nodes"]} != {
            item["node_id"] for item in paint["nodes"]
        }:
            return None
        return {"paint": paint, "layout": layout}

    def state():
        return next(
            (
                row["state"]
                for row in reversed(application_records())
                if row.get("type") == "workspace-state"
            ),
            None,
        )

    def settled(description):
        return wait_for(frame, description)

    def wait_frame(predicate, description):
        def matches():
            current = frame()
            return current if current and predicate(current) else None

        return wait_for(matches, description)

    def node(kind, label):
        current = settled("native workspace geometry")
        return require(
            (
                item
                for item in current["paint"]["nodes"]
                if item["element"]["kind"] == kind
                and item["element"].get("placeholder" if kind == "input" else "text")
                == label
            ),
            f"the {label!r} {kind} paint",
        )

    def action(*arguments):
        require_owned()
        if driver.run(["xdotool", "getwindowfocus"]) != window:
            raise RuntimeError("Owned workspace window lost focus before input")
        driver.run(["xdotool", *arguments])

    def geometry(identity, current):
        return require(
            (
                item
                for item in current["layout"]["nodes"]
                if item["node_id"] == identity
            ),
            f"geometry for node {identity}",
        )

    def pointer(identity):
        current = settled("current workspace geometry")
        fields = dict(
            line.split("=", 1)
            for line in driver.run(
                ["xdotool", "getwindowgeometry", "--shell", window]
            ).splitlines()
        )
        if current["layout"]["viewport"] != [
            int(fields["WIDTH"]),
            int(fields["HEIGHT"]),
        ]:
            raise RuntimeError("Workspace geometry differs from the owned X11 client")
        target = geometry(identity, current)
        return geometry_tools.pointer_point(
            target["bounds"], target["ancestor_clip"], current["layout"]["viewport"]
        )

    def click(identity):
        x, y = pointer(identity)
        action("mousemove", "--window", window, x, y, "click", "1")

    def button(label):
        target = node("button", label)
        assert not target["element"]["disabled"], f"{label} must be enabled"
        click(target["node_id"])

    def input_value(label, value):
        def matches():
            current = frame()
            if not current:
                return None
            return next(
                (
                    item
                    for item in current["paint"]["nodes"]
                    if item["element"]["kind"] == "input"
                    and item["element"]["placeholder"] == label
                    and item["element"]["value"] == value
                ),
                None,
            )

        return wait_for(matches, f"native {label} text {value!r}")

    def edit(label, value):
        target = node("input", label)
        click(target["node_id"])
        wait_frame(
            lambda current: current["layout"]["focused_node_id"] == target["node_id"],
            "native input focus",
        )
        action("key", "--clearmodifiers", "ctrl+a")
        if value:
            action("type", "--clearmodifiers", "--delay", "10", value)
        else:
            action("key", "--clearmodifiers", "BackSpace")
        return input_value(label, value)

    initial = settled("initial workspace paint and native geometry")
    initial_nodes = {item["node_id"]: item for item in initial["paint"]["nodes"]}
    first_title = node("button", INITIAL_TITLES[0])["node_id"]
    first_row = require(
        (
            item["node_id"]
            for item in initial_nodes.values()
            if first_title in item["children"]
        ),
        "the first task row",
    )
    list_id = require(
        (
            item["node_id"]
            for item in initial_nodes.values()
            if first_row in item["children"]
        ),
        "the task list",
    )

    def rows(current):
        nodes = {item["node_id"]: item for item in current["paint"]["nodes"]}
        result = []
        for identity in nodes[list_id]["children"]:
            row = nodes[identity]
            assert row["element"]["kind"] == "box" and len(row["children"]) == 2
            toggle, title = (nodes[child] for child in row["children"])
            assert toggle["element"]["kind"] == title["element"]["kind"] == "button"
            assert toggle["element"]["text"] in ("Complete", "Reopen")
            result.append(
                {
                    "title": title["element"]["text"],
                    "row": identity,
                    "toggle": toggle["node_id"],
                    "completed": toggle["element"]["text"] == "Reopen",
                }
            )
        return result

    def expect_rows(titles):
        return wait_frame(
            lambda current: [row["title"] for row in rows(current)] == titles,
            "complete expected native task list",
        )

    def scroll(current):
        return require(
            (
                item
                for item in current["layout"]["scrolls"]
                if item["node_id"] == list_id
            ),
            "the task list scroll geometry",
        )

    expect_rows(INITIAL_TITLES)
    assert scroll(initial)["offset"] == [0, 0]
    assert scroll(initial)["maximum"][1] > 0, (
        "Initial tasks must actually overflow the native list"
    )
    original_rows = {row["title"]: row["row"] for row in rows(initial)}
    observations["initial"] = initial

    def wheel(button_number):
        current = settled("workspace scroll geometry")
        viewport = scroll(current)["viewport"]
        x, y = geometry_tools.pointer_point(
            viewport, viewport, current["layout"]["viewport"]
        )
        action(
            "mousemove",
            "--window",
            window,
            x,
            y,
            "click",
            "--repeat",
            "12",
            "--delay",
            "15",
            button_number,
        )

    wheel("5")
    scrolled = wait_frame(
        lambda current: geometry_tools.at_scroll_end(scroll(current), 1),
        "workspace native wheel endpoint",
    )
    button(INITIAL_TITLES[-1])
    wait_for(
        lambda: state() and state()["selectedId"] == 12,
        "selection of the scrolled task",
    )
    input_value("Task title", INITIAL_TITLES[-1])
    capture(window, "scrolled.png")
    observations["scrolled"] = scrolled

    button("Use dark theme")
    wait_for(lambda: state() and state()["theme"] == "dark", "workspace theme change")
    dark = wait_frame(
        lambda current: any(
            item["element"].get("text") == "Use light theme"
            for item in current["paint"]["nodes"]
        ),
        "native dark theme paint",
    )
    assert any(
        item["element"].get("style", {}).get("background") == 0x151B24
        for item in dark["paint"]["nodes"]
    )
    assert scroll(dark)["offset"] == scroll(scrolled)["offset"], (
        "Theme update reset native scroll"
    )
    assert {row["title"]: row["row"] for row in rows(dark)} == original_rows

    def readable_dark_inputs():
        require_owned()
        capture(window, "dark.png")
        pixels = dark_input_pixels(driver, geometry_tools, output / "dark.png", dark)
        observations["darkInputPixels"] = pixels
        return (
            pixels
            if all(
                value["background"] == value["expectedBackground"]
                and value["visibleForegroundFraction"] > 0
                for value in pixels.values()
            )
            else None
        )

    try:
        wait_for(readable_dark_inputs, "readable dark input pixels")
    except RuntimeError as error:
        raise RuntimeError(
            f"Dark input pixels did not match: {observations.get('darkInputPixels')}"
        ) from error

    action("windowsize", "--sync", window, "900", "700")
    resized = wait_frame(
        lambda current: current["layout"]["viewport"] == [900, 700],
        "workspace native resize",
    )
    assert (
        abs(
            geometry(list_id, resized)["bounds"][2]
            - geometry(list_id, dark)["bounds"][2]
            + 100
        )
        <= 1
    )
    assert scroll(resized)["maximum"][1] >= scroll(dark)["maximum"][1]
    capture(window, "resized.png")
    observations["resized"] = resized
    action("windowsize", "--sync", window, "1000", "760")
    wait_frame(
        lambda current: current["layout"]["viewport"] == [1000, 760],
        "restored workspace viewport",
    )
    wheel("4")
    wait_frame(
        lambda current: scroll(current)["offset"] == [0, 0],
        "native scroll returns to the beginning",
    )

    edit("Add a task", "Release workspace")
    button("Add task")
    wait_for(lambda: state() and state()["selectedId"] == 13, "added task selection")
    added = expect_rows(["Release workspace", *INITIAL_TITLES])
    input_value("Add a task", "")
    assert {row["title"]: row["row"] for row in rows(added)[1:]} == original_rows

    edit("Task title", "Ship native workspace")
    button("Save title")
    renamed = expect_rows(["Ship native workspace", *INITIAL_TITLES])
    assert rows(renamed)[0]["row"] == rows(added)[0]["row"], (
        "Renaming remounted a keyed task"
    )
    click(rows(renamed)[0]["toggle"])
    wait_frame(
        lambda current: rows(current)[0]["completed"], "native completion toggle"
    )
    capture(window, "edited.png")

    button("Active")
    expect_rows(INITIAL_TITLES[1:])
    button("Completed")
    expect_rows(["Ship native workspace", INITIAL_TITLES[0]])
    edit("Search tasks", "Ship")
    expect_rows(["Ship native workspace"])
    capture(window, "filtered.png")
    edit("Search tasks", "")
    expect_rows(["Ship native workspace", INITIAL_TITLES[0]])
    button("All tasks")
    expect_rows(["Ship native workspace", *INITIAL_TITLES])
    button("Delete task")
    final = expect_rows(INITIAL_TITLES)
    wait_for(lambda: state() and state()["selectedId"] == 1, "selection after deletion")
    input_value("Task title", INITIAL_TITLES[0])
    observations["final"] = final
    capture(window, "after.png")

    # Local plan streaming: one owned React timer, keyed append-only rows,
    # stop, selection-change cancellation and OS close while still pending.
    def has_text(current, text):
        return any(
            item["element"]["kind"] == "text" and item["element"].get("text") == text
            for item in current["paint"]["nodes"]
        )

    def plan_rows(current):
        nodes = {item["node_id"]: item for item in current["paint"]["nodes"]}
        first = next(
            (
                item
                for item in nodes.values()
                if item["element"]["kind"] == "text"
                and item["element"].get("text") == PLAN_LABELS[0]
            ),
            None,
        )
        if not first:
            return []
        container = next(
            item for item in nodes.values() if first["node_id"] in item["children"]
        )
        result = [nodes[child] for child in container["children"]]
        labels = [row["element"].get("text") for row in result]
        assert labels == PLAN_LABELS[: len(labels)], f"Unexpected plan rows {labels}"
        return result

    def plan(identity=None):
        current = state()
        value = current and current["plan"]
        return (
            value if value and (identity is None or value["id"] == identity) else None
        )

    def progress(status, count):
        return f"{status} · {count} of {len(PLAN_STEPS)} steps"

    button("Draft a plan")
    partial = wait_frame(
        lambda current: (
            0 < len(plan_rows(current)) < len(PLAN_STEPS)
            and has_text(current, progress("Drafting locally", len(plan_rows(current))))
        ),
        "partial native plan stream",
    )
    first_step = plan_rows(partial)[0]["node_id"]
    capture(window, "plan-streaming.png")
    complete = wait_frame(
        lambda current: (
            len(plan_rows(current)) == len(PLAN_STEPS)
            and has_text(current, progress("Plan ready", len(PLAN_STEPS)))
        ),
        "complete native plan",
    )
    assert plan_rows(complete)[0]["node_id"] == first_step, (
        "Streaming replaced a keyed plan step"
    )
    assert plan(1) == {
        "id": 1,
        "taskId": 1,
        "steps": PLAN_STEPS,
        "status": "complete",
    }
    # Filtering remounted the hidden keyed rows; compare with the final list.
    assert {row["title"]: row["row"] for row in rows(complete)} == {
        row["title"]: row["row"] for row in rows(final)
    }, "Plan streaming remounted keyed task rows"

    # Reveal the streamed rows in the native details scroll pane.
    def details_scroll(current):
        return next(
            item for item in current["layout"]["scrolls"] if item["node_id"] != list_id
        )

    viewport = details_scroll(complete)["viewport"]
    assert details_scroll(complete)["maximum"][1] > 0, (
        "The complete plan must overflow the native details pane"
    )
    x, y = geometry_tools.pointer_point(
        viewport, viewport, complete["layout"]["viewport"]
    )
    action(
        "mousemove",
        "--window",
        window,
        x,
        y,
        "click",
        "--repeat",
        "12",
        "--delay",
        "15",
        "5",
    )

    def plan_revealed(current):
        if not geometry_tools.at_scroll_end(details_scroll(current), 1):
            return False
        last = geometry(plan_rows(current)[-1]["node_id"], current)
        bounds = geometry_tools.rectangle(last["bounds"])
        return geometry_tools.intersects(bounds, last["ancestor_clip"]) == bounds

    revealed = wait_frame(plan_revealed, "native plan rows scrolled into view")
    assert plan_rows(revealed)[0]["node_id"] == first_step
    capture(window, "plan-complete.png")
    action(
        "mousemove",
        "--window",
        window,
        x,
        y,
        "click",
        "--repeat",
        "12",
        "--delay",
        "15",
        "4",
    )
    wait_frame(
        lambda current: details_scroll(current)["offset"] == [0, 0],
        "native details pane returns to the plan controls",
    )
    observations["planComplete"] = complete

    button("Draft a new plan")
    wait_for(
        lambda: plan(2) and plan(2)["status"] == "streaming" and plan(2)["steps"],
        "second plan streaming",
    )
    button("Stop plan")
    stopped = wait_for(
        lambda: plan(2) if plan(2) and plan(2)["status"] == "stopped" else None,
        "stopped plan",
    )
    count = len(stopped["steps"])
    assert 0 < count < len(PLAN_STEPS), f"Stop arrived after {count} steps"
    stopped_frame = wait_frame(
        lambda current: (
            len(plan_rows(current)) == count
            and has_text(current, progress("Plan stopped", count))
            and any(
                item["element"].get("text") == "Draft a new plan"
                for item in current["paint"]["nodes"]
            )
        ),
        "native stopped plan",
    )
    capture(window, "plan-stopped.png")
    observations["planStopped"] = stopped_frame

    button("Draft a new plan")
    wait_for(
        lambda: plan(3) and plan(3)["status"] == "streaming" and plan(3)["steps"],
        "third plan streaming",
    )
    button(INITIAL_TITLES[1])
    switched = wait_for(
        lambda: plan(3) if state()["selectedId"] == 2 else None,
        "selection change during a plan",
    )
    assert switched["status"] == "stopped" and switched["taskId"] == 1
    wait_frame(
        lambda current: (
            not plan_rows(current)
            and has_text(current, "Draft a local plan. Nothing is sent anywhere.")
        ),
        "plan-free details for another task",
    )
    input_value("Task title", INITIAL_TITLES[1])
    button(INITIAL_TITLES[0])
    wait_for(lambda: state()["selectedId"] == 1, "return to the planned task")
    wait_frame(
        lambda current: (
            len(plan_rows(current)) == len(switched["steps"])
            and has_text(current, progress("Plan stopped", len(switched["steps"])))
        ),
        "retained partial plan after switching back",
    )

    button("Draft a new plan")
    wait_frame(
        lambda current: (
            plan(4)
            and plan(4)["status"] == "streaming"
            and 0 < len(plan_rows(current)) < len(PLAN_STEPS)
        ),
        "plan streaming before window close",
    )
    observations["finalState"] = state()
    action("key", "--clearmodifiers", "alt+F4")
    return observations
