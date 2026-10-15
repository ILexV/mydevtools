import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cascadeBounds,
  clampBounds,
  dockBounds,
  resizeBounds,
  restoreUnderPointer,
  snapTarget,
  splitPair,
} from "../src/desktop/bounds.ts";
import { hasUserInput } from "../src/desktop/dirty.ts";
import { defaultPrefs, parseLayout, parsePrefs, serializeLayout, serializePrefs } from "../src/desktop/persistence.ts";
import { desktopReducer } from "../src/desktop/reducer.ts";
import { arrangeShortcuts, moveShortcut, packedPositions } from "../src/desktop/shortcuts.ts";
import { emptyDesk, type Bounds, type DeskWindow } from "../src/desktop/types.ts";
import { fittedSize, wallpaperTooSmall } from "../src/desktop/wallpaper.ts";

const desk = { width: 1440, height: 900 };
const box: Bounds = { x: 80, y: 60, width: 520, height: 360 };
const slugs = new Set(["hash-calculator", "base64-encoder"]);
const categories = new Set(["hashing", "encoding"]);

function tool(id: string, slug: string, overrides: Partial<DeskWindow> = {}): DeskWindow {
  return {
    id,
    kind: "tool",
    slug,
    instance: 1,
    bounds: box,
    mode: "normal",
    z: 1,
    ...overrides,
  };
}

test("clampBounds keeps a frame inside the stage and enforces a minimum size", () => {
  const clamped = clampBounds({ x: -40, y: 2000, width: 20, height: 20 }, desk);
  assert.equal(clamped.x, 0);
  assert.equal(clamped.width, 360);
  assert.equal(clamped.height, 240);
  assert.ok(clamped.y + clamped.height <= desk.height);
});

test("cascadeBounds opens to the right of the shortcut strip when the free area is wide", () => {
  const cascaded = cascadeBounds(0, desk, 220);
  assert.ok(cascaded.x >= 220);
  const centered = cascadeBounds(0, { width: 800, height: 700 }, 220);
  assert.ok(centered.x < 220);
});

test("restoreUnderPointer keeps the grab fraction of the title under the pointer", () => {
  const restored = restoreUnderPointer(box, 400, 80, 0.25, desk);
  assert.equal(restored.width, box.width);
  assert.equal(restored.x, 400 - box.width * 0.25);
  assert.equal(restored.y, 80 - 18);
});

test("resizeBounds moves only the dragged edge", () => {
  const east = resizeBounds(box, "e", 40, 0, desk);
  assert.equal(east.x, box.x);
  assert.equal(east.width, box.width + 40);
  const west = resizeBounds(box, "w", 30, 0, desk);
  assert.equal(west.x, box.x + 30);
  assert.equal(west.x + west.width, box.x + box.width);
});

test("snapTarget uses the stage edges and the top strip", () => {
  assert.equal(snapTarget(8, 40, desk), "left");
  assert.equal(snapTarget(1430, 40, desk), "right");
  assert.equal(snapTarget(400, 4, desk), "max");
  assert.equal(snapTarget(400, 80, desk), null);
});

test("splitPair gives the left window the requested share", () => {
  const even = splitPair(desk, "1:1");
  const wide = splitPair(desk, "2:1");
  assert.ok(Math.abs(even.left.width - even.right.width) <= 1);
  assert.ok(wide.left.width > wide.right.width);
  assert.ok(even.left.x + even.left.width < even.right.x);
});

test("opening the same tool activates the existing window", () => {
  const first = desktopReducer(emptyDesk, {
    type: "open-tool",
    id: "a",
    slug: "hash-calculator",
    instance: 1,
    bounds: box,
    fresh: false,
  });
  const again = desktopReducer(first, {
    type: "open-tool",
    id: "b",
    slug: "hash-calculator",
    instance: 2,
    bounds: box,
    fresh: false,
  });
  assert.equal(again.windows.length, 1);
  assert.equal(again.activeId, "a");
  const copy = desktopReducer(again, {
    type: "open-tool",
    id: "b",
    slug: "hash-calculator",
    instance: 2,
    bounds: box,
    fresh: true,
  });
  assert.equal(copy.windows.length, 2);
  assert.equal(copy.activeId, "b");
  assert.deepEqual(copy.windows.map((window) => window.z), [1, 2]);
});

