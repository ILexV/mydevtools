#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "@playwright/test";

const MIB = 1024 * 1024;
const DEFAULT_SIZES_MIB = [10, 100, 1024];
const DEFAULT_ITERATIONS = 3;
const RSS_SAMPLE_INTERVAL_MS = 50;
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const ASTRO_ASSETS = path.join(DIST, "_astro");
const BROWSER_TYPES = { chromium, firefox, webkit };
const require = createRequire(import.meta.url);

function usage() {
  return `Usage: npm run bench:hash -- [options]

Options:
  --browser <chromium|firefox|webkit>  Browser engine (default: chromium)
  --sizes <MiB,...>                   Positive integer MiB sizes (default: 10,100,1024)
  --iterations <count>                Measured trials per backend and size (default: 3)
  --output <path>                     Also write the JSON report to this path
  --url <loopback-url>                Use an already-running local preview instead of serving dist
  --help                              Show this help

The site must already be built. The runner discovers the built hash.worker asset in
apps/site/dist/_astro and never downloads or uploads benchmark data.`;
}

function takeOptionValue(argv, index, name) {
  const argument = argv[index];
  const equalsPrefix = `${name}=`;
  if (argument.startsWith(equalsPrefix)) return { value: argument.slice(equalsPrefix.length), consumed: 0 };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value, consumed: 1 };
}

function parsePositiveInteger(value, label) {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a positive integer, received ${JSON.stringify(value)}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    browser: "chromium",
    sizesMiB: DEFAULT_SIZES_MIB,
    iterations: DEFAULT_ITERATIONS,
    output: null,
    previewUrl: process.env.HASH_BENCHMARK_URL || null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--browser" || argument.startsWith("--browser=")) {
      const { value, consumed } = takeOptionValue(argv, index, "--browser");
      if (!Object.hasOwn(BROWSER_TYPES, value)) {
        throw new Error(`--browser must be one of ${Object.keys(BROWSER_TYPES).join(", ")}, received ${JSON.stringify(value)}`);
      }
      options.browser = value;
      index += consumed;
      continue;
    }
    if (argument === "--sizes" || argument.startsWith("--sizes=")) {
      const { value, consumed } = takeOptionValue(argv, index, "--sizes");
      const values = value.split(",");
      if (values.length === 0 || values.some((item) => item.length === 0)) {
        throw new Error("--sizes requires a comma-separated list of positive integer MiB values");
      }
      options.sizesMiB = values.map((item) => parsePositiveInteger(item, "--sizes item"));
      if (new Set(options.sizesMiB).size !== options.sizesMiB.length) {
        throw new Error("--sizes must not contain duplicate values");
      }
      index += consumed;
      continue;
    }
    if (argument === "--iterations" || argument.startsWith("--iterations=")) {
      const { value, consumed } = takeOptionValue(argv, index, "--iterations");
      options.iterations = parsePositiveInteger(value, "--iterations");
      index += consumed;
      continue;
    }
    if (argument === "--output" || argument.startsWith("--output=")) {
      const { value, consumed } = takeOptionValue(argv, index, "--output");
      if (!value) throw new Error("--output requires a non-empty path");
      options.output = path.resolve(value);
      index += consumed;
      continue;
    }
    if (argument === "--url" || argument.startsWith("--url=")) {
      const { value, consumed } = takeOptionValue(argv, index, "--url");
      options.previewUrl = value;
      index += consumed;
      continue;
    }
    throw new Error(`Unknown argument ${JSON.stringify(argument)}\n\n${usage()}`);
  }

  if (options.previewUrl) {
    const url = new URL(options.previewUrl);
    const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if (!/^https?:$/.test(url.protocol) || !loopbackHosts.has(url.hostname)) {
      throw new Error("--url/HASH_BENCHMARK_URL must be an HTTP(S) loopback URL (localhost, 127.0.0.1, or [::1])");
    }
    url.hash = "";
    options.previewUrl = url.href;
  }

  return options;
}

