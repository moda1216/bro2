"""Small date-range helpers.

All ranges are **half-open**: ``[start, end)``. A range that ends exactly where
another begins therefore does *not* overlap it.
"""

from datetime import date


def overlaps(a_start: date, a_end: date, b_start: date, b_end: date) -> bool:
    """Return True when the two half-open ranges share at least one day."""
    return a_start <= b_end and b_start <= a_end


def days_spanned(start: date, end: date) -> int:
    """Number of days covered by a half-open range ``[start, end)``."""
    return (end - start).days


def clamp_range(start: date, end: date, low: date, high: date):
    """Clip a half-open range to ``[low, high)``; returns None when empty."""
    s = max(start, low)
    e = min(end, high)
    if s >= e:
        return None
    return (s, e)
