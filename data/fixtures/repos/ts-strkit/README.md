# strkit

Tiny string helpers. Zero dependencies, tests run on the built-in `node:test` runner.

```bash
npm test
```

## API

| Function | Description |
| --- | --- |
| `slugify(input)` | lower-case, dash-separated url slug |
| `truncate(text, max)` | shorten to at most `max` chars, `...` when cut |
| `splitLines(text)` | split into lines (LF / CRLF) |
| `wordCount(text)` | count whitespace-separated words |

## Fixture note

This repository is a **benchmark fixture** for bro2 (`data/fixtures/repos/`).
It is deliberately small, has no install step, and its visible test suite is green.
See `data/fixtures/repos/manifest.json` for the pinned content hash.