async function discoverHashWorker() {
  let entries;
  try {
    entries = await readdir(ASTRO_ASSETS, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read ${ASTRO_ASSETS}; build the site before benchmarking`, { cause: error });
  }
  const matches = entries
    .filter((entry) => entry.isFile() && /^hash\.worker(?:[-.][A-Za-z0-9_-]+)?\.js$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one built hash worker in ${ASTRO_ASSETS}, found ${matches.length}${matches.length ? `: ${matches.join(", ")}` : ""}. Rebuild the site to remove stale or missing assets.`,
    );
  }
  return matches[0];
}

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
};

async function startDistServer(basePath) {
  const harness = "<!doctype html><meta charset=utf-8><title>Hash benchmark</title>";
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
      if (url.pathname === `${basePath}__hash-benchmark__/`) {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(harness),
        });
        response.end(request.method === "HEAD" ? undefined : harness);
        return;
      }

      let relativePath;
      try {
        relativePath = decodeURIComponent(url.pathname.slice(basePath.length));
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (!relativePath || relativePath.endsWith("/")) relativePath += "index.html";
      let filePath = path.resolve(DIST, relativePath);
      const distPrefix = `${path.resolve(DIST)}${path.sep}`;
      if (!filePath.startsWith(distPrefix)) {
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
  if (!address || typeof address === "string") throw new Error("Local benchmark server did not expose a TCP address");
  return {
    server,
    pageUrl: `http://127.0.0.1:${address.port}${basePath}__hash-benchmark__/`,
  };
}

async function closeHttpServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createFixtureBlock() {
  const block = Buffer.allocUnsafe(MIB);
  for (let index = 0; index < block.length; index += 1) {
    block[index] = (Math.imul(index, 31) + Math.imul(index >>> 8, 17) + 0x5a) & 0xff;
  }
  return block;
}

function computeExpectedDigests(sizesMiB) {
  const targets = [...new Set([0, 1, ...sizesMiB])].sort((left, right) => left - right);
  const targetSet = new Set(targets);
  const block = createFixtureBlock();
  const hash = createHash("sha256");
  const digests = new Map([[0, hash.copy().digest("hex")]]);
  const maximum = targets.at(-1) ?? 0;
  for (let blockIndex = 1; blockIndex <= maximum; blockIndex += 1) {
    hash.update(block);
    if (targetSet.has(blockIndex)) digests.set(blockIndex, hash.copy().digest("hex"));
  }
  return digests;
}

async function processTreeRss(rootPid) {
  const discovered = new Set();
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (!Number.isInteger(pid) || discovered.has(pid)) continue;
    discovered.add(pid);
    try {
      // Firefox can spawn child processes from a non-leader thread.
      const threads = await readdir(`/proc/${pid}/task`);
      const childLists = await Promise.all(threads.map((tid) =>
        readFile(`/proc/${pid}/task/${tid}/children`, "utf8").catch(() => ""),
      ));
      for (const children of childLists) {
        for (const child of children.trim().split(/\s+/)) {
          if (child) pending.push(Number(child));
        }
      }
    } catch {
      // Processes can exit while /proc is being sampled.
    }
  }

  let rssBytes = 0;
  let processCount = 0;
  for (const pid of discovered) {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      if (match) {
        rssBytes += Number(match[1]) * 1024;
        processCount += 1;
      }
    } catch {
      // Processes can exit between tree discovery and status reads.
    }
  }
  return { rssBytes, processCount };
}

function rssObservation(sample) {
  if (!sample) return null;
  return {
    rssBytes: sample.rssBytes,
    rssMiB: Number((sample.rssBytes / MIB).toFixed(3)),
    processCount: sample.processCount,
    phase: sample.phase,
    millisecondsFromSamplerStart: Number(sample.millisecondsFromSamplerStart.toFixed(3)),
  };
}

