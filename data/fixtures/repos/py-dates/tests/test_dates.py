"""Visible test suite. Runs on the standard library only:

    python3 -m unittest discover -s tests -t .
"""

import unittest
from datetime import date

from dates import clamp_range, days_spanned, overlaps


class TestOverlaps(unittest.TestCase):
    def test_clearly_overlapping_ranges(self):
        self.assertTrue(overlaps(date(2024, 1, 1), date(2024, 1, 31),
                                 date(2024, 1, 15), date(2024, 2, 15)))

    def test_clearly_disjoint_ranges(self):
        self.assertFalse(overlaps(date(2024, 1, 1), date(2024, 1, 10),
                                  date(2024, 3, 1), date(2024, 3, 10)))


class TestDaysSpanned(unittest.TestCase):
    def test_full_month(self):
        self.assertEqual(days_spanned(date(2024, 1, 1), date(2024, 2, 1)), 31)

    def test_empty_range(self):
        self.assertEqual(days_spanned(date(2024, 1, 1), date(2024, 1, 1)), 0)


class TestClampRange(unittest.TestCase):
    def test_clips_both_ends(self):
        got = clamp_range(date(2024, 1, 1), date(2024, 12, 31),
                          date(2024, 6, 1), date(2024, 7, 1))
        self.assertEqual(got, (date(2024, 6, 1), date(2024, 7, 1)))

    def test_returns_none_when_fully_outside(self):
        self.assertIsNone(clamp_range(date(2023, 1, 1), date(2023, 2, 1),
                                      date(2024, 1, 1), date(2024, 2, 1)))


if __name__ == "__main__":
    unittest.main()
