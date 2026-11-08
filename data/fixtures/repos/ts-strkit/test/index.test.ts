import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, splitLines, truncate, wordCount } from "../src/index.ts";

test("slugify: normalises spaces and punctuation", () => {
  assert.equal(slugify("  Hello, World!  "), "hello-world");
});

test("slugify: collapses repeated separators", () => {
  assert.equal(slugify("a -- b"), "a-b");
});

test("truncate: leaves short text untouched", () => {
  assert.equal(truncate("abc", 10), "abc");
});

test("truncate: cuts long text with an ellipsis", () => {
  assert.equal(truncate("abcdefghij", 8), "abcde...");
});

test("splitLines: splits LF text", () => {
  assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
});

test("wordCount: counts whitespace separated words", () => {
  assert.equal(wordCount("  one   two\tthree "), 3);
});
