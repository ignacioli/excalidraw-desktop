#![allow(
    dead_code,
    reason = "the multi-window user stories consume these items as their slices land"
)]

//! Window geometry rules, in logical pixels.
//!
//! - A window without remembered placement takes 90% of its display's work
//!   area, at most 1680×1050 and at least the 960×640 minimum, centered.
//! - A new window opened while another window is in front is offset by 28
//!   from it, falling back to the work area's top-left corner when the
//!   offset window would leave the work area.
//! - A remembered placement whose title bar is not grabbable on any display
//!   (intersection under 100×28) moves to the primary display, centered.

/// Smallest window content size. With the 280-pixel pinned sidebar the canvas
/// stays at least 680 wide.
pub const MIN_WIDTH: f64 = 960.0;
pub const MIN_HEIGHT: f64 = 640.0;
pub const MAX_INITIAL_WIDTH: f64 = 1680.0;
pub const MAX_INITIAL_HEIGHT: f64 = 1050.0;
pub const INITIAL_FRACTION: f64 = 0.9;
pub const STAGGER_OFFSET: f64 = 28.0;
/// Minimum visible area that keeps a title bar grabbable.
pub const GRABBABLE_WIDTH: f64 = 100.0;
pub const GRABBABLE_HEIGHT: f64 = 28.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl LogicalRect {
    pub fn right(&self) -> f64 {
        self.x + self.width
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.height
    }

    fn intersection_size(&self, other: &LogicalRect) -> (f64, f64) {
        let width = self.right().min(other.right()) - self.x.max(other.x);
        let height = self.bottom().min(other.bottom()) - self.y.max(other.y);
        (width.max(0.0), height.max(0.0))
    }

    fn centered_in(width: f64, height: f64, area: &LogicalRect) -> LogicalRect {
        LogicalRect {
            x: area.x + (area.width - width) / 2.0,
            y: area.y + (area.height - height) / 2.0,
            width,
            height,
        }
    }
}

/// Convert a monitor work area reported in physical pixels to logical pixels.
pub fn logical_work_area(
    physical_x: i32,
    physical_y: i32,
    physical_width: u32,
    physical_height: u32,
    scale_factor: f64,
) -> LogicalRect {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    LogicalRect {
        x: f64::from(physical_x) / scale,
        y: f64::from(physical_y) / scale,
        width: f64::from(physical_width) / scale,
        height: f64::from(physical_height) / scale,
    }
}

/// Size of a window without remembered placement on `work_area`.
pub fn initial_size(work_area: &LogicalRect) -> (f64, f64) {
    let width = (work_area.width * INITIAL_FRACTION)
        .floor()
        .clamp(MIN_WIDTH, MAX_INITIAL_WIDTH);
    let height = (work_area.height * INITIAL_FRACTION)
        .floor()
        .clamp(MIN_HEIGHT, MAX_INITIAL_HEIGHT);
    (width, height)
}

/// First window, or any window with no window in front: centered.
pub fn initial_rect(work_area: &LogicalRect) -> LogicalRect {
    let (width, height) = initial_size(work_area);
    LogicalRect::centered_in(width, height, work_area)
}

/// A new window opened while `front` is the front window on `work_area`.
pub fn staggered_rect(front: &LogicalRect, work_area: &LogicalRect) -> LogicalRect {
    let (width, height) = initial_size(work_area);
    let offset = LogicalRect {
        x: front.x + STAGGER_OFFSET,
        y: front.y + STAGGER_OFFSET,
        width,
        height,
    };
    if offset.right() > work_area.right() || offset.bottom() > work_area.bottom() {
        LogicalRect {
            x: work_area.x,
            y: work_area.y,
            width,
            height,
        }
    } else {
        offset
    }
}

/// Whether some display shows enough of `rect` to grab its title bar.
pub fn is_grabbable(rect: &LogicalRect, work_areas: &[LogicalRect]) -> bool {
    work_areas.iter().any(|area| {
        let (width, height) = rect.intersection_size(area);
        width >= GRABBABLE_WIDTH && height >= GRABBABLE_HEIGHT
    })
}

