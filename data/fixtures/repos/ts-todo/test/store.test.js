import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { list, stats } from "../src/query.js";

test("add: allocates increasing ids", () => {
  const s = createStore();
  assert.equal(s.add("a").id, 1);
  assert.equal(s.add("b").id, 2);
});

test("all: returns copies, not internal objects", () => {
  const s = createStore();
  const added = s.add("a");
  added.title = "hacked";
  assert.equal(s.all()[0].title, "a");
});

test("toggle: flips done and reports missing ids", () => {
  const s = createStore();
  const item = s.add("a");
  assert.equal(s.toggle(item.id).done, true);
  assert.equal(s.toggle(999), null);
});

test("replace: keeps id allocation monotonic", () => {
  const s = createStore([{ id: 7, title: "old", priority: 2, done: false }]);
  assert.equal(s.add("new").id, 8);
});

// NOTE: this assertion describes the OLD behaviour (list ignores its options).
// It will need updating once filtering is implemented.
test("list: returns everything", () => {
  const s = createStore();
  s.add("a");
  s.add("b");
  assert.equal(list(s.all(), { done: true }).length, 2);
});

test("stats: counts open and done", () => {
  const s = createStore();
  s.add("a");
  s.add("b");
  s.toggle(1);
  assert.deepEqual(stats(s.all()), { total: 2, done: 1, open: 1 });
});