test("a category folder stays single-instance and minimize remembers maximize", () => {
  const opened = desktopReducer(emptyDesk, { type: "open-folder", id: "f", category: "hashing", bounds: box });
  const again = desktopReducer(opened, { type: "open-folder", id: "f2", category: "hashing", bounds: box });
  assert.equal(again.windows.length, 1);
  const max = desktopReducer(again, { type: "maximize", id: "f" });
  const min = desktopReducer(max, { type: "minimize", id: "f" });
  assert.equal(min.windows[0].mode, "minimized");
  assert.equal(min.windows[0].modeBeforeMinimize, "maximized");
  const back = desktopReducer(min, { type: "activate", id: "f" });
  assert.equal(back.windows[0].mode, "maximized");
  assert.equal(back.concealed, false);
});

test("show desktop conceals frames and hydrate never restores that flag", () => {
  const opened = desktopReducer(emptyDesk, {
    type: "open-tool",
    id: "a",
    slug: "hash-calculator",
    instance: 1,
    bounds: box,
    fresh: false,
  });
  const hidden = desktopReducer(opened, { type: "conceal" });
  assert.equal(hidden.concealed, true);
  assert.equal(hidden.windows.length, 1);
  const hydrated = desktopReducer(emptyDesk, { type: "hydrate", state: { ...hidden, concealed: true } });
  assert.equal(hydrated.concealed, false);
  assert.equal(hydrated.windows.length, 1);
});

test("dock and tile leave other windows where they are", () => {
  let state = desktopReducer(emptyDesk, {
    type: "open-tool",
    id: "a",
    slug: "hash-calculator",
    instance: 1,
    bounds: box,
    fresh: false,
  });
  state = desktopReducer(state, {
    type: "open-tool",
    id: "b",
    slug: "base64-encoder",
    instance: 1,
    bounds: { ...box, x: 200 },
    fresh: false,
  });
  const tiled = desktopReducer(state, { type: "tile", id: "a", companionId: "b", ratio: "1:1", desk });
  const other = state.windows.find((window) => window.id === "b")!;
  const moved = tiled.windows.find((window) => window.id === "b")!;
  assert.notDeepEqual(moved.bounds, other.bounds);
  const untouched = desktopReducer(state, { type: "dock", id: "a", side: "left", desk });
  assert.deepEqual(untouched.windows.find((window) => window.id === "b")!.bounds, other.bounds);
  assert.deepEqual(untouched.windows.find((window) => window.id === "a")!.bounds, dockBounds(desk, "left"));
});

test("close drops the window and a repeated move is a no-op", () => {
  const opened = desktopReducer(emptyDesk, {
    type: "open-tool",
    id: "a",
    slug: "hash-calculator",
    instance: 1,
    bounds: box,
    fresh: false,
  });
  assert.equal(desktopReducer(opened, { type: "move", id: "a", bounds: box }), opened);
  const closed = desktopReducer(opened, { type: "close", id: "a" });
  assert.equal(closed.windows.length, 0);
  assert.equal(closed.activeId, null);
});

