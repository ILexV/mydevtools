#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "@playwright/test";

const KIB = 1024;
const MIB = 1024 * KIB;
const DEFAULT_HASH_SIZES_MIB = [10, 100, 1024, 5120];
const DEFAULT_REPETITIONS = 3;
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const ASSETS = path.join(DIST, "_astro");
const BROWSER_CONFIG = {
  chromium: { type: chromium, launch: {} },
  firefox: { type: firefox, launch: {} },
  webkit: { type: webkit, launch: {} },
  chrome: { type: chromium, launch: { channel: "chrome" } },
  msedge: { type: chromium, launch: { channel: "msedge" } },
};

function usage() {
  return `Usage: node apps/site/scripts/validate-processing-core.mjs [options]

Options:
  --browser <chromium|firefox|webkit|chrome|msedge>
  --hash-sizes <MiB,...>       Hash benchmark sizes (default: 10,100,1024,5120)
  --repetitions <count>        Cancellation/restart cycles (default: 3)
  --executable-path <path>     Override the selected browser executable
  --output <path>              Also write the JSON report to this path
  --url <loopback-url>         Use an existing dist server instead of starting one
  --help                       Show this help

The site must already be built. Fixtures are deterministic virtual Files assembled
from bounded blocks; no multi-gigabyte fixture is written to disk.`;
}

function optionValue(argv, index, name) {
  const argument = argv[index];
  if (argument.startsWith(`${name}=`)) return { value: argument.slice(name.length + 1), consumed: 0 };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value, consumed: 1 };
}

