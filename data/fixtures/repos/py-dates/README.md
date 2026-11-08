# dates

Tiny date-range helpers. Standard library only.

```bash
python3 -m unittest discover -s tests -t .
```

## API

All ranges are **half-open**: `[start, end)`.

| Function | Description |
| --- | --- |
| `overlaps(a_start, a_end, b_start, b_end)` | do two ranges share a day? |
| `days_spanned(start, end)` | days covered by `[start, end)` |
| `clamp_range(start, end, low, high)` | clip to bounds, `None` when empty |

## Fixture note

Benchmark fixture for bro2 (`data/fixtures/repos/`). No install step, visible tests green.
See `data/fixtures/repos/manifest.json` for the pinned content hash.
