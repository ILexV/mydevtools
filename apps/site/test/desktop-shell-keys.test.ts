import assert from "node:assert/strict";
import test from "node:test";
import { cycleWindow, isEditableTarget, isMacPlatform, shellCommand, type ShellKey } from "../src/desktop/shell-keys.ts";
import { parseFrameMessage, transferDelivery } from "../src/desktop/frame-bridge.ts";

const key = (patch: Partial<ShellKey>): ShellKey => ({
  key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...patch,
});

test("Ctrl/⌘+K opens the launcher even from a text field, on any layout", () => {
  assert.equal(shellCommand(key({ key: "k", code: "KeyK", ctrlKey: true }), true, false), "launcher");
  assert.equal(shellCommand(key({ key: "л", code: "KeyK", metaKey: true }), false, true), "launcher");
  assert.equal(shellCommand(key({ key: "k", code: "KeyK", ctrlKey: true, altKey: true }), false, false), null);
  assert.equal(shellCommand(key({ key: "k", code: "KeyK", ctrlKey: true, isComposing: true }), false, false), null);
});

test("window switching uses Alt+` off macOS and Ctrl+` on macOS", () => {
  assert.equal(shellCommand(key({ key: "`", code: "Backquote", altKey: true }), true, false), "next-window");
  assert.equal(shellCommand(key({ key: "~", code: "Backquote", altKey: true, shiftKey: true }), false, false), "previous-window");
  assert.equal(shellCommand(key({ key: "Dead", code: "Backquote", altKey: true }), true, true), null);
  assert.equal(shellCommand(key({ key: "`", code: "Backquote", ctrlKey: true }), true, true), "next-window");
});

test("Alt+Shift window keys never fire inside a text field", () => {
  assert.equal(shellCommand(key({ key: "ArrowLeft", code: "ArrowLeft", altKey: true, shiftKey: true }), false, false), "dock-left");
  assert.equal(shellCommand(key({ key: "ArrowRight", code: "ArrowRight", altKey: true, shiftKey: true }), false, false), "dock-right");
  assert.equal(shellCommand(key({ key: "ArrowUp", code: "ArrowUp", altKey: true, shiftKey: true }), false, false), "maximize");
  assert.equal(shellCommand(key({ key: "ArrowDown", code: "ArrowDown", altKey: true, shiftKey: true }), false, false), "minimize");
  assert.equal(shellCommand(key({ key: "W", code: "KeyW", altKey: true, shiftKey: true }), false, false), "close-window");
  assert.equal(shellCommand(key({ key: "ArrowLeft", code: "ArrowLeft", altKey: true, shiftKey: true }), true, true), null);
  assert.equal(shellCommand(key({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }), false, false), null);
});

test("editable targets are detected by duck typing across iframe realms", () => {
  assert.equal(isEditableTarget({ closest: () => ({}) } as unknown as EventTarget), true);
  assert.equal(isEditableTarget({ closest: () => null } as unknown as EventTarget), false);
  assert.equal(isEditableTarget(null), false);
});

test("window cycling wraps in taskbar order", () => {
  assert.equal(cycleWindow(["a", "b", "c"], "c", 1), "a");
  assert.equal(cycleWindow(["a", "b", "c"], "a", -1), "c");
  assert.equal(cycleWindow(["a", "b"], null, 1), "a");
  assert.equal(cycleWindow(["a", "b"], "gone", -1), "b");
  assert.equal(cycleWindow([], "a", 1), null);
  assert.equal(isMacPlatform("MacIntel"), true);
  assert.equal(isMacPlatform("Linux x86_64"), false);
});

const isTool = (slug: string) => slug === "json-formatter" || slug === "base64";

test("frame messages are accepted only for the sending tool", () => {
  assert.deepEqual(parseFrameMessage({ type: "mdt:transfer-ready", slug: "base64" }, "base64", isTool), { type: "mdt:transfer-ready" });
  assert.equal(parseFrameMessage({ type: "mdt:transfer-ready", slug: "json-formatter" }, "base64", isTool), null);
  assert.equal(parseFrameMessage(null, "base64", isTool), null);
  assert.equal(parseFrameMessage({ type: "mdt:unknown", slug: "base64" }, "base64", isTool), null);
});

test("tool activity is sanitized", () => {
  assert.deepEqual(
    parseFrameMessage({ type: "mdt:tool-activity", slug: "base64", active: true, value: Number.NaN, label: "x".repeat(300) }, "base64", isTool),
    { type: "mdt:tool-activity", active: true, value: null, label: "x".repeat(160) },
  );
  assert.deepEqual(parseFrameMessage({ type: "mdt:tool-activity", slug: "base64", active: "yes" }, "base64", isTool), {
    type: "mdt:tool-activity",
    active: false,
  });
});

test("transfer requests need a known target and an allowed media type", () => {
  const request = { type: "mdt:transfer-request", sourceSlug: "base64", requestId: "r1", targetSlug: "json-formatter", mediaType: "application/json", payload: "{}" };
  const parsed = parseFrameMessage(request, "base64", isTool);
  assert.ok(parsed && parsed.type === "mdt:transfer-request");
  assert.deepEqual(transferDelivery(parsed), {
    type: "mdt:transfer-deliver", requestId: "r1", targetSlug: "json-formatter", mediaType: "application/json", payload: "{}",
  });
  assert.equal(parseFrameMessage({ ...request, mediaType: "image/svg+xml" }, "base64", isTool), null);
  assert.equal(parseFrameMessage({ ...request, targetSlug: "nope" }, "base64", isTool), null);
  assert.equal(parseFrameMessage({ ...request, sourceSlug: "json-formatter" }, "base64", isTool), null);
  assert.equal(parseFrameMessage({ ...request, payload: 1 }, "base64", isTool), null);
});