function positiveInteger(value, label) {
  if (!/^\d+$/u.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive safe integer`);
  return parsed;
}

function parseArgs(argv) {
  const options = {
    browser: "chromium",
    hashSizesMiB: DEFAULT_HASH_SIZES_MIB,
    repetitions: DEFAULT_REPETITIONS,
    executablePath: null,
    output: null,
    previewUrl: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--browser" || argument.startsWith("--browser=")) {
      const parsed = optionValue(argv, index, "--browser");
      if (!Object.hasOwn(BROWSER_CONFIG, parsed.value)) throw new Error(`Unknown browser ${JSON.stringify(parsed.value)}`);
      options.browser = parsed.value;
      index += parsed.consumed;
      continue;
    }
    if (argument === "--hash-sizes" || argument.startsWith("--hash-sizes=")) {
      const parsed = optionValue(argv, index, "--hash-sizes");
      const values = parsed.value.split(",").map((value) => positiveInteger(value, "--hash-sizes item"));
      if (values.length === 0 || new Set(values).size !== values.length) throw new Error("--hash-sizes must contain unique values");
      options.hashSizesMiB = values;
      index += parsed.consumed;
      continue;
    }
    if (argument === "--repetitions" || argument.startsWith("--repetitions=")) {
      const parsed = optionValue(argv, index, "--repetitions");
      options.repetitions = positiveInteger(parsed.value, "--repetitions");
      index += parsed.consumed;
      continue;
    }
    if (argument === "--executable-path" || argument.startsWith("--executable-path=")) {
      const parsed = optionValue(argv, index, "--executable-path");
      options.executablePath = path.resolve(parsed.value);
      index += parsed.consumed;
      continue;
    }
    if (argument === "--output" || argument.startsWith("--output=")) {
      const parsed = optionValue(argv, index, "--output");
      options.output = path.resolve(parsed.value);
      index += parsed.consumed;
      continue;
    }
    if (argument === "--url" || argument.startsWith("--url=")) {
      const parsed = optionValue(argv, index, "--url");
      const url = new URL(parsed.value);
      if (!/^https?:$/u.test(url.protocol) || !new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname)) {
        throw new Error("--url must be an HTTP(S) loopback URL");
      }
      url.hash = "";
      options.previewUrl = url.href;
      index += parsed.consumed;
      continue;
    }
    throw new Error(`Unknown argument ${JSON.stringify(argument)}\n\n${usage()}`);
  }
  return options;
}

async function discoverAsset(pattern, label) {
  const entries = await readdir(ASSETS, { withFileTypes: true });
  const matches = entries.filter((entry) => entry.isFile() && pattern.test(entry.name)).map((entry) => entry.name).sort();
  if (matches.length !== 1) throw new Error(`Expected one built ${label} asset, found ${matches.length}: ${matches.join(", ")}`);
  return matches[0];
}

async function discoverAssets() {
  return {
    jobWorker: await discoverAsset(/^job-worker\.[A-Za-z0-9_-]+\.js$/u, "job worker"),
    hashWorker: await discoverAsset(/^hash\.worker[-.][A-Za-z0-9_-]+\.js$/u, "hash worker"),
    csvWorker: await discoverAsset(/^csv-explorer\.worker[-.][A-Za-z0-9_-]+\.js$/u, "CSV explorer worker"),
    jsonWorker: await discoverAsset(/^json-explorer\.worker[-.][A-Za-z0-9_-]+\.js$/u, "JSON explorer worker"),
  };
}

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

async function startServer(basePath) {
  const harness = "<!doctype html><meta charset=utf-8><title>Processing core validation</title>";
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }).end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!url.pathname.startsWith(basePath)) {
        response.writeHead(404).end();
        return;
      }
      if (url.pathname === `${basePath}__processing-core-qa__/`) {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(harness),
        });
        response.end(request.method === "HEAD" ? undefined : harness);
        return;
      }
      let relative;
      try {
        relative = decodeURIComponent(url.pathname.slice(basePath.length));
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (!relative || relative.endsWith("/")) relative += "index.html";
      let filePath = path.resolve(DIST, relative);
      const prefix = `${path.resolve(DIST)}${path.sep}`;
      if (!filePath.startsWith(prefix)) {
        response.writeHead(403).end();
        return;
      }
      let info = await stat(filePath);
      if (info.isDirectory()) {
        filePath = path.join(filePath, "index.html");
        info = await stat(filePath);
      }
      if (!info.isFile()) throw new Error("Not a file");
      const body = request.method === "HEAD" ? null : await readFile(filePath);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": info.size,
        "Content-Type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
      });
      response.end(body ?? undefined);
    } catch {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("QA server did not expose a TCP address");
  return { server, pageUrl: `http://127.0.0.1:${address.port}${basePath}__processing-core-qa__/` };
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function fixtureBlock() {
  const block = Buffer.allocUnsafe(MIB);
  for (let index = 0; index < block.length; index += 1) {
    block[index] = (Math.imul(index, 31) + Math.imul(index >>> 8, 17) + 0x5a) & 0xff;
  }
  return block;
}

function expectedDigests(sizes) {
  const ordered = [...new Set(sizes)].sort((left, right) => left - right);
  const block = fixtureBlock();
  const hash = createHash("sha256");
  const result = new Map([[0, hash.copy().digest("hex")]]);
  let consumed = 0;
  for (const target of ordered) {
    while (consumed < target) {
      const position = consumed % block.length;
      const count = Math.min(block.length - position, target - consumed);
      hash.update(block.subarray(position, position + count));
      consumed += count;
    }
    result.set(target, hash.copy().digest("hex"));
  }
  return result;
}

async function processTreeRss(rootPid) {
  const found = new Set();
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (!Number.isInteger(pid) || found.has(pid)) continue;
    found.add(pid);
    try {
      const tids = await readdir(`/proc/${pid}/task`);
      const lists = await Promise.all(tids.map((tid) => readFile(`/proc/${pid}/task/${tid}/children`, "utf8").catch(() => "")));
      for (const list of lists) for (const child of list.trim().split(/\s+/u)) if (child) pending.push(Number(child));
    } catch {
      // Processes can disappear between samples.
    }
  }
  let rssBytes = 0;
  let processCount = 0;
  for (const pid of found) {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
      if (match) {
        rssBytes += Number(match[1]) * KIB;
        processCount += 1;
      }
    } catch {
      // Processes can disappear between discovery and reading.
    }
  }
  return { rssBytes, rssMiB: Number((rssBytes / MIB).toFixed(3)), processCount };
}