function createRssSampler(rootPid) {
  if (process.platform !== "linux") {
    return {
      supported: false,
      reason: "Browser process-tree RSS collection is implemented only for Linux /proc.",
      setPhase() {},
      start() {},
      async sample() { return null; },
      async stop() {},
      report() { return null; },
    };
  }
  if (!rootPid) {
    return {
      supported: false,
      reason: "Playwright BrowserServer.process() did not expose a browser PID.",
      setPhase() {},
      start() {},
      async sample() { return null; },
      async stop() {},
      report() { return null; },
    };
  }

  const startedAt = performance.now();
  let phase = null;
  let interval = null;
  let inFlight = null;
  let samplesDuringOperations = 0;
  let periodicSamplesDuringOperations = 0;
  let peak = null;
  let postOperation = null;
  let postWorkerTermination = null;

  const sample = async (requestedPhase = phase, kind = "explicit") => {
    if (inFlight) {
      if (kind === "periodic") return inFlight;
      await inFlight;
    }
    inFlight = (async () => {
      const values = await processTreeRss(rootPid);
      const observation = {
        ...values,
        phase: requestedPhase ?? "idle",
        millisecondsFromSamplerStart: performance.now() - startedAt,
      };
      if (requestedPhase && !requestedPhase.startsWith("post-")) {
        samplesDuringOperations += 1;
        if (kind === "periodic") periodicSamplesDuringOperations += 1;
        if (!peak || observation.rssBytes > peak.rssBytes) peak = observation;
      }
      if (requestedPhase === "post-operation") postOperation = observation;
      if (requestedPhase === "post-worker-termination") postWorkerTermination = observation;
      return observation;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };

  return {
    supported: true,
    reason: null,
    setPhase(value) { phase = value; },
    start() {
      interval = setInterval(() => {
        if (phase) void sample(phase, "periodic");
      }, RSS_SAMPLE_INTERVAL_MS);
      interval.unref();
    },
    sample,
    async stop() {
      clearInterval(interval);
      interval = null;
      if (inFlight) await inFlight;
    },
    report() {
      return {
        supported: true,
        metric: "browser process-tree RSS",
        browserRootPid: rootPid,
        samplingIntervalMs: RSS_SAMPLE_INTERVAL_MS,
        samplesDuringOperations,
        periodicSamplesDuringOperations,
        peakDuringOperations: rssObservation(peak),
        postOperationBrowserProcessTreeRss: rssObservation(postOperation),
        postWorkerTerminationBrowserProcessTreeRss: rssObservation(postWorkerTermination),
        caveat: "RSS is summed across the browser process tree. Shared physical pages can be counted once per process, so this is neither unique physical memory nor JavaScript heap usage.",
        garbageCollection: {
          requested: false,
          note: "No forced browser GC was requested. Post-operation RSS is observational; ordinary memory is not guaranteed to be reclaimed immediately.",
        },
      };
    },
  };
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function verifyDigest(actual, expected, label) {
  if (typeof actual !== "string" || actual.toLowerCase() !== expected) {
    throw new Error(`${label} digest mismatch: expected ${expected}, received ${String(actual)}`);
  }
}

function formatSample(iteration, sequencePosition, elapsedMs, digest, bytes) {
  return {
    iteration,
    sequencePosition,
    bytes,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    throughputMiBPerSecond: Number(((bytes / MIB) / (elapsedMs / 1000)).toFixed(3)),
    digest,
    verified: true,
  };
}

function summarizeSamples(samples) {
  return {
    samples,
    medianElapsedMs: Number(median(samples.map((sample) => sample.elapsedMs)).toFixed(3)),
    medianThroughputMiBPerSecond: Number(median(samples.map((sample) => sample.throughputMiBPerSecond)).toFixed(3)),
  };
}

async function installBrowserHarness(page, workerUrl) {
  await page.evaluate(
    ({ workerUrl: builtWorkerUrl, bytesPerMiB }) => {
      const bytes = new Uint8Array(bytesPerMiB);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = (Math.imul(index, 31) + Math.imul(index >>> 8, 17) + 0x5a) & 0xff;
      }
      const state = {
        workerUrl: builtWorkerUrl,
        worker: null,
        nextId: 1,
        block: new Blob([bytes], { type: "application/octet-stream" }),
        file: null,
      };

      globalThis.__hashBenchmark = {
        prepare(sizeMiB) {
          const parts = new Array(sizeMiB).fill(state.block);
          state.file = new File(parts, `generated-${sizeMiB}MiB.bin`, {
            type: "application/octet-stream",
            lastModified: 0,
          });
          if (state.file.size !== sizeMiB * bytesPerMiB) {
            throw new Error(`Fixture size mismatch: expected ${sizeMiB * bytesPerMiB}, created ${state.file.size}`);
          }
          return state.file.size;
        },
        async wasm() {
          if (!state.file) throw new Error("No fixture is prepared");
          const startedAt = performance.now();
          if (!state.worker) state.worker = new Worker(state.workerUrl, { type: "module" });
          const worker = state.worker;
          const id = state.nextId++;
          return await new Promise((resolve, reject) => {
            const cleanup = () => {
              worker.removeEventListener("message", onMessage);
              worker.removeEventListener("error", onError);
              worker.removeEventListener("messageerror", onMessageError);
            };
            const onError = (event) => {
              cleanup();
              reject(new Error(`Hash worker failed: ${event.message || "unknown worker error"}`));
            };
            const onMessageError = () => {
              cleanup();
              reject(new Error("Hash worker returned an unreadable message"));
            };
            const onMessage = (event) => {
              const message = event.data;
              if (!message || message.id !== id) return;
              if (message.type === "progress") return;
              cleanup();
              if (message.type === "error") {
                reject(new Error(`Hash worker error (${message.code ?? "unknown"}): ${message.message ?? "no detail"}`));
                return;
              }
              if (message.type !== "result" || !Array.isArray(message.hashes)) {
                reject(new Error(`Unexpected hash worker response: ${JSON.stringify(message)}`));
                return;
              }
              const hash = message.hashes.find((item) => item?.id === "sha256");
              if (!hash || typeof hash.hex !== "string") {
                reject(new Error(`SHA-256 is missing from hash worker response: ${JSON.stringify(message)}`));
                return;
              }
              resolve({ digest: hash.hex.toLowerCase(), elapsedMs: performance.now() - startedAt });
            };
            worker.addEventListener("message", onMessage);
            worker.addEventListener("error", onError);
            worker.addEventListener("messageerror", onMessageError);
            worker.postMessage({ type: "start", id, algorithms: ["sha256"], file: state.file });
          });
        },
        async webCrypto() {
          if (!state.file) throw new Error("No fixture is prepared");
          const startedAt = performance.now();
          const input = await state.file.arrayBuffer();
          const digestBuffer = await crypto.subtle.digest("SHA-256", input);
          const digest = Array.from(new Uint8Array(digestBuffer), (value) => value.toString(16).padStart(2, "0")).join("");
          return { digest, elapsedMs: performance.now() - startedAt };
        },
        terminate() {
          state.worker?.terminate();
          state.worker = null;
          state.file = null;
        },
      };
    },
    { workerUrl, bytesPerMiB: MIB },
  );
}

async function prepareFixture(page, sizeMiB) {
  return page.evaluate((size) => globalThis.__hashBenchmark.prepare(size), sizeMiB);
}

async function runBackend(page, backend) {
  return page.evaluate((selectedBackend) => globalThis.__hashBenchmark[selectedBackend](), backend);
}

async function trackedOperation(sampler, phase, operation) {
  sampler.setPhase(phase);
  const pending = operation();
  await sampler.sample(phase, "explicit");
  try {
    return await pending;
  } finally {
    sampler.setPhase(null);
  }
}

async function playwrightVersion() {
  const packagePath = require.resolve("@playwright/test/package.json");
  return JSON.parse(await readFile(packagePath, "utf8")).version;
}

async function runBenchmark(options, workerAsset) {
  const browserType = BROWSER_TYPES[options.browser];
  const expectedDigests = computeExpectedDigests(options.sizesMiB);
  const basePath = JSON.parse(await readFile(path.join(DIST, "manifest.webmanifest"), "utf8")).scope;
  const benchmarkStartedAt = performance.now();
  let localServer = null;
  let browserServer = null;
  let browser = null;
  let context = null;
  let page = null;
  let sampler = null;
  let primaryError = null;
  let report = null;

  try {
    let pageUrl;
    let serverMode;
    if (options.previewUrl) {
      pageUrl = options.previewUrl;
      serverMode = "existing-loopback-preview";
    } else {
      localServer = await startDistServer(basePath);
      pageUrl = localServer.pageUrl;
      serverMode = "short-lived-127.0.0.1-static-server";
    }
    const pageOrigin = new URL(pageUrl).origin;
    const workerUrl = new URL(`${basePath}_astro/${encodeURIComponent(workerAsset)}`, pageOrigin).href;

    browserServer = await browserType.launchServer({ headless: true });
    const browserProcess = browserServer.process();
    browser = await browserType.connect(browserServer.wsEndpoint());
    const browserVersion = browser.version();
    context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.protocol === "data:" || requestUrl.origin === pageOrigin) await route.continue();
      else await route.abort("blockedbyclient");
    });
    page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    await installBrowserHarness(page, workerUrl);

    sampler = createRssSampler(browserProcess?.pid ?? null);
    sampler.start();

    await prepareFixture(page, 0);
    const emptyDigest = expectedDigests.get(0);
    const coldWasm = await trackedOperation(sampler, "cold-wasm-worker-initialization", () => runBackend(page, "wasm"));
    verifyDigest(coldWasm.digest, emptyDigest, "Cold WASM worker initialization");
    const coldWebCrypto = await trackedOperation(sampler, "cold-web-crypto-initialization", () => runBackend(page, "webCrypto"));
    verifyDigest(coldWebCrypto.digest, emptyDigest, "Cold Web Crypto initialization");

    const warmupBytes = await prepareFixture(page, 1);
    const warmupExpected = expectedDigests.get(1);
    const warmupWasm = await trackedOperation(sampler, "warmup-wasm", () => runBackend(page, "wasm"));
    verifyDigest(warmupWasm.digest, warmupExpected, "WASM warm-up");
    const warmupWebCrypto = await trackedOperation(sampler, "warmup-web-crypto", () => runBackend(page, "webCrypto"));
    verifyDigest(warmupWebCrypto.digest, warmupExpected, "Web Crypto warm-up");

    const results = [];
    for (const sizeMiB of options.sizesMiB) {
      const bytes = await prepareFixture(page, sizeMiB);
      const expectedSha256 = expectedDigests.get(sizeMiB);
      const wasmSamples = [];
      const webCryptoSamples = [];
      for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
        const order = iteration % 2 === 1 ? ["wasm", "webCrypto"] : ["webCrypto", "wasm"];
        for (let position = 0; position < order.length; position += 1) {
          const backend = order[position];
          const phase = `measured-${backend}-${sizeMiB}MiB-iteration-${iteration}`;
          const measurement = await trackedOperation(sampler, phase, () => runBackend(page, backend));
          verifyDigest(measurement.digest, expectedSha256, `${backend} ${sizeMiB} MiB iteration ${iteration}`);
          const sample = formatSample(iteration, position + 1, measurement.elapsedMs, measurement.digest, bytes);
          if (backend === "wasm") wasmSamples.push(sample);
          else webCryptoSamples.push(sample);
        }
      }
      results.push({
        sizeMiB,
        bytes,
        expectedSha256,
        wasmWorker: summarizeSamples(wasmSamples),
        webCrypto: summarizeSamples(webCryptoSamples),
      });
    }

    sampler.setPhase(null);
    await sampler.sample("post-operation", "explicit");
    await page.evaluate(() => globalThis.__hashBenchmark?.terminate());
    await new Promise((resolve) => setTimeout(resolve, 100));
    await sampler.sample("post-worker-termination", "explicit");
    await sampler.stop();

    const cpus = os.cpus();
    report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      benchmark: "SHA-256 Rust/WASM worker versus Web Crypto",
      configuration: {
        browser: options.browser,
        sizesMiB: options.sizesMiB,
        iterations: options.iterations,
        measuredRunsAreSequential: true,
        backendOrder: "WASM then Web Crypto on odd trials; Web Crypto then WASM on even trials",
        serverMode,
        previewUrl: pageUrl,
        workerAsset: `${basePath}_astro/${workerAsset}`,
      },
      fixture: {
        generatedOnly: true,
        uploaded: false,
        bytesPerBlock: MIB,
        construction: "One deterministic 1 MiB Blob is repeated as File parts; the WASM worker reads 1 MiB slices without a benchmark-side full-file buffer.",
        byteAtIndexWithinBlock: "(index * 31 + (index >>> 8) * 17 + 0x5a) & 0xff",
        expectedDigestImplementation: "Node.js crypto.createHash('sha256') updated incrementally with the same deterministic 1 MiB block",
      },
      measurement: {
        clock: "browser performance.now() wall time",
        wasmWorkerScope: "Immediately before first Worker construction/postMessage through the matching result message; warmed trials include worker dispatch, File slice reads, and hashing.",
        webCryptoScope: "Immediately before File.arrayBuffer() through crypto.subtle.digest('SHA-256') completion.",
        digestVerification: "Every cold, warm-up, and measured digest is compared with an independently computed Node.js SHA-256 digest; a mismatch aborts the run.",
        coldInitialization: {
          fixtureBytes: 0,
          wasmWorkerElapsedMs: Number(coldWasm.elapsedMs.toFixed(3)),
          webCryptoElapsedMs: Number(coldWebCrypto.elapsedMs.toFixed(3)),
          note: "Cold timings use an empty generated File to isolate first-call initialization and dispatch from bulk input throughput.",
        },
        warmup: {
          separateFromMeasuredRuns: true,
          fixtureBytes: warmupBytes,
          wasmWorkerElapsedMs: Number(warmupWasm.elapsedMs.toFixed(3)),
          webCryptoElapsedMs: Number(warmupWebCrypto.elapsedMs.toFixed(3)),
          verified: true,
        },
      },
      results,
      memory: sampler.report() ?? {
        supported: false,
        metric: "browser process-tree RSS",
        reason: sampler.reason,
        caveat: "No memory value is reported when browser process-tree RSS cannot be observed through Linux /proc.",
      },
      metadata: {
        nodeVersion: process.version,
        playwrightVersion: await playwrightVersion(),
        browserName: options.browser,
        browserVersion,
        browserProcessPidSource: "Playwright BrowserServer.process() public API",
        operatingSystem: {
          platform: process.platform,
          release: os.release(),
          architecture: process.arch,
        },
        cpu: {
          model: cpus[0]?.model ?? null,
          logicalProcessorCount: cpus.length,
        },
      },
      totalBenchmarkWallTimeMs: Number((performance.now() - benchmarkStartedAt).toFixed(3)),
    };
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = [];
    if (sampler) {
      try { await sampler.stop(); } catch (error) { cleanupErrors.push(error); }
    }
    if (page) {
      try { await page.evaluate(() => globalThis.__hashBenchmark?.terminate()); } catch (error) { cleanupErrors.push(error); }
    }
    if (context) {
      try { await context.close(); } catch (error) { cleanupErrors.push(error); }
    }
    if (browserServer) {
      try { await browserServer.close(); } catch (error) { cleanupErrors.push(error); }
    } else if (browser) {
      try { await browser.close(); } catch (error) { cleanupErrors.push(error); }
    }
    if (localServer) {
      try { await closeHttpServer(localServer.server); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) {
      const cleanupError = new AggregateError(cleanupErrors, "Benchmark resource cleanup failed");
      if (primaryError) primaryError = new AggregateError([primaryError, cleanupError], "Benchmark failed and cleanup also failed");
      else primaryError = cleanupError;
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
  const workerAsset = await discoverHashWorker();
  process.stderr.write(
    `Benchmarking ${workerAsset} in ${options.browser}: ${options.sizesMiB.join(",")} MiB, ${options.iterations} measured trial(s) per backend\n`,
  );
  const report = await runBenchmark(options, workerAsset);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(path.dirname(options.output), { recursive: true });
    await writeFile(options.output, json, "utf8");
    process.stderr.write(`Wrote benchmark report to ${options.output}\n`);
  }
  process.stdout.write(json);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
