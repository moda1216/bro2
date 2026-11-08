/** Query helpers. Filtering and ordering land here. */

/**
 * List todos.
 * Current behaviour: returns everything, ignoring options.
 */
export function list(items, options = {}) {
  void options;
  return items;
}

/**
 * Order todos.
 * Current behaviour: returns input order.
 */
export function sortBy(items) {
  return items;
}

/** Count todos by state. */
export function stats(items) {
  const done = items.filter((x) => x.done).length;
  return { total: items.length, done, open: items.length - done };
}