function createRssSampler(rootPid) {
  const supported = process.platform === "linux" && Number.isInteger(rootPid);
  const samples = [];
  let phase = "idle";
  let timer = null;
  let sampling = null;
  const sample = async () => {
    if (!supported) return null;
    if (sampling) return sampling;
    sampling = processTreeRss(rootPid).then((value) => {
      const observation = { ...value, phase, elapsedMs: Number(performance.now().toFixed(3)) };
      samples.push(observation);
      return observation;
    }).finally(() => { sampling = null; });
    return sampling;
  };
  return {
    supported,
    setPhase(value) { phase = value; },
    start() {
      if (!supported) return;
      timer = setInterval(() => { void sample(); }, 100);
      timer.unref();
    },
    async sample() { return sample(); },
    async stop() {
      clearInterval(timer);
      if (sampling) await sampling;
    },
    report() {
      if (!supported) return {
        supported: false,
        reason: process.platform !== "linux" ? "Linux /proc is required" : "Browser PID was unavailable",
      };
      const peak = samples.reduce((best, value) => !best || value.rssBytes > best.rssBytes ? value : best, null);
      return {
        supported: true,
        metric: "browser process-tree RSS",
        samplingIntervalMs: 100,
        sampleCount: samples.length,
        peak,
        final: samples.at(-1) ?? null,
        caveat: "RSS is summed across the browser process tree and can double-count shared physical pages. It is not JavaScript heap or unique physical memory.",
      };
    },
  };
}

