/**
 * In-memory todo store.
 *
 * Contract:
 *  - ids are integers, strictly increasing, never reused;
 *  - `all()` returns copies, so callers cannot mutate internal state;
 *  - priority is 1 (high) .. 3 (low), default 2.
 */

export function createStore(initial = []) {
  let items = initial.map((x) => ({ ...x }));
  let nextId = items.reduce((max, x) => Math.max(max, x.id ?? 0), 0) + 1;

  return {
    add(title, priority = 2) {
      const item = { id: nextId++, title, priority, done: false };
      items.push(item);
      return { ...item };
    },
    all() {
      return items.map((x) => ({ ...x }));
    },
    get(id) {
      const found = items.find((x) => x.id === id);
      return found ? { ...found } : null;
    },
    toggle(id) {
      const found = items.find((x) => x.id === id);
      if (!found) return null;
      found.done = !found.done;
      return { ...found };
    },
    /** Replace internal state; used by load(). Keeps id allocation monotonic. */
    replace(next) {
      items = next.map((x) => ({ ...x }));
      nextId = items.reduce((max, x) => Math.max(max, x.id ?? 0), nextId - 1) + 1;
    },
    get nextId() {
      return nextId;
    },
  };
}
