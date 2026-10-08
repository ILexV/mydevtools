import { test } from "node:test";
import assert from "node:assert/strict";
import { exportHashResults, type HashResultGroup } from "../src/tools/hash-results.ts";

const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const completed: HashResultGroup = {
  source: "file", name: 'quotes,"файл"\r\n.txt', bytes: 3, status: "done", elapsedMs: 12.5,
  hashes: [{ id: "sha256", hex: ABC_SHA256 }],
};

test("CSV escapes file names and errors, and retains failed/canceled files without digests", () => {
  const groups: HashResultGroup[] = [
    completed,
    { ...completed, name: "unreadable.bin", status: "error", hashes: [], error: 'Cannot read, "retry"\nSelect again.' },
    { ...completed, name: "pending.bin", status: "canceled", hashes: [], elapsedMs: 0 },
  ];
  assert.equal(exportHashResults(groups, "csv"),
    '\uFEFFsource,name,bytes,status,elapsed_ms,algorithm,digest,error\r\n' +
    `"file","quotes,""файл""\r\n.txt",3,"done",12.5,"sha256","${ABC_SHA256}",""\r\n` +
    '"file","unreadable.bin",3,"error",12.5,"","","Cannot read, ""retry""\nSelect again."\r\n' +
    '"file","pending.bin",3,"canceled",0,"","",""\r\n');
});

test("CSV neutralizes formula prefixes without mutating later JSON exports", () => {
  const names = ["=1+1", "+SUM(1,1)", "-1+1", "@SUM(1,1)", "  =1+1", "\t1+1", "\r1+1", "\n1+1"];
  const groups = names.map((name) => ({ ...completed, name }));
  const csv = exportHashResults(groups, "csv");
  for (const name of names) {
    assert.ok(csv.includes(`"'${name}",3,"done"`), `unsafe spreadsheet name: ${JSON.stringify(name)}`);
  }
  assert.deepEqual(JSON.parse(exportHashResults(groups, "json")).results.map((group: HashResultGroup) => group.name), names);
});

test("JSON downloads exclude input payloads even when a caller adds them to its snapshot", () => {
  const group = { ...completed, source: "text" as const, name: null, inputText: "private text that must never be exported" };
  const json = exportHashResults([group], "json");
  const result = JSON.parse(json).results[0];
  assert.equal(result.hashes[0].hex, ABC_SHA256);
  assert.equal(Object.hasOwn(result, "inputText"), false);
  assert.equal(json.includes(group.inputText), false);
});
