"""Bounded diagnostic trigger for observed CEF teardown, never a runtime deadline.

Receipt times use the observer's monotonic clock, not a child-supplied timestamp.
The trigger selects when to inspect; it confers no process ownership or authority.
"""

import math
import threading


def finite_number(value):
    return type(value) in (int, float) and 0 <= value <= 1e15 and math.isfinite(value)


class ShutdownTrigger:
    def __init__(self, after):
        if not finite_number(after) or after > 5:
            raise ValueError("Shutdown capture offset must be finite and between 0 and 5 seconds")
        self.after = after
        self.start = None
        self.complete = None
        self.invalid = False
        self.lock = threading.Lock()

    def observe(self, event, received):
        if (
            not isinstance(event, dict)
            or event.get("event") != "bunly.host.shutdown-phase"
            or event.get("phase") != "cef-shutdown"
        ):
            return
        with self.lock:
            keys = {"event", "phase", "state"}
            valid = finite_number(received)
            if event.get("state") == "start":
                valid = (
                    valid and set(event) == keys and self.start is None and self.complete is None
                )
                if valid:
                    self.start = received
            elif event.get("state") == "complete":
                duration = event.get("durationMs")
                valid = (
                    valid
                    and set(event) == keys | {"durationMs"}
                    and self.start is not None
                    and self.complete is None
                    and received >= self.start
                    and type(duration) is int
                    and 0 <= duration <= 600000
                )
                if valid:
                    self.complete = received
            else:
                valid = False
            self.invalid |= not valid

    def due(self, now):
        with self.lock:
            return (
                not self.invalid
                and self.start is not None
                and self.complete is None
                and finite_number(now)
                and now >= self.start + self.after
            )

    def require_pending(self):
        with self.lock:
            if self.invalid or self.start is None or self.complete is not None:
                raise ValueError("shutdown-phase-no-longer-pending")
            return self.start

    def report(self, started):
        with self.lock:
            status = (
                "malformed-phase"
                if self.invalid
                else "phase-not-observed"
                if self.start is None
                else "phase-completed"
                if self.complete is not None
                else "phase-pending"
            )
            return {
                "kind": "cef-shutdown",
                "delayMs": self.after * 1000,
                "status": status,
                "startElapsedMs": None if self.start is None else (self.start - started) * 1000,
                "completeElapsedMs": None
                if self.complete is None
                else (self.complete - started) * 1000,
                "clock": "observer-monotonic-stderr-receipt-not-native-phase-start",
            }
