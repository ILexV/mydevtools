import assert from "node:assert/strict";
import test from "node:test";
import { moveShortcut } from "../src/desktop/shortcuts.ts";

const positions = {
  a: { column: 0, row: 0 },
  b: { column: 0, row: 2 },
  c: { column: 2, row: 1 },
  d: { column: 2, row: 3 },
};

test("group drop preserves gaps and swaps displaced icons into vacated cells", () => {
  const next = moveShortcut(positions, Object.keys(positions), "a", { column: 2, row: 1 }, ["a", "b"]);
  assert.deepEqual(next, {
    a: { column: 2, row: 1 }, b: { column: 2, row: 3 },
    c: { column: 0, row: 0 }, d: { column: 0, row: 2 },
  });
  assert.deepEqual(positions.a, { column: 0, row: 0 });
  assert.deepEqual(positions.c, { column: 2, row: 1 });
});

test("overlapping group translation does not displace members of its own selection", () => {
  const source = { a: { column: 0, row: 0 }, b: { column: 0, row: 1 }, c: { column: 0, row: 2 } };
  assert.deepEqual(moveShortcut(source, ["a", "b", "c"], "a", { column: 0, row: 1 }, ["a", "b"]), {
    a: { column: 0, row: 1 }, b: { column: 0, row: 2 }, c: { column: 0, row: 0 },
  });
});

test("a hidden reserved cell rejects the entire group, not just its colliding member", () => {
  assert.equal(moveShortcut(positions, ["a", "b", "c"], "a", { column: 2, row: 1 }, ["a", "b"]), positions);
});

test("every member must fit coordinate bounds and belong to visible shortcuts", () => {
  const ids = Object.keys(positions);
  assert.equal(moveShortcut(positions, ids, "a", { column: 1, row: 255 }, ["a", "b"]), positions);
  assert.equal(moveShortcut(positions, ids, "b", { column: 0, row: 0 }, ["a", "b"]), positions);
  assert.equal(moveShortcut(positions, ["a"], "a", { column: 1, row: 1 }, ["a", "b"]), positions);
  assert.equal(moveShortcut(positions, ids, "a", { column: 1, row: 1 }, ["missing", "a"]), positions);
  assert.equal(moveShortcut(positions, ids, "a", { column: 1, row: 1 }, ["b"]), positions);
});

test("duplicate selection ids do not create extra occupants and a no-op retains identity", () => {
  const ids = Object.keys(positions);
  assert.deepEqual(
    moveShortcut(positions, ids, "a", { column: 3, row: 0 }, ["a", "a", "b"]),
    moveShortcut(positions, ids, "a", { column: 3, row: 0 }, ["a", "b"]),
  );
  assert.equal(moveShortcut(positions, ids, "a", positions.a, ["a", "b"]), positions);
});