async function installHarness(page, urls) {
  return page.evaluate(async (assetUrls) => {
    const module = await import(assetUrls.jobWorker);
    let createRunner = null;
    for (const candidate of Object.values(module)) {
      if (typeof candidate !== "function") continue;
      try {
        const possible = candidate(() => { throw new Error("probe must stay lazy"); });
        if (possible && typeof possible.run === "function" && typeof possible.terminate === "function") {
          createRunner = candidate;
          break;
        }
      } catch {
        // Other exports need different arguments.
      }
    }
    if (!createRunner) throw new Error("Could not identify createJobWorker in the built module");

    const MIB = 1024 * 1024;
    const state = { createRunner, urls: assetUrls, runners: new Set() };
    const binaryBytes = new Uint8Array(MIB);
    for (let index = 0; index < binaryBytes.length; index += 1) {
      binaryBytes[index] = (Math.imul(index, 31) + Math.imul(index >>> 8, 17) + 0x5a) & 0xff;
    }
    const binaryBlock = new Blob([binaryBytes], { type: "application/octet-stream" });

    function repeatedFile(size, block, name, type) {
      const full = Math.floor(size / block.size);
      const rest = size % block.size;
      const parts = new Array(full).fill(block);
      if (rest) parts.push(block.slice(0, rest));
      const file = new File(parts, name, { type, lastModified: 0 });
      if (file.size !== size) throw new Error(`Fixture size mismatch: ${file.size} !== ${size}`);
      return file;
    }

    function repeatedTextFile(size, pattern, name, type) {
      const encoded = new TextEncoder().encode(pattern);
      const blockBytes = Math.min(size, MIB);
      const bytes = new Uint8Array(blockBytes);
      bytes.fill(0x20);
      let offset = 0;
      while (offset + encoded.length <= bytes.length) {
        bytes.set(encoded, offset);
        offset += encoded.length;
      }
      const block = new Blob([bytes], { type });
      return repeatedFile(size, block, name, type);
    }

    function makeRunner(url) {
      const runner = state.createRunner(() => new Worker(url, { type: "module" }));
      state.runners.add(runner);
      return runner;
    }

    function errorInfo(error) {
      return {
        name: error?.name ?? typeof error,
        code: error?.code ?? null,
        message: error?.message ?? String(error),
      };
    }

    function startHeartbeat() {
      const gaps = [];
      let previous = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        gaps.push(now - previous);
        previous = now;
      }, 16);
      return () => {
        clearInterval(timer);
        const ordered = [...gaps].sort((left, right) => left - right);
        const percentile = ordered.length ? ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))] : null;
        return {
          intervalMs: 16,
          ticks: gaps.length,
          maximumGapMs: ordered.length ? Number(ordered.at(-1).toFixed(3)) : null,
          p95GapMs: percentile === null ? null : Number(percentile.toFixed(3)),
        };
      };
    }

    function heapSnapshot() {
      const memory = performance.memory;
      return memory ? {
        usedJsHeapSize: memory.usedJSHeapSize,
        totalJsHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
      } : null;
    }

    async function measured(label, operation) {
      const stopHeartbeat = startHeartbeat();
      const beforeHeap = heapSnapshot();
      const started = performance.now();
      try {
        const value = await operation();
        return {
          label,
          ok: true,
          elapsedMs: Number((performance.now() - started).toFixed(3)),
          responsiveness: stopHeartbeat(),
          pageHeapBefore: beforeHeap,
          pageHeapAfter: heapSnapshot(),
          value,
        };
      } catch (error) {
        return {
          label,
          ok: false,
          elapsedMs: Number((performance.now() - started).toFixed(3)),
          responsiveness: stopHeartbeat(),
          pageHeapBefore: beforeHeap,
          pageHeapAfter: heapSnapshot(),
          error: errorInfo(error),
        };
      }
    }

    async function hash(bytes) {
      const runner = makeRunner(state.urls.hashWorker);
      const file = repeatedFile(bytes, binaryBlock, `fixture-${bytes}.bin`, "application/octet-stream");
      const progress = [];
      const result = await measured(`hash-${bytes}`, () => runner.run(
        { type: "start", algorithms: ["sha256"], file },
        [],
        undefined,
        (value) => progress.push(value),
      ));
      runner.terminate();
      result.fixtureBytes = file.size;
      result.throughputMiBPerSecond = bytes > 0 && result.elapsedMs > 0
        ? Number(((bytes / MIB) / (result.elapsedMs / 1000)).toFixed(3))
        : null;
      result.progressEvents = progress.length;
      result.finalProgress = progress.at(-1) ?? null;
      if (result.ok) result.digest = result.value.hashes.find((item) => item.id === "sha256")?.hex ?? null;
      delete result.value;
      return result;
    }

    async function cancelRestart(workerUrl, fixture, request, restartFile, restartRequest, repetitions) {
      const cycles = [];
      for (let iteration = 1; iteration <= repetitions; iteration += 1) {
        const runner = makeRunner(workerUrl);
        const controller = new AbortController();
        let abortProcessed = null;
        const started = performance.now();
        let canceled;
        try {
          await runner.run({ ...request, file: fixture }, [], controller.signal, (progress) => {
            if (progress.processed > 0 && !controller.signal.aborted) {
              abortProcessed = progress.processed;
              controller.abort();
            }
          });
          canceled = { rejected: false };
        } catch (error) {
          canceled = { rejected: true, error: errorInfo(error) };
        }
        const cancelElapsedMs = performance.now() - started;
        let restarted;
        try {
          restarted = await runner.run({ ...restartRequest, file: restartFile });
        } catch (error) {
          runner.terminate();
          throw new Error(`Restart ${iteration} failed after cancellation: ${errorInfo(error).message}`);
        }
        runner.terminate();
        cycles.push({
          iteration,
          abortProcessed,
          cancelElapsedMs: Number(cancelElapsedMs.toFixed(3)),
          canceled,
          restart: restarted,
        });
      }
      return cycles;
    }

    globalThis.__processingCoreQa = {
      heapSupport: {
        performanceMemory: Boolean(performance.memory),
        userAgentSpecificMemory: typeof performance.measureUserAgentSpecificMemory === "function",
      },
      async runHash(bytes) { return hash(bytes); },
      async hashCancelRestart(repetitions) {
        const large = repeatedFile(100 * MIB, binaryBlock, "cancel-100MiB.bin", "application/octet-stream");
        const small = repeatedFile(1024, binaryBlock, "restart-1KiB.bin", "application/octet-stream");
        return cancelRestart(
          state.urls.hashWorker,
          large,
          { type: "start", algorithms: ["sha256"] },
          small,
          { type: "start", algorithms: ["sha256"] },
          repetitions,
        );
      },
      async explorerFixtures(repetitions) {
        const csvPattern = "00000001,alpha,beta,gamma,delta,epsilon,0123456789abcdef0123456789abcdef\n";
        const jsonPattern = '{"id":1,"name":"alpha","ok":true,"value":"0123456789abcdef0123456789abcdef"}\n';
        const invalidBytes = new Uint8Array(MIB);
        invalidBytes.fill(0xff);
        const invalidBlock = new Blob([invalidBytes], { type: "application/octet-stream" });
        const csvOptions = { encoding: "auto", delimiter: "auto", header: false };
        const jsonSettings = { ordinaryJsonBytes: 32 * MIB, recordBytes: 4 * MIB, maxDepth: 256 };

        const csv = makeRunner(state.urls.csvWorker);
        const emptyCsv = await measured("csv-empty", () => csv.run({ type: "open", file: new File([], "empty.csv"), options: csvOptions }));
        const smallCsvFile = repeatedTextFile(1024, csvPattern, "small.csv", "text/csv");
        const smallCsv = await measured("csv-1KiB", () => csv.run({ type: "open", file: smallCsvFile, options: csvOptions }));
        const largeCsvFile = repeatedTextFile(100 * MIB, csvPattern, "large.csv", "text/csv");
        const largeCsv = await measured("csv-100MiB", () => csv.run({ type: "open", file: largeCsvFile, options: csvOptions }));
        csv.terminate();

        const restartCsvFile = repeatedTextFile(1024, csvPattern, "restart.csv", "text/csv");
        const csvCancellation = await cancelRestart(
          state.urls.csvWorker,
          largeCsvFile,
          { type: "open", options: csvOptions },
          restartCsvFile,
          { type: "open", options: csvOptions },
          repetitions,
        );

        const limitCsv = makeRunner(state.urls.csvWorker);
        const oversizedField = new File(["value\n", new Blob([new Uint8Array(2 * MIB + 1).fill(0x61)])], "oversized-field.csv", { type: "text/csv" });
        const csvFieldLimit = await measured("csv-field-limit", () => limitCsv.run({ type: "open", file: oversizedField, options: csvOptions }));
        limitCsv.terminate();

        const json = makeRunner(state.urls.jsonWorker);
        const emptyJsonl = await measured("jsonl-empty", () => json.run({ type: "open", file: new File([], "empty.jsonl"), format: "jsonl", settings: jsonSettings }));
        const smallJsonlFile = repeatedTextFile(1024, jsonPattern, "small.jsonl", "application/x-ndjson");
        const smallJsonl = await measured("jsonl-1KiB", () => json.run({ type: "open", file: smallJsonlFile, format: "jsonl", settings: jsonSettings }));
        const largeJsonlFile = repeatedTextFile(100 * MIB, jsonPattern, "large.jsonl", "application/x-ndjson");
        const largeJsonl = await measured("jsonl-100MiB", () => json.run({ type: "open", file: largeJsonlFile, format: "jsonl", settings: jsonSettings }));
        const invalidUtf8 = await measured("json-invalid-utf8", () => json.run({ type: "open", file: repeatedFile(1024, invalidBlock, "invalid.json", "application/json"), format: "json", settings: jsonSettings }));
        const hugeInvalid = await measured("json-1GiB-plus-limit", () => json.run({
          type: "open",
          file: repeatedFile(1024 * MIB + 1, invalidBlock, "huge-invalid.json", "application/json"),
          format: "json",
          settings: jsonSettings,
        }));
        const tightSettings = { ...jsonSettings, recordBytes: 64 * 1024 };
        const oversizedRecord = new File([`{"value":"${"a".repeat(128 * 1024)}"}\n`], "oversized.jsonl", { type: "application/x-ndjson" });
        const jsonRecordLimit = await measured("json-record-limit", () => json.run({ type: "open", file: oversizedRecord, format: "jsonl", settings: tightSettings }));
        json.terminate();

        return {
          csv: { emptyCsv, smallCsv, largeCsv, cancellationRestart: csvCancellation, fieldLimit: csvFieldLimit },
          json: { emptyJsonl, smallJsonl, largeJsonl, invalidUtf8, hugeInvalid, recordLimit: jsonRecordLimit },
        };
      },
      async exportBackpressure() {
        const pattern = "00000001,alpha,beta,gamma,delta,epsilon,0123456789abcdef0123456789abcdef\n";
        const runner = makeRunner(state.urls.csvWorker);
        const opened = await runner.run({
          type: "open",
          file: repeatedTextFile(8 * MIB, pattern, "export.csv", "text/csv"),
          options: { encoding: "auto", delimiter: "auto", header: false },
        });
        const request = {
          type: "export",
          sessionId: opened.sessionId,
          format: "csv",
          columns: opened.columns.map((column) => column.index),
          includeHeader: false,
          protectFormulas: true,
          bom: false,
        };

        async function receive(delayMs, abortFirst) {
          const channel = new MessageChannel();
          let pending = 0;
          let maximumPending = 0;
          let chunks = 0;
          let bytes = 0;
          const arrivals = [];
          const ended = Promise.withResolvers();
          channel.port1.onmessage = (event) => {
            const message = event.data;
            if (message?.type === "end") {
              ended.resolve();
              return;
            }
            if (message?.type !== "chunk" || !(message.bytes instanceof ArrayBuffer)) {
              ended.reject(new Error("Invalid export stream message"));
              return;
            }
            pending++;
            maximumPending = Math.max(maximumPending, pending);
            chunks++;
            bytes += message.bytes.byteLength;
            arrivals.push(performance.now());
            setTimeout(() => {
              pending--;
              channel.port1.postMessage({ type: abortFirst && chunks === 1 ? "abort" : "ready" });
              if (abortFirst) ended.resolve();
            }, delayMs);
          };
          channel.port1.start();
          const run = runner.run({ ...request, stream: channel.port2 }, [channel.port2]);
          let result = null;
          let error = null;
          try {
            result = await run;
          } catch (caught) {
            error = errorInfo(caught);
          }
          await ended.promise;
          channel.port1.close();
          const gaps = arrivals.slice(1).map((value, index) => value - arrivals[index]);
          return {
            result,
            error,
            chunks,
            bytes,
            maximumPending,
            minimumArrivalGapMs: gaps.length ? Number(Math.min(...gaps).toFixed(3)) : null,
          };
        }

        const delayed = await receive(75, false);
        const failed = await receive(0, true);
        const recovery = await receive(0, false);
        runner.terminate();
        return { delayPerChunkMs: 75, delayed, failed, recovery };
      },
      terminate() {
        for (const runner of state.runners) runner.terminate();
        state.runners.clear();
      },
    };
    return globalThis.__processingCoreQa.heapSupport;
  }, urls);
}

