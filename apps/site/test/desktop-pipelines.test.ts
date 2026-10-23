import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptsFile } from "../src/desktop/file-delivery.ts";
import { fileExtension, manifestAccept, toolsForFiles } from "../src/desktop/file-routes.ts";
import { linkDelivery, parseFrameMessage } from "../src/desktop/frame-bridge.ts";
import { addLink, dropWindows, incoming, linkProblem, outgoing, type WindowLink } from "../src/desktop/links.ts";
import { defaultPrefs, parsePrefs, serializePrefs } from "../src/desktop/persistence.ts";
import { BUILTIN_WORKSPACES, scenarioWindows } from "../src/desktop/workspaces.ts";
import { TOOLS } from "../src/registry/tools.ts";
import { canReceive, resultTargets } from "../src/scripts/transfer-specs.ts";

const slugs = new Set(TOOLS.map((tool) => tool.slug));

test("built-in scenarios name real tools and tile the stage without overlap", () => {
  for (const scenario of BUILTIN_WORKSPACES) {
    assert.ok(scenario.slugs.length >= 2 && scenario.slugs.length <= 4, scenario.id);
    for (const slug of scenario.slugs) assert.ok(slugs.has(slug), `${scenario.id}: ${slug}`);
    const windows = scenarioWindows(scenario.slugs);
    const area = windows.reduce((sum, window) => sum + window.bounds.width * window.bounds.height, 0);
    assert.equal(area, 1, scenario.id);
    for (const window of windows) {
      assert.ok(window.bounds.x + window.bounds.width <= 1 && window.bounds.y + window.bounds.height <= 1);
    }
  }
  assert.deepEqual(scenarioWindows(["a", "b", "c"]).map((window) => window.bounds), [
    { x: 0, y: 0, width: 0.5, height: 1 },
    { x: 0.5, y: 0, width: 0.5, height: 0.5 },
    { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
  ]);
});

test("files are routed to matching tools first, then to any-file tools", () => {
  assert.equal(fileExtension("Report.Final.PDF"), ".pdf");
  assert.equal(fileExtension(".bashrc"), "");
  const pdf = toolsForFiles([{ name: "a.pdf", type: "application/pdf" }], slugs);
  assert.equal(pdf[0], "pdf-organizer");
  assert.ok(pdf.includes("hash-calculator"));
  const mixed = toolsForFiles([{ name: "a.png", type: "image/png" }, { name: "b.pdf", type: "" }], slugs);
  assert.ok(!mixed.includes("image-batch") && !mixed.includes("pdf-organizer"));
  assert.equal(mixed[0], "hash-calculator");
  const unknownImage = toolsForFiles([{ name: "photo", type: "image/heic" }], slugs);
  assert.equal(unknownImage[0], "image-batch");
  assert.deepEqual(toolsForFiles([], slugs), []);
  for (const route of Object.values(manifestAccept())) for (const ext of route) assert.match(ext, /^\.[a-z0-9]+$/);
});

test("accept attributes match extensions, wildcards and exact types", () => {
  assert.equal(acceptsFile("", { name: "x.bin", type: "" }), true);
  assert.equal(acceptsFile(".pdf,application/pdf", { name: "x.PDF", type: "" }), true);
  assert.equal(acceptsFile("image/*,.tga", { name: "x.webp", type: "image/webp" }), true);
  assert.equal(acceptsFile("image/*,.tga", { name: "x.txt", type: "text/plain" }), false);
  assert.equal(acceptsFile(".json, application/json", { name: "x", type: "application/json" }), true);
});

test("links refuse self, a second source and cycles; closing a window drops its links", () => {
  let links: WindowLink[] = [];
  links = addLink(links, { id: "1", sourceId: "json", targetId: "ts" });
  links = addLink(links, { id: "2", sourceId: "ts", targetId: "hash" });
  assert.equal(linkProblem(links, "a", "a"), "self");
  assert.equal(linkProblem(links, "b64", "ts"), "taken");
  assert.equal(linkProblem(links, "hash", "json"), "cycle");
  assert.equal(linkProblem(links, "json", "b64"), null);
  assert.equal(addLink(links, { id: "3", sourceId: "hash", targetId: "json" }).length, 2);
  assert.deepEqual(outgoing(links, "json").map((link) => link.targetId), ["ts"]);
  assert.equal(incoming(links, "hash")?.sourceId, "ts");
  assert.deepEqual(dropWindows(links, ["ts"]), []);
});

test("link messages are accepted only from the frame's own tool and stay live on delivery", () => {
  const isTool = (slug: string) => slugs.has(slug);
  assert.deepEqual(
    parseFrameMessage({ type: "mdt:link-update", slug: "json-beautifier", mediaType: "application/json", payload: "{}" }, "json-beautifier", isTool),
    { type: "mdt:link-update", mediaType: "application/json", payload: "{}" },
  );
  assert.equal(parseFrameMessage({ type: "mdt:link-update", slug: "base64-encoder", mediaType: "application/json", payload: "{}" }, "json-beautifier", isTool), null);
  assert.equal(parseFrameMessage({ type: "mdt:link-update", slug: "json-beautifier", mediaType: "text/evil", payload: "{}" }, "json-beautifier", isTool), null);
  assert.deepEqual(parseFrameMessage({ type: "mdt:link-source-ready", slug: "json-beautifier" }, "json-beautifier", isTool), { type: "mdt:link-source-ready" });
  assert.deepEqual(parseFrameMessage({ type: "mdt:popout-return", slug: "uuid-generator" }, "uuid-generator", isTool), { type: "mdt:popout-return" });
  const delivery = linkDelivery("link-1", "json-to-typescript", { type: "mdt:link-update", mediaType: "application/json", payload: "{\"a\":1}" });
  assert.equal(delivery.live, true);
  assert.equal(delivery.requestId, "link-1");
});

test("only tools with an input adapter can follow a result", () => {
  assert.ok(canReceive("json-beautifier", "json-to-typescript"));
  assert.ok(!canReceive("json-beautifier", "json-beautifier"));
  assert.ok(!canReceive("hash-calculator", "base64-encoder"));
  assert.ok(resultTargets("jwt-encoder").includes("jwt-decoder"));
  for (const slug of resultTargets("base64-encoder")) assert.ok(slugs.has(slug));
});

test("starter card dismissal persists and hidden widgets stay hidden once known", () => {
  const prefs = { ...defaultPrefs(["encoding"]), startersDismissed: true, widgets: ["favorites" as const] };
  const reloaded = parsePrefs(serializePrefs(prefs), slugs, new Set(["encoding"]));
  assert.equal(reloaded?.startersDismissed, true);
  assert.deepEqual(reloaded?.widgets, ["favorites"]);
});
