import { test } from "node:test";
import assert from "node:assert/strict";
import { subtotal, total, unitCount } from "../src/cart.js";

const apples = { price: 10, qty: 3 };
const bread = { price: 5, qty: 2 };

test("subtotal: sums price times quantity", () => {
  assert.equal(subtotal([apples, bread]), 40);
});

test("total: applies a percentage discount", () => {
  assert.equal(total([apples, bread], 0.1), 36);
});

test("total: no discount returns the subtotal", () => {
  assert.equal(total([apples], 0), 30);
});

test("unitCount: counts physical units", () => {
  assert.equal(unitCount([apples, bread]), 5);
});
