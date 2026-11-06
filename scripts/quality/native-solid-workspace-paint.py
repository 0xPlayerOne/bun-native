"""Independent complete-tree oracle for the Solid workspace's native paint."""


def node(kind, children=(), *, style=None, **fields):
    return {
        "element": {"kind": kind, **fields, "style": style or {}},
        "children": list(children),
    }


def box(children, **style):
    return node("box", children, style=style)


def text(value, **style):
    return node("text", text=value, style=style)


def button(label, *, disabled=False, **style):
    return node("button", text=label, disabled=disabled, style=style)


def expected_tree(state):
    """Expect every element, style, child and label; node IDs remain host-owned."""
    colors = {
        "dark": (0x151B24, 0x222D3C, 0xEAF0F8, 0xB3C0D2, 0x344E74),
        "light": (0xF3F5F8, 0xFFFFFF, 0x182230, 0x526174, 0xDCE9FF),
    }
    background, panel, foreground, muted, accent = colors[state["theme"]]
    conversations = state["conversations"]
    conversation = next(
        row for row in conversations if row["id"] == state["selectedId"]
    )
    messages = conversation["messages"]
    streaming = any(message["status"] == "streaming" for message in messages)
    prompt_length = len(conversation["draft"].strip())
    can_send = not streaming and 0 < prompt_length <= 240 and len(messages) <= 22
    plain = {"color": foreground, "background": panel}
    header = box(
        [
            text(
                "Adea inspired workspace", color=foreground, font_size=26, flex_grow=1
            ),
            button(
                "Use light theme" if state["theme"] == "dark" else "Use dark theme",
                width=148,
                height=38,
                **plain,
            ),
            button(
                "Hide details" if state["details"] else "Show details",
                width=120,
                height=38,
                **plain,
            ),
        ],
        direction="row",
        align_items="center",
        gap=12,
        height=44,
        flex_shrink=0,
    )
    sidebar = box(
        [
            text(
                "Conversations",
                color=foreground,
                font_size=18,
                height=28,
                flex_shrink=0,
            ),
            button(
                "New conversation",
                disabled=len(conversations) >= 12,
                height=38,
                flex_shrink=0,
                color=foreground,
                background=accent,
            ),
            box(
                [
                    button(
                        row["title"],
                        height=44,
                        flex_shrink=0,
                        color=foreground,
                        background=accent
                        if row["id"] == state["selectedId"]
                        else panel,
                    )
                    for row in conversations
                ],
                direction="column",
                gap=8,
                height=0,
                flex_grow=1,
                min_height=0,
                overflow="scroll_y",
            ),
            text(
                f"{len(conversations)} / 12 conversations",
                color=muted,
                font_size=12,
                height=20,
                flex_shrink=0,
            ),
        ],
        direction="column",
        width=188,
        flex_shrink=0,
        gap=10,
    )
    toolbar = box(
        [
            text(conversation["title"], color=foreground, font_size=22, flex_grow=1),
            button("Clear history", width=112, height=36, **plain),
            button(
                "Close conversation",
                disabled=len(conversations) == 1,
                width=156,
                height=36,
                **plain,
            ),
        ],
        direction="row",
        align_items="center",
        gap=8,
        height=40,
        flex_shrink=0,
    )
    confirmation = (
        box(
            [
                text("Clear this conversation's history?", color=foreground),
                text(
                    "In-app confirmation · This also cancels an unfinished reply.",
                    color=muted,
                ),
                box(
                    [
                        button("Confirm clear", width=140, **plain),
                        button("Keep history", width=140, **plain),
                    ],
                    direction="row",
                    gap=8,
                    height=36,
                ),
            ],
            direction="column",
            gap=8,
            padding=12,
            background=accent,
            flex_shrink=0,
        )
        if state["clearConfirmation"] == conversation["id"]
        else text("")
    )
    rows = [
        box(
            [
                text(
                    f"{'You' if message['role'] == 'user' else 'Local assistant'} · {message['id']}",
                    color=muted,
                    font_size=13,
                ),
                text(
                    message["body"] or "Waiting for local text…",
                    color=foreground,
                    width="fill",
                ),
                text(
                    {
                        "streaming": "Streaming locally",
                        "cancelled": "Cancelled",
                        "complete": "Complete",
                    }[message["status"]],
                    color=muted,
                    font_size=12,
                ),
            ],
            direction="column",
            gap=6,
            padding=12,
            min_height=92,
            flex_shrink=0,
            background=background,
        )
        for message in messages
    ]
    # Solid's universal runtime keeps an empty native text marker for each
    # empty adjacent dynamic region. These nodes are part of the full oracle.
    history = box(
        [
            text("")
            if messages
            else text("No messages yet. Write a prompt below.", color=muted),
            *(rows or [text("")]),
        ],
        direction="column",
        gap=10,
        padding=12,
        height=0,
        flex_grow=1,
        min_height=0,
        overflow="scroll_y",
        background=panel,
    )
    composer = box(
        [
            text(
                "Local reply in progress"
                if streaming
                else "Local simulation · No backend connected",
                color=muted,
            ),
            node(
                "input",
                value=conversation["draft"],
                placeholder="Write a local prompt",
                style={"height": 42, "width": "fill", **plain},
            ),
            box(
                [
                    button(
                        "Send prompt",
                        disabled=not can_send,
                        width=140,
                        color=foreground if can_send else muted,
                        background=accent,
                    ),
                    button(
                        "Cancel reply",
                        disabled=not streaming,
                        width=140,
                        color=foreground if streaming else muted,
                        background=panel,
                    ),
                ],
                direction="row",
                gap=8,
                height=38,
            ),
            text(
                "History limit reached. Clear history to continue."
                if len(messages) >= 24
                else "Enter sends · Up to 240 characters · 24 messages per conversation",
                color=muted,
                font_size=12,
            ),
        ],
        direction="column",
        gap=8,
        flex_shrink=0,
    )
    conversation_pane = box(
        [toolbar, confirmation, history, composer],
        direction="column",
        width=0,
        flex_grow=1,
        min_width=260,
        gap=12,
    )
    details = (
        box(
            [
                text("Workspace details", color=foreground, font_size=18),
                text(
                    "Replies stream from a local deterministic source. Cancel or switch conversations to stop pending work.",
                    color=muted,
                ),
                text("Terminal / PTY", color=foreground, font_size=18),
                text(
                    "Unsupported in this reference app. No shell process is running.",
                    color=muted,
                ),
                text("Try the native UI", color=foreground, font_size=18),
                text(
                    "Click the composer to focus, press Enter to send, scroll history, resize the window, and hide this pane for more space.",
                    color=muted,
                ),
                text(
                    "The clear-history panel is an in-app confirmation, not an OS dialog.",
                    color=muted,
                ),
            ],
            direction="column",
            width=212,
            flex_shrink=0,
            padding=14,
            gap=12,
            overflow="scroll_y",
            background=panel,
        )
        if state["details"]
        else text("")
    )
    body = box(
        [sidebar, conversation_pane, details],
        direction="row",
        gap=12,
        height=0,
        flex_grow=1,
        min_height=0,
    )
    app = box(
        [
            header,
            text(
                "Solid native reference · Local demo data · Changes last for this session",
                color=muted,
                height=24,
                flex_shrink=0,
            ),
            body,
        ],
        direction="column",
        width="fill",
        height="fill",
        padding=16,
        gap=12,
        background=background,
    )
    return box([box([app], width="fill", height="fill")])


