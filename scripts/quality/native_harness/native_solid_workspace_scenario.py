"""Actual local-stream workspace actions in the existing owned X11 driver."""

from . import native_solid_workspace_paint as PAINT

# Short wheel bursts that reach a possibly still-growing history's end, and how
# long each waits for a frame there. Sixteen bursts are 48 notches, more than
# the former single 30; the last keeps the former 10 s wait.
BURSTS = 16
BURST_NOTCHES = "3"
BURST_SETTLE_SECONDS = 0.4

INITIAL_TITLES = [
    "Project brief",
    "Native interactions",
    "Release checklist",
    "Design review",
    "Accessibility notes",
    "Build notes",
    "Research queue",
    "Archive",
]


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
    observations = {}

    def latest(rows, kind):
        return next((row for row in reversed(rows) if row.get("type") == kind), None)

    def state():
        row = latest(application_records(), "workspace-state")
        return row["state"] if row else None

    def conversation(identity=None, snapshot=None):
        current = snapshot["state"] if snapshot is not None else state()
        identity = current["selectedId"] if identity is None else identity
        return next(row for row in current["conversations"] if row["id"] == identity)

    def frame():
        records = native_records()
        return PAINT.frame(
            latest(records, "rendered"), latest(records, "layout"), state()
        )

    def wait_frame(description, predicate=lambda _: True):
        def matches():
            current = frame()
            return current if current and predicate(current) else None

        return wait_for(matches, description)

    def element(kind, label, current=None):
        current = current or wait_frame("complete native workspace paint")
        field = "placeholder" if kind == "input" else "text"
        matches = [
            row
            for row in current["paint"]["nodes"]
            if row["element"]["kind"] == kind and row["element"].get(field) == label
        ]
        if len(matches) != 1:
            raise RuntimeError(f"Expected exactly one native {kind}: {label}")
        return matches[0]

    def geometry(identity, current):
        return next(
            row for row in current["layout"]["nodes"] if row["node_id"] == identity
        )

    def action(*arguments):
        require_owned()
        if driver.run(["xdotool", "getwindowfocus"]) != window:
            raise RuntimeError("Owned workspace window lost focus before input")
        driver.run(["xdotool", *arguments])

    def pointer(identity, current):
        fields = dict(
            line.split("=", 1)
            for line in driver.run(
                [
                    "xdotool",
                    "getwindowgeometry",
                    "--shell",
                    window,
                ]
            ).splitlines()
        )
        if current["layout"]["viewport"] != [
            int(fields["WIDTH"]),
            int(fields["HEIGHT"]),
        ]:
            raise RuntimeError("Native layout differs from the owned X11 client")
        target = geometry(identity, current)
        return geometry_tools.pointer_point(
            target["bounds"], target["ancestor_clip"], current["layout"]["viewport"]
        )

    def click(identity, current):
        x, y = pointer(identity, current)
        action("mousemove", "--window", window, x, y, "click", "1")

    def button(label):
        current = wait_frame(f"complete paint before {label}")
        target = element("button", label, current)
        if target["element"]["disabled"]:
            raise RuntimeError(f"Native action is disabled: {label}")
        click(target["node_id"], current)

    def edit(value):
        current = wait_frame("current composer paint")
        target = element("input", "Write a local prompt", current)
        click(target["node_id"], current)
        focused = wait_frame(
            "native composer focus",
            lambda row: row["layout"]["focused_node_id"] == target["node_id"],
        )
        observations.setdefault("focusedInputs", []).append(
            {
                "nodeId": target["node_id"],
                "treeRevision": focused["paint"]["tree_revision"],
            }
        )
        action("key", "--clearmodifiers", "ctrl+a")
        action("type", "--clearmodifiers", "--delay", "10", value)
        return wait_frame(
            "complete native typed prompt",
            lambda row: conversation(snapshot=row)["draft"] == value,
        )

    def submit(value):
        edit(value)
        action("key", "--clearmodifiers", "Return")
        return wait_frame(
            "native local-stream submission",
            lambda row: (
                # A frame from before the submission may show a new, empty
                # conversation.
                conversation(snapshot=row)["messages"]
                and conversation(snapshot=row)["messages"][-1]["status"] == "streaming"
                and conversation(snapshot=row)["draft"] == ""
            ),
        )

    def message_row(message_id, current):
        label = element("text", f"Local assistant · {message_id}", current)["node_id"]
        return next(
            row for row in current["paint"]["nodes"] if label in row["children"]
        )

    def reveal_message(message_id):
        current = wait_frame("native reply geometry")
        row_id = message_row(message_id, current)["node_id"]
        history = next(
            row["node_id"]
            for row in current["paint"]["nodes"]
            if row_id in row["children"]
        )

        def history_scroll(snapshot):
            return next(
                row
                for row in snapshot["layout"]["scrolls"]
                if row["node_id"] == history
            )

        def at_end():
            snapshot = frame()
            if snapshot and geometry_tools.at_scroll_end(history_scroll(snapshot), 1):
                return snapshot
            return None

        scroll_state = history_scroll(current)
        if scroll_state["maximum"][1] > 0:
            viewport = scroll_state["viewport"]
            x, y = geometry_tools.pointer_point(
                viewport, viewport, current["layout"]["viewport"]
            )
            # The revealed reply may still be streaming (a chunk every 250 ms),
            # so the history can grow after a burst lands at its end. On hosted
            # macOS one 30-notch burst took longer than the whole reply (about
            # 55 ms a notch) although the end came at its second notch (runs
            # 42787338710 and 42791130372). Short bursts, each followed by the
            # same strict end check, reach the end and follow its growth while
            # the reply still streams.
            for burst in range(BURSTS):
                action(
                    "mousemove",
                    "--window",
                    window,
                    x,
                    y,
                    "click",
                    "--repeat",
                    BURST_NOTCHES,
                    "--delay",
                    "10",
                    "5",
                )
                try:
                    current = wait_for(
                        at_end,
                        "latest native message scroll endpoint",
                        10 if burst == BURSTS - 1 else BURST_SETTLE_SECONDS,
                    )
                    break
                except RuntimeError as error:
                    if burst == BURSTS - 1 or not str(error).startswith("Timed out"):
                        raise
        bounds = geometry(row_id, current)
        if (
            geometry_tools.intersects(bounds["bounds"], bounds["ancestor_clip"])
            != bounds["bounds"]
        ):
            raise RuntimeError("The actual streaming message must be wholly visible")
        return current

    def record_frame(name):
        current = wait_frame(f"complete native {name} paint")
        observations[name] = current
        capture(window, f"{name}.png")
        return current

    initial = wait_frame("complete initial conversation workspace")
    assert [row["title"] for row in state()["conversations"]] == INITIAL_TITLES
    assert state()["selectedId"] == 1 and len(conversation()["messages"]) == 12
    first_label = element("text", "You · 1", initial)["node_id"]
    first_row = next(
        row["node_id"]
        for row in initial["paint"]["nodes"]
        if first_label in row["children"]
    )
    history_id = next(
        row["node_id"]
        for row in initial["paint"]["nodes"]
        if first_row in row["children"]
    )

    def scroll(current):
        return next(
            row for row in current["layout"]["scrolls"] if row["node_id"] == history_id
        )

    assert scroll(initial)["offset"] == [0, 0] and scroll(initial)["maximum"][1] > 0
    observations["initial"] = initial
    viewport = scroll(initial)["viewport"]
    x, y = geometry_tools.pointer_point(
        viewport, viewport, initial["layout"]["viewport"]
    )
    action(
        "mousemove",
        "--window",
        window,
        x,
        y,
        "click",
        "--repeat",
        "30",
        "--delay",
        "10",
        "5",
    )
    scrolled = wait_frame(
        "native history wheel endpoint",
        lambda row: geometry_tools.at_scroll_end(scroll(row), 1),
    )
    observations["scrolled"] = scrolled
    capture(window, "scrolled.png")
    button("Use light theme")
    light = wait_frame(
        "complete light-theme paint", lambda row: row["state"]["theme"] == "light"
    )
    assert scroll(light)["offset"] == scroll(scrolled)["offset"], (
        "Changing theme reset native history scroll"
    )
    assert [row["node_id"] for row in light["paint"]["nodes"]] == [
        row["node_id"] for row in scrolled["paint"]["nodes"]
    ], "Changing theme remounted the native tree"
    observations["light"] = light
    capture(window, "light.png")
    button("Hide details")
    expanded = wait_frame(
        "expanded native conversation pane", lambda row: not row["state"]["details"]
    )
    assert (
        geometry(history_id, expanded)["bounds"][2]
        > geometry(history_id, light)["bounds"][2] + 200
    )
    action("windowsize", "--sync", window, "960", "720")
    resized = wait_frame(
        "actual native resize", lambda row: row["layout"]["viewport"] == [960, 720]
    )
    assert (
        abs(
            geometry(history_id, resized)["bounds"][2]
            - geometry(history_id, expanded)["bounds"][2]
            + 160
        )
        <= 1
    )
    assert scroll(resized)["maximum"][1] >= scroll(expanded)["maximum"][1]
    observations["resized"] = resized
    capture(window, "resized.png")

    button("New conversation")
    wait_frame(
        "empty new conversation",
        lambda row: (
            row["state"]["selectedId"] == 9
            and conversation(snapshot=row)["messages"] == []
        ),
    )
    submit("Cancel this reply")
    wait_frame(
        "partial native local reply",
        lambda row: (
            bool(conversation(snapshot=row)["messages"][-1]["body"])
            and conversation(snapshot=row)["messages"][-1]["status"] == "streaming"
        ),
    )
    button("Cancel reply")
    wait_frame(
        "native cancelled reply",
        lambda row: conversation(snapshot=row)["messages"][-1]["status"] == "cancelled",
    )
    cancelled = conversation()["messages"][-1]
    assert (
        cancelled["id"] == 28
        and cancelled["body"].startswith("Local reply: ")
        and not cancelled["body"].endswith("was contacted.")
    )
    record_frame("cancelled")
    submit("Switch this reply")
    button("Native interactions")
    wait_frame(
        "conversation switch during streaming",
        lambda row: row["state"]["selectedId"] == 2,
    )
    switched_history = conversation(9)["messages"]
    assert (
        switched_history[-1]["id"] == 30
        and switched_history[-1]["status"] == "cancelled"
    )
    submit("Finish this reply")
    reveal_message(32)
    partial = wait_frame(
        "native streaming paint in the second conversation",
        lambda row: (
            conversation(snapshot=row)["messages"][-1]["body"].startswith(
                "Local reply: "
            )
            and conversation(snapshot=row)["messages"][-1]["status"] == "streaming"
        ),
    )
    active_row = message_row(32, partial)
    visible = geometry(active_row["node_id"], partial)
    assert (
        geometry_tools.intersects(visible["bounds"], visible["ancestor_clip"])
        == visible["bounds"]
    ), "The partial native reply must be wholly visible"
    capture(window, "streaming.png")
    expected_reply = "Local reply: “Finish this reply”. This text arrives in eight bounded updates. No backend was contacted."
    wait_frame(
        "complete deterministic local reply",
        lambda row: (
            conversation(snapshot=row)["messages"][-1]["body"] == expected_reply
            and conversation(snapshot=row)["messages"][-1]["status"] == "complete"
        ),
    )
    complete = reveal_message(32)
    assert message_row(32, complete)["node_id"] == active_row["node_id"], (
        "Streaming replaced its keyed native message row"
    )
    assert conversation(9)["messages"] == switched_history, (
        "A stale reply mutated the inactive conversation"
    )
    observations["streamedMessage"] = {
        "rowId": active_row["node_id"],
        "partial": partial,
        "complete": complete,
        "inactiveHistory": switched_history,
    }
    capture(window, "complete.png")

    button("Show details")
    wait_frame("restored details pane", lambda row: row["state"]["details"])
    button("Clear history")
    wait_frame(
        "in-app clear confirmation", lambda row: row["state"]["clearConfirmation"] == 2
    )
    record_frame("confirmation")
    button("Keep history")
    wait_frame(
        "dismissed confirmation", lambda row: row["state"]["clearConfirmation"] is None
    )
    assert len(conversation()["messages"]) == 4
    button("Clear history")
    wait_frame(
        "second in-app clear confirmation",
        lambda row: row["state"]["clearConfirmation"] == 2,
    )
    button("Confirm clear")
    wait_frame(
        "actually cleared native history",
        lambda row: (
            conversation(snapshot=row)["messages"] == []
            and row["state"]["clearConfirmation"] is None
        ),
    )
    button("Close conversation")
    wait_frame(
        "closed conversation and valid remaining selection",
        lambda row: (
            row["state"]["selectedId"] == 1 and len(row["state"]["conversations"]) == 8
        ),
    )
    assert all(row["id"] != 2 for row in state()["conversations"])
    button("Conversation 9")
    wait_frame(
        "restored cancelled conversation", lambda row: row["state"]["selectedId"] == 9
    )
    assert conversation()["messages"] == switched_history
    button("Use dark theme")
    dark = wait_frame(
        "complete restored dark-theme paint",
        lambda row: row["state"]["theme"] == "dark",
    )

    def dark_pixels():
        require_owned()
        capture(window, "dark.png")
        target = element("input", "Write a local prompt", dark)
        bounds = geometry(target["node_id"], dark)
        rectangle = geometry_tools.rectangle(bounds["bounds"])
        if geometry_tools.intersects(rectangle, bounds["ancestor_clip"]) != rectangle:
            raise RuntimeError(
                "Composer pixel observation requires the full visible input"
            )
        geometry_tools.pointer_point(
            rectangle, bounds["ancestor_clip"], dark["layout"]["viewport"]
        )
        x, y, width, height = (round(value) for value in rectangle)
        sample = driver.run(
            [
                "convert",
                str(output / "dark.png"),
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
        if [int(sample[0]), int(sample[1])] != dark["layout"]["viewport"]:
            raise RuntimeError("Captured pixels differ from the native viewport")
        foreground = float(
            driver.run(
                [
                    "convert",
                    str(output / "dark.png"),
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
        observations["darkComposerPixels"] = {
            "background": sample[2],
            "expectedBackground": "222D3C",
            "visibleForegroundFraction": foreground,
        }
        return sample[2] == "222D3C" and foreground > 0

    wait_for(dark_pixels, "readable actual dark composer pixels")
    submit("Close this reply")
    final = record_frame("before-close")
    assert (
        conversation()["messages"][-1]["id"] == 34
        and conversation()["messages"][-1]["status"] == "streaming"
    )
    observations["finalStateBeforeClose"] = final["state"]
    observations["final"] = final
    action("key", "--clearmodifiers", "alt+F4")
    return observations
