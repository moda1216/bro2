# todo

A tiny todo library used as a fixture repo for bro2 bench v2 (L3).

## Layout

| Path | Role |
| --- | --- |
| `src/store.js` | in-memory store: `add`, `all`, `get`, `toggle`, `replace` |
| `src/query.js` | `list`, `sortBy`, `stats` |
| `src/persist.js` | JSON `save` / `load` (not implemented yet) |
| `test/store.test.js` | visible test suite |

## Contracts

- ids are integers, strictly increasing, never reused — including after `load()`;
- `all()` returns copies; callers must not be able to mutate internal state;
- `priority` is `1` (high) .. `3` (low), default `2`;
- the on-disk format is `{ "version": 1, "items": [...] }`; loading a missing file is a fresh start, not an error.

## Roadmap

1. `list(items, { done })` — filter by state; `done` omitted means "all";
2. `sortBy(items)` — order by `priority` ascending, stable for equal priorities;
3. `save(store, path)` / `load(path)` — persist and restore.

Run the suite with `npm test`.
