//! The platform-free conversion between Cocoa screen points (origin at the
//! bottom left, `y` up) and the popup placement space: device pixels from the
//! top-left corner of the parent window's screen, `y` down. Compiled on every
//! platform for its tests.

use gpui::{Bounds, Point, Size};

/// A rectangle in Cocoa screen points; `y` is the bottom edge.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Rect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

/// The screen a placement pass works on, and the scale it uses.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Screen {
    pub(crate) frame: Rect,
    pub(crate) scale: f64,
}

fn device(value: f64, scale: f64) -> i32 {
    (value * scale).round() as i32
}

impl Screen {
    /// The screen's size in device pixels.
    pub(crate) fn size(&self) -> Size<i32> {
        Size {
            width: device(self.frame.width, self.scale),
            height: device(self.frame.height, self.scale),
        }
    }

    /// The top-left corner of a window's content, in placement space.
    pub(crate) fn origin(&self, content: Rect) -> Point<i32> {
        Point {
            x: device(content.x - self.frame.x, self.scale),
            y: device(
                self.frame.y + self.frame.height - (content.y + content.height),
                self.scale,
            ),
        }
    }

    /// The Cocoa frame of placement-space bounds.
    pub(crate) fn frame(&self, bounds: Bounds<i32>) -> Rect {
        let points = |value: i32| f64::from(value) / self.scale;
        let height = points(bounds.size.height);
        Rect {
            x: self.frame.x + points(bounds.origin.x),
            y: self.frame.y + self.frame.height - points(bounds.origin.y) - height,
            width: points(bounds.size.width),
            height,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIMARY: Rect = Rect {
        x: 0.,
        y: 0.,
        width: 1440.,
        height: 900.,
    };

    fn bounds(x: i32, y: i32, width: i32, height: i32) -> Bounds<i32> {
        Bounds {
            origin: Point { x, y },
            size: Size { width, height },
        }
    }

    #[test]
    fn content_origins_count_down_from_the_screen_top() {
        let screen = Screen {
            frame: PRIMARY,
            scale: 1.,
        };
        let content = Rect {
            x: 100.,
            y: 500.,
            width: 360.,
            height: 200.,
        };
        assert_eq!(screen.origin(content), Point { x: 100, y: 200 });
        assert_eq!(
            screen.size(),
            Size {
                width: 1440,
                height: 900
            }
        );
    }

    #[test]
    fn frames_round_trip_at_any_scale_and_screen_offset() {
        for (frame, scale) in [
            (PRIMARY, 1.),
            (PRIMARY, 2.),
            (
                Rect {
                    x: 1440.,
                    y: -200.,
                    width: 1920.,
                    height: 1080.,
                },
                2.,
            ),
        ] {
            let screen = Screen { frame, scale };
            let placed = bounds(40, 60, 440, 320);
            let cocoa = screen.frame(placed);
            assert_eq!(cocoa.width * scale, 440.);
            assert_eq!(cocoa.height * scale, 320.);
            assert_eq!(screen.origin(cocoa), placed.origin);
        }
    }

    #[test]
    fn a_popup_below_its_anchor_has_a_lower_cocoa_origin() {
        let screen = Screen {
            frame: PRIMARY,
            scale: 1.,
        };
        let anchor = screen.frame(bounds(100, 300, 120, 30));
        let popup = screen.frame(bounds(100, 330, 220, 160));
        assert_eq!(popup.y + popup.height, anchor.y);
        assert_eq!(popup.y, 900. - 330. - 160.);
    }
}