function assertResult(condition, message) {
  if (!condition) throw new Error(`Validation failed: ${message}`);
}

function validateReport(results, digests, repetitions) {
  for (const result of results.hashBenchmarks) {
    assertResult(result.ok, `${result.label} did not complete`);
    assertResult(result.digest === digests.get(result.fixtureBytes), `${result.label} digest mismatch`);
    assertResult(result.finalProgress?.processed === result.fixtureBytes, `${result.label} did not report complete progress`);
  }
  for (const cycle of results.hashCancellationRestart) {
    assertResult(cycle.canceled.rejected && cycle.canceled.error.code === "aborted", `hash cancellation ${cycle.iteration} was not typed aborted`);
    assertResult(cycle.restart?.hashes?.some((item) => item.id === "sha256" && item.hex === digests.get(1024)), `hash restart ${cycle.iteration} was incorrect`);
  }
  assertResult(results.hashCancellationRestart.length === repetitions, "hash cancellation repetition count differs");

  const { csv, json } = results.explorers;
  assertResult(!csv.emptyCsv.ok && csv.emptyCsv.error.message === "malformed-csv", "empty CSV was not rejected as malformed");
  assertResult(csv.smallCsv.ok && csv.smallCsv.value.fileSize === 1024, "1 KiB CSV did not open");
  assertResult(csv.largeCsv.ok && csv.largeCsv.value.fileSize === 100 * MIB, "100 MiB CSV did not open");
  for (const cycle of csv.cancellationRestart) {
    assertResult(cycle.canceled.rejected && cycle.canceled.error.code === "aborted", `CSV cancellation ${cycle.iteration} was not typed aborted`);
    assertResult(cycle.restart?.fileSize === 1024, `CSV restart ${cycle.iteration} failed`);
  }
  assertResult(!csv.fieldLimit.ok && csv.fieldLimit.error.code === "input-too-large", "CSV field resource limit was not enforced");
  assertResult(json.emptyJsonl.ok && json.emptyJsonl.value.sourceRows === 0, "empty JSONL did not produce an empty session");
  assertResult(json.smallJsonl.ok && json.smallJsonl.value.fileBytes === 1024, "1 KiB JSONL did not open");
  assertResult(json.largeJsonl.ok && json.largeJsonl.value.fileBytes === 100 * MIB, "100 MiB JSONL did not open");
  assertResult(json.invalidUtf8.ok && json.invalidUtf8.value.explorerError?.code === "invalid-utf8", "invalid UTF-8 was not diagnosed");
  assertResult(json.hugeInvalid.ok && json.hugeInvalid.value.explorerError?.code === "ordinary-limit", "1 GiB+ ordinary JSON limit was not enforced before reading");
  assertResult(json.recordLimit.ok && json.recordLimit.value.explorerError?.code === "record-limit", "JSONL record limit was not enforced");

  const exportResult = results.exportBackpressure;
  assertResult(exportResult.delayed.chunks > 1 && exportResult.delayed.maximumPending === 1, "CSV export did not honor one-chunk backpressure");
  assertResult(exportResult.delayed.minimumArrivalGapMs >= 50, "CSV export did not wait for delayed acknowledgements");
  assertResult(exportResult.failed.error?.code === "aborted", "CSV export destination failure was not propagated as aborted");
  assertResult(exportResult.recovery.result?.kind === "export", "CSV export did not recover after destination failure");
}