def painted_tree(paint):
    if not isinstance(paint, dict):
        raise TypeError("Native workspace paint must be an object")
    if (
        paint.get("type") != "rendered"
        or paint.get("stage") != "native-paint"
        or paint.get("window_id") != 1
        or type(paint.get("window_id")) is not int
        or type(paint.get("tree_revision")) is not int
        or paint["tree_revision"] < 1
        or "status" in paint
    ):
        raise ValueError("Expected a complete native paint for this window")
    rows = paint.get("nodes")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 256:
        raise ValueError("Native workspace paint has invalid node count")
    nodes = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("element"), dict):
            raise TypeError("Native workspace paint has an invalid element")
        identity = row.get("node_id")
        if type(identity) is not int or identity < 1 or identity in nodes:
            raise ValueError("Native workspace paint has invalid node identities")
        if row.get("element", {}).get("kind") == "input" and (
            type(row.get("input_revision")) is not int or row["input_revision"] < 0
        ):
            raise ValueError("Native workspace input lacks a valid revision")
        nodes[identity] = row
    visited = set()

    def visit(identity):
        if type(identity) is not int or identity not in nodes or identity in visited:
            raise ValueError(
                "Native workspace paint has a missing, repeated or cyclic child"
            )
        visited.add(identity)
        row = nodes[identity]
        children = row.get("children")
        if not isinstance(children, list):
            raise TypeError("Native workspace paint has invalid children")
        return {
            "element": row["element"],
            "children": [visit(child) for child in children],
        }

    result = visit(1)
    if visited != set(nodes):
        raise ValueError("Native workspace paint contains disconnected nodes")
    return result


def matches(paint, state):
    try:
        return painted_tree(paint) == expected_tree(state)
    except (KeyError, StopIteration, TypeError, ValueError):
        return False


def frame(paint, geometry, state):
    """The producer publishes changed geometry before its correlated paint.

    Reuse deduplicated geometry, but wait while a newer layout lacks its paint.
    """
    if (
        not paint
        or not isinstance(geometry, dict)
        or not state
        or not matches(paint, state)
    ):
        return None
    if (
        geometry.get("type") != "layout"
        or geometry.get("stage") != "native-paint"
        or type(geometry.get("window_id")) is not int
        or geometry["window_id"] != 1
        or type(geometry.get("tree_revision")) is not int
        or not 1 <= geometry["tree_revision"] <= paint["tree_revision"]
    ):
        return None
    layout = geometry.get("layout", {})
    if not isinstance(layout, dict):
        return None
    rows = layout.get("nodes", [])
    if not isinstance(rows, list) or any(
        not isinstance(row, dict) or type(row.get("node_id")) is not int for row in rows
    ):
        return None
    if (
        layout.get("status") != "complete"
        or layout.get("scale_factor") != 1
        or len(rows) != layout.get("node_count")
        or len({row["node_id"] for row in rows}) != len(rows)
        or {row["node_id"] for row in rows}
        != {row["node_id"] for row in paint["nodes"]}
    ):
        return None
    return {"paint": paint, "layout": layout, "state": state}
