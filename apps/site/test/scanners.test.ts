import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMON_PORTS,
  formatPortReport,
  parsePortList,
  parsePortScannerSettings,
  presetPorts,
} from "../src/tools/port-scanner.ts";
import {
  compareAddresses,
  formatNetworkReport,
  parseNetwork,
  parseNetworkScannerSettings,
  parseProbePorts,
} from "../src/tools/network-scanner.ts";

test("parsePortList merges ports and ranges and rejects anything else", () => {
  assert.deepEqual(parsePortList("22, 80 443;8000-8002, 81"), { ranges: [[22, 22], [80, 81], [443, 443], [8000, 8002]], count: 7 });
  assert.deepEqual(parsePortList("1-65535"), { ranges: [[1, 65_535]], count: 65_535 });
  assert.deepEqual(parsePortList("10-20, 15-30"), { ranges: [[10, 30]], count: 21 });
  for (const bad of ["", "0", "65536", "80-79", "http", "80-", "1-2-3", "-5"]) assert.equal(parsePortList(bad), null, bad);
});

test("presets cover the common list, 1-1024 and every port", () => {
  assert.equal(presetPorts("common", "")!.count, COMMON_PORTS.length);
  assert.ok(COMMON_PORTS.includes(443) && COMMON_PORTS.includes(3389));
  assert.deepEqual(presetPorts("well-known", "x"), { ranges: [[1, 1024]], count: 1024 });
  assert.equal(presetPorts("all", "")!.count, 65_535);
  assert.equal(presetPorts("custom", "nope"), null);
  assert.equal(presetPorts("custom", "443")!.count, 1);
  const tooMany = Array.from({ length: 1025 }, (_, index) => String(index * 2 + 1)).join(",");
  assert.equal(presetPorts("custom", tooMany), null, "more ranges than the agent accepts");
});

test("port scanner settings keep known values and never a host", () => {
  assert.deepEqual(parsePortScannerSettings(null), { v: 1, preset: "common", custom: "", timeoutMs: 1000, parallel: 64 });
  assert.deepEqual(
    parsePortScannerSettings({ preset: "custom", custom: "22", timeoutMs: 300, parallel: 8, host: "example.com" }),
    { v: 1, preset: "custom", custom: "22", timeoutMs: 300, parallel: 8 },
  );
  assert.deepEqual(parsePortScannerSettings({ preset: "everything", timeoutMs: 10_000, parallel: 65 }),
    { v: 1, preset: "common", custom: "", timeoutMs: 1000, parallel: 64 });
});

test("formatPortReport lists ports in order with their service", () => {
  const text = formatPortReport("example.com", "93.184.215.14", [
    { port: 443, status: "open", elapsedMs: 21 },
    { port: 22, status: "filtered", elapsedMs: 1000 },
  ], { done: 2, open: 1, closed: 0, filtered: 1, other: 0 });
  assert.equal(text, [
    "example.com (93.184.215.14)",
    "scanned 2: open 1, closed 0, filtered 1, other 0",
    "",
    "PORT   STATUS       SERVICE        TIME",
    "22     filtered     ssh            1000 ms",
    "443    open         https          21 ms",
  ].join("\n"));
});

test("parseNetwork accepts IPv4 from /22 to /32 and normalizes the address", () => {
  assert.deepEqual(parseNetwork(" 192.168.1.77/24 "), { network: "192.168.1.0/24", prefix: 24, size: 256 });
  assert.deepEqual(parseNetwork("10.1.7.9/22"), { network: "10.1.4.0/22", prefix: 22, size: 1024 });
  assert.deepEqual(parseNetwork("10.0.0.5/32"), { network: "10.0.0.5/32", prefix: 32, size: 1 });
  for (const bad of ["10.0.0.0/21", "10.0.0.0", "300.0.0.0/24", "fd00::/120", "10.0.0.0/33", "a.b.c.d/24"]) {
    assert.equal(parseNetwork(bad), null, bad);
  }
});

test("probe ports are up to 16 distinct single ports", () => {
  assert.deepEqual(parseProbePorts("443, 22 80,22"), [22, 80, 443]);
  assert.deepEqual(parseProbePorts(""), []);
  assert.equal(parseProbePorts("80-90"), null);
  assert.equal(parseProbePorts("0"), null);
  assert.equal(parseProbePorts(Array.from({ length: 17 }, (_, index) => String(index + 1)).join(",")), null);
  assert.deepEqual(parseNetworkScannerSettings({ timeoutMs: 50, ports: "1-2", resolveNames: false }),
    { v: 1, timeoutMs: 1000, ports: "22, 80, 443, 445, 3389", resolveNames: false });
});

test("formatNetworkReport sorts addresses numerically", () => {
  assert.ok(compareAddresses("192.168.1.9", "192.168.1.10") < 0);
  const text = formatNetworkReport("192.168.1.0/24", [
    { address: "192.168.1.10", openPorts: [], via: ["arp"], mac: "AA:BB:CC:00:11:22", thisComputer: false },
    { address: "192.168.1.9", name: "router.lan", rttMs: 2, openPorts: [80, 443], via: ["icmp", "tcp"], thisComputer: false },
  ]);
  assert.equal(text, [
    "192.168.1.0/24",
    "address\tname\tmac\trtt\topen ports\tseen by\tnote",
    "192.168.1.9\trouter.lan\t\t2 ms\t80,443\ticmp,tcp\t",
    "192.168.1.10\t\tAA:BB:CC:00:11:22\t\t\tarp\t",
  ].join("\n"));
});