test("shortcut grid is column-major and a hidden cell stays reserved", () => {
  const layout = arrangeShortcuts(["a", "b", "c"], {}, 2, 2);
  assert.deepEqual(layout.positions.a, { column: 0, row: 0 });
  assert.deepEqual(layout.positions.b, { column: 0, row: 1 });
  assert.deepEqual(layout.positions.c, { column: 1, row: 0 });
  const reserved = arrangeShortcuts(
    ["visible"],
    { visible: { column: 0, row: 0 } },
    2,
    2,
    { hidden: { column: 0, row: 0 }, visible: { column: 0, row: 0 } },
  );
  assert.notDeepEqual(reserved.positions.visible, { column: 0, row: 0 });
  const blocked = moveShortcut(
    { visible: { column: 1, row: 0 }, hidden: { column: 0, row: 0 } },
    ["visible"],
    "visible",
    { column: 0, row: 0 },
  );
  assert.deepEqual(blocked.visible, { column: 1, row: 0 });
  const swapped = moveShortcut(
    { a: { column: 0, row: 0 }, b: { column: 0, row: 1 } },
    ["a", "b"],
    "a",
    { column: 0, row: 1 },
  );
  assert.deepEqual(swapped.a, { column: 0, row: 1 });
  assert.deepEqual(swapped.b, { column: 0, row: 0 });
  assert.deepEqual(packedPositions(["a", "b"], 1, 2).b, { column: 0, row: 1 });
});

test("preferences and layout drop unknown versions, slugs and duplicate ids", () => {
  assert.equal(parsePrefs("nope", slugs, categories), null);
  assert.equal(parsePrefs(JSON.stringify({ v: 2 }), slugs, categories), null);
  const prefs = parsePrefs(
    JSON.stringify({
      v: 1,
      shortcuts: ["tool:hash-calculator", "tool:missing", "cat:encoding", "cat:encoding"],
      positions: { "tool:missing": { column: 1, row: 1 }, "tool:hash-calculator": { column: 0, row: 2 } },
      pinned: ["tool:missing"],
      hasImage: true,
    }),
    slugs,
    categories,
  );
  assert.deepEqual(prefs?.shortcuts, ["tool:hash-calculator", "cat:encoding"]);
  assert.deepEqual(prefs?.positions["tool:hash-calculator"], { column: 0, row: 2 });
  assert.equal(prefs?.positions["tool:missing"], undefined);
  assert.deepEqual(prefs?.pinned, []);
  assert.equal(parsePrefs(JSON.stringify({ v: 1, shortcuts: [] }), slugs, categories)?.shortcuts.length, 0);
  assert.equal(parseLayout("{", slugs, categories), null);
  assert.equal(parseLayout(JSON.stringify({ v: 9, windows: [] }), slugs, categories), null);
  const layout = parseLayout(
    JSON.stringify({
      v: 1,
      activeId: "gone",
      windows: [
        tool("a", "hash-calculator"),
        tool("a", "base64-encoder"),
        tool("b", "missing"),
        { ...tool("c", "hash-calculator", { instance: 2 }), kind: "tool" },
      ],
    }),
    slugs,
    categories,
  );
  assert.deepEqual(layout?.windows.map((window) => window.id), ["a", "c"]);
  assert.equal(layout?.activeId, null);
  assert.equal(layout?.concealed, false);
  const saved = JSON.parse(serializeLayout({ windows: [tool("a", "hash-calculator")], activeId: "a", concealed: true }));
  assert.equal(saved.concealed, undefined);
  assert.equal(JSON.parse(serializePrefs(defaultPrefs(["encoding"]))).v, 1);
});

test("dirty input ignores blank text and counts a chosen file", () => {
  assert.equal(hasUserInput({ fileCount: 0, texts: ["  "], editors: [""] }), false);
  assert.equal(hasUserInput({ fileCount: 0, texts: ["a"], editors: [] }), true);
  assert.equal(hasUserInput({ fileCount: 1, texts: [], editors: [] }), true);
});

test("fitted wallpaper size caps the long side at 2560 and the short side at 1920", () => {
  assert.deepEqual(fittedSize(4000, 2000), { width: 2560, height: 1280 });
  assert.deepEqual(fittedSize(3000, 3000), { width: 1920, height: 1920 });
  assert.equal(wallpaperTooSmall(1599, 2000), true);
  assert.equal(wallpaperTooSmall(1600, 1600), false);
});