/// Where to place a window with remembered normal-state bounds. The size
/// never drops below the minimum; an unreachable window moves to the primary
/// display, centered, and shrinks to fit it when it is larger.
pub fn restored_rect(
    remembered: &LogicalRect,
    work_areas: &[LogicalRect],
    primary: &LogicalRect,
) -> LogicalRect {
    let sized = LogicalRect {
        width: remembered.width.max(MIN_WIDTH),
        height: remembered.height.max(MIN_HEIGHT),
        ..*remembered
    };
    if is_grabbable(&sized, work_areas) {
        return sized;
    }
    let width = sized.width.min(primary.width).max(MIN_WIDTH);
    let height = sized.height.min(primary.height).max(MIN_HEIGHT);
    LogicalRect::centered_in(width, height, primary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(x: f64, y: f64, width: f64, height: f64) -> LogicalRect {
        LogicalRect {
            x,
            y,
            width,
            height,
        }
    }

    fn assert_inside(rect: &LogicalRect, work_area: &LogicalRect) {
        assert!(
            rect.x >= work_area.x
                && rect.y >= work_area.y
                && rect.right() <= work_area.right()
                && rect.bottom() <= work_area.bottom(),
            "{rect:?} is not inside {work_area:?}"
        );
    }

    #[test]
    fn initial_window_takes_ninety_percent_of_common_work_areas() {
        // Logical work areas below the menu bar (25 points on macOS).
        let cases = [
            (area(0.0, 25.0, 1440.0, 875.0), (1296.0, 787.0)),
            (area(0.0, 25.0, 1280.0, 775.0), (1152.0, 697.0)),
            (area(0.0, 25.0, 2560.0, 1415.0), (1680.0, 1050.0)),
        ];
        for (work_area, expected) in cases {
            let rect = initial_rect(&work_area);
            assert_eq!((rect.width, rect.height), expected, "{work_area:?}");
            assert_inside(&rect, &work_area);
        }
    }

    #[test]
    fn a_full_1440_by_900_work_area_meets_the_size_target() {
        let rect = initial_rect(&area(0.0, 0.0, 1440.0, 900.0));
        assert_eq!((rect.width, rect.height), (1296.0, 810.0));
        assert!(rect.width >= 1280.0 && rect.height >= 760.0);
        assert_eq!((rect.x, rect.y), (72.0, 45.0));
    }

    #[test]
    fn physical_work_areas_convert_by_scale_factor() {
        // A 2880×1800 Retina panel at 2× and a 3840×2160 panel at 1.5×.
        let retina = logical_work_area(0, 50, 2880, 1750, 2.0);
        assert_eq!(retina, area(0.0, 25.0, 1440.0, 875.0));
        assert_eq!(initial_size(&retina), (1296.0, 787.0));

        let scaled = logical_work_area(3840, 0, 3840, 2160, 1.5);
        assert_eq!(scaled, area(2560.0, 0.0, 2560.0, 1440.0));
        let rect = initial_rect(&scaled);
        assert_eq!((rect.width, rect.height), (1680.0, 1050.0));
        assert_inside(&rect, &scaled);

        assert_eq!(
            logical_work_area(0, 0, 1280, 800, 0.0),
            area(0.0, 0.0, 1280.0, 800.0),
            "an invalid scale factor falls back to 1"
        );
    }

    #[test]
    fn small_work_areas_keep_the_minimum_size() {
        let rect = initial_rect(&area(0.0, 0.0, 1000.0, 700.0));
        assert_eq!((rect.width, rect.height), (MIN_WIDTH, MIN_HEIGHT));
    }

    #[test]
    fn new_windows_stagger_from_the_front_window() {
        let work_area = area(0.0, 25.0, 1440.0, 875.0);
        let front = initial_rect(&work_area);
        let next = staggered_rect(&front, &work_area);
        assert_eq!((next.x, next.y), (front.x + 28.0, front.y + 28.0));
        assert_eq!((next.width, next.height), (front.width, front.height));
        assert_inside(&next, &work_area);
    }

    #[test]
    fn staggering_past_the_work_area_restarts_at_its_top_left_corner() {
        let work_area = area(0.0, 25.0, 1440.0, 875.0);
        let mut front = initial_rect(&work_area);
        for _ in 0..10 {
            front = staggered_rect(&front, &work_area);
            assert_inside(&front, &work_area);
        }
        let near_corner = area(140.0, 85.0, 1296.0, 787.0);
        assert_eq!(
            staggered_rect(&near_corner, &work_area),
            area(0.0, 25.0, 1296.0, 787.0)
        );
    }

    #[test]
    fn remembered_bounds_on_a_connected_display_are_kept() {
        let main = area(0.0, 25.0, 1440.0, 875.0);
        let external = area(1440.0, 0.0, 2560.0, 1440.0);
        let remembered = area(1600.0, 100.0, 1400.0, 900.0);
        assert_eq!(
            restored_rect(&remembered, &[main, external], &main),
            remembered
        );
    }

    #[test]
    fn remembered_bounds_on_a_disconnected_display_move_to_the_primary_display() {
        let main = area(0.0, 25.0, 1440.0, 875.0);
        let remembered = area(1600.0, 100.0, 1400.0, 900.0);
        let restored = restored_rect(&remembered, &[main], &main);
        assert_eq!((restored.width, restored.height), (1400.0, 875.0));
        assert_inside(&restored, &main);
    }

    #[test]
    fn a_barely_visible_title_bar_counts_as_unreachable() {
        let main = area(0.0, 25.0, 1440.0, 875.0);
        // Only 99 points wide on screen.
        let narrow = area(1341.0, 100.0, 1200.0, 800.0);
        assert!(!is_grabbable(&narrow, &[main]));
        let wide_enough = area(1340.0, 100.0, 1200.0, 800.0);
        assert!(is_grabbable(&wide_enough, &[main]));
        // Only 27 points tall on screen.
        let short = area(100.0, 873.0, 1200.0, 800.0);
        assert!(!is_grabbable(&short, &[main]));
        let restored = restored_rect(&narrow, &[main], &main);
        assert_inside(&restored, &main);
    }

    #[test]
    fn remembered_bounds_never_drop_below_the_minimum() {
        let main = area(0.0, 25.0, 1440.0, 875.0);
        let restored = restored_rect(&area(10.0, 40.0, 500.0, 300.0), &[main], &main);
        assert_eq!((restored.width, restored.height), (MIN_WIDTH, MIN_HEIGHT));
        assert_eq!((restored.x, restored.y), (10.0, 40.0));
    }

    // The minimum size keeps the canvas at least 680 wide beside the
    // 280-pixel pinned sidebar.
    const _: () = assert!(MIN_WIDTH - 280.0 >= 680.0);
}