async function run(options, assets) {
  const manifest = JSON.parse(await readFile(path.join(DIST, "manifest.webmanifest"), "utf8"));
  const basePath = manifest.scope;
  let localServer = null;
  let browserServer = null;
  let browser = null;
  let context = null;
  let page = null;
  let sampler = null;
  let primaryError = null;
  let report = null;
  const network = [];
  const requestStarts = new WeakMap();
  const startedAt = performance.now();

  try {
    const pageUrl = options.previewUrl ?? (localServer = await startServer(basePath)).pageUrl;
    const origin = new URL(pageUrl).origin;
    const assetUrls = Object.fromEntries(Object.entries(assets).map(([key, value]) => [key, new URL(`${basePath}_astro/${value}`, origin).href]));
    const selected = BROWSER_CONFIG[options.browser];
    const launchOptions = { ...selected.launch, headless: true };
    if (options.executablePath) launchOptions.executablePath = options.executablePath;
    browserServer = await selected.type.launchServer(launchOptions);
    const browserProcess = browserServer.process();
    browser = await selected.type.connect(browserServer.wsEndpoint());
    context = await browser.newContext({ serviceWorkers: "block" });
    page = await context.newPage();
    page.on("request", (request) => requestStarts.set(request, performance.now()));
    page.on("response", async (response) => {
      const request = response.request();
      const url = response.url();
      if (!url.includes("/_astro/")) return;
      const headers = await response.allHeaders().catch(() => ({}));
      network.push({
        url,
        resourceType: request.resourceType(),
        status: response.status(),
        contentLength: Number(headers["content-length"] ?? 0) || null,
        responseStartedMs: Number((performance.now() - (requestStarts.get(request) ?? performance.now())).toFixed(3)),
      });
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === "data:" || url.origin === origin) await route.continue();
      else await route.abort("blockedbyclient");
    });
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    const moduleNetworkStart = network.length;
    const heapSupport = await installHarness(page, assetUrls);
    await page.waitForTimeout(50);
    const commonModuleLoads = network.slice(moduleNetworkStart);

    sampler = createRssSampler(browserProcess?.pid ?? null);
    sampler.start();
    await sampler.sample();

    const allHashBytes = [0, 1024, ...options.hashSizesMiB.map((size) => size * MIB)];
    const digests = expectedDigests(allHashBytes);
    sampler.setPhase("hash-cold-and-edge-fixtures");
    const hashBenchmarks = [];
    const hashNetworkStart = network.length;
    const coldBytes = allHashBytes[0];
    process.stderr.write(`Hashing empty in ${options.browser}\n`);
    hashBenchmarks.push(await page.evaluate((size) => globalThis.__processingCoreQa.runHash(size), coldBytes));
    await page.waitForTimeout(50);
    const firstHashLazyLoads = network.slice(hashNetworkStart);
    for (const bytes of allHashBytes.slice(1)) {
      process.stderr.write(`Hashing ${(bytes / MIB).toFixed(bytes < MIB ? 3 : 0)} MiB in ${options.browser}\n`);
      hashBenchmarks.push(await page.evaluate((size) => globalThis.__processingCoreQa.runHash(size), bytes));
    }

    sampler.setPhase("hash-cancellation-restart");
    const hashCancellationRestart = await page.evaluate((count) => globalThis.__processingCoreQa.hashCancelRestart(count), options.repetitions);
    sampler.setPhase("csv-json-fixtures-and-limits");
    const explorers = await page.evaluate((count) => globalThis.__processingCoreQa.explorerFixtures(count), options.repetitions);
    sampler.setPhase("csv-export-backpressure");
    const exportBackpressure = await page.evaluate(() => globalThis.__processingCoreQa.exportBackpressure());
    sampler.setPhase("post-operation");
    await sampler.sample();

    const results = { hashBenchmarks, hashCancellationRestart, explorers, exportBackpressure };
    validateReport(results, digests, options.repetitions);
    await page.evaluate(() => globalThis.__processingCoreQa.terminate());
    await page.waitForTimeout(100);
    sampler.setPhase("post-worker-termination");
    await sampler.sample();
    await sampler.stop();

    const cpus = os.cpus();
    report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      validation: "built browser processing core",
      passed: true,
      configuration: {
        browser: options.browser,
        hashSizesMiB: options.hashSizesMiB,
        cancellationRestartRepetitions: options.repetitions,
        serverMode: options.previewUrl ? "existing-loopback-preview" : "short-lived-loopback-static-server",
        assets,
      },
      fixtureModel: {
        persistedFixtureBytes: 0,
        maximumGeneratedBlockBytes: MIB,
        binary: "One deterministic 1 MiB Blob is repeated as File parts; a final slice supplies an exact remainder.",
        text: "One deterministic 1 MiB ASCII Blob is repeated as File parts; test output and scans remain chunked.",
        binaryByteFormula: "(index * 31 + (index >>> 8) * 17 + 0x5a) & 0xff",
        expectedHash: "Node crypto SHA-256 over the independently generated deterministic block stream.",
      },
      results,
      lazyLoading: {
        commonModuleLoads,
        firstHashOperationLoads: firstHashLazyLoads,
        accounting: "HTTP Content-Length and request-to-response-start wall time observed by Playwright. This is encoded response size, not parsed/compiled memory cost; disk/browser cache and connection setup affect time.",
      },
      memory: {
        processTree: sampler.report(),
        pageHeapSupport: heapSupport,
        pageHeapCaveat: "performance.memory, when present, describes the harness page JavaScript heap only. It excludes worker/WASM memory and is Chromium-specific/non-standard. No forced garbage collection is used.",
      },
      responsiveness: {
        metric: "16 ms main-page setInterval heartbeat while each worker operation runs",
        caveat: "Timer gaps are scheduling observations, not frame rendering measurements. Headless background scheduling and host load affect them.",
      },
      metadata: {
        nodeVersion: process.version,
        browserName: options.browser,
        browserVersion: browser.version(),
        executablePathOverride: options.executablePath,
        operatingSystem: { platform: process.platform, release: os.release(), architecture: process.arch },
        cpu: { model: cpus[0]?.model ?? null, logicalProcessorCount: cpus.length },
      },
      totalWallTimeMs: Number((performance.now() - startedAt).toFixed(3)),
    };
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanup = [];
    if (sampler) try { await sampler.stop(); } catch (error) { cleanup.push(error); }
    if (page) try { await page.evaluate(() => globalThis.__processingCoreQa?.terminate()); } catch (error) { cleanup.push(error); }
    if (context) try { await context.close(); } catch (error) { cleanup.push(error); }
    if (browserServer) try { await browserServer.close(); } catch (error) { cleanup.push(error); }
    else if (browser) try { await browser.close(); } catch (error) { cleanup.push(error); }
    if (localServer) try { await closeServer(localServer.server); } catch (error) { cleanup.push(error); }
    if (cleanup.length > 0) {
      const cleanupError = new AggregateError(cleanup, "Processing QA cleanup failed");
      primaryError = primaryError ? new AggregateError([primaryError, cleanupError], "Processing QA and cleanup failed") : cleanupError;
    }
  }
  if (primaryError) throw primaryError;
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const assets = await discoverAssets();
  const report = await run(options, assets);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(path.dirname(options.output), { recursive: true });
    await writeFile(options.output, json, "utf8");
    process.stderr.write(`Wrote processing core report to ${options.output}\n`);
  }
  process.stdout.write(json);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
