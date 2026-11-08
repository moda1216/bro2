/**
 * JSON persistence.
 *
 * File format: `{ "version": 1, "items": [...] }`.
 * `load(path)` must tolerate a missing file (fresh start) — a first run is not an error.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createStore } from "./store.js";

export function save(store, path) {
  void store;
  void path;
  void existsSync;
  void readFileSync;
  void writeFileSync;
  void createStore;
  throw new Error("save() is not implemented yet");
}

export function load(path) {
  void path;
  throw new Error("load() is not implemented yet");
}
