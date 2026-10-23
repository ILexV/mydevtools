/// <reference lib="webworker" />
/**
 * File diff worker. Hashes both files, diffs the lines or compares the bytes, and keeps the
 * session for table windows and the streamed report. Cancel terminates this worker, which
 * drops both file handles, the hashes and any half-written download.
 */
import { classifyWorkerError, createWorkerByteWriter } from "@/scripts/wasm/worker-protocol";
import {
  DiffLayout,
  DiffRowKind,
  FILE_DIFF_MAX_CONTEXT,
  FILE_DIFF_MAX_EXPORT_LINE_BYTES,
  FILE_DIFF_RANGE_PREVIEW_BYTES,
  FileDiffError,
  LineCursor,
  clipLine,
  compareBinary,
  diffLineHashes,
  formatHexOffset,
  formatHunkHeader,
  hexPreview,
  indexLines,
  looksBinary,
  stripLineEnd,
  type BinaryDiffResult,
  type DiffRegions,
  type LineIndex,
  type ReadRange,
} from "@/tools/large-file-diff";
import type {
  FileDiffBinaryRow,
  FileDiffRequest,
  FileDiffSuccess,
  FileDiffTextRow,
  FileDiffWorkerMessage,
} from "@/tools/large-file-diff-protocol";

interface TextSession {
  mode: "text";
  id: number;
  fileA: File;
  fileB: File;
  indexA: LineIndex;
  indexB: LineIndex;
  regions: DiffRegions;
  layout: DiffLayout;
  cursorA: LineCursor;
  cursorB: LineCursor;
}

interface BinarySession {
  mode: "binary";
  id: number;
  fileA: File;
  fileB: File;
  result: BinaryDiffResult;
}

type Session = TextSession | BinarySession;

const HEAD_BYTES = 8192;
const MAX_ROWS = 500;
/** Bytes read for one table line before clipping; enough for the preview in any encoding. */
const ROW_LINE_BYTES = 8192;
const EXPORT_CHUNK_BYTES = 1024 * 1024;
const BLOCK_BYTES = 64 * 1024;
const LIMIT_CODES = new Set(["too-many-lines", "line-too-long"]);

let session: Session | null = null;
let nextSessionId = 1;

function post(message: FileDiffWorkerMessage): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message);
}

function progress(id: number, processed: number, total: number, started: number): void {
  post({ id, type: "progress", processed, total, elapsedMs: performance.now() - started });
}

function reader(file: Blob): ReadRange {
  return async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** Reads small previews through one cached 64 KiB block, so neighbouring ranges share a read. */
function blockReader(file: Blob): (offset: number, length: number) => Promise<Uint8Array> {
  let blockStart = -1;
  let block = new Uint8Array(0);
  return async (offset, length) => {
    const end = Math.min(file.size, offset + length);
    if (offset >= end) return new Uint8Array(0);
    if (blockStart < 0 || offset < blockStart || end > blockStart + block.length) {
      blockStart = offset;
      block = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + Math.max(BLOCK_BYTES, length))).arrayBuffer());
    }
    return block.subarray(offset - blockStart, end - blockStart);
  };
}

function requireSession(id: number): Session {
  if (!session || session.id !== id) throw new FileDiffError("session-missing", "The comparison is no longer available");
  return session;
}

function sideSummary(file: File, index: LineIndex) {
  return {
    name: file.name,
    size: file.size,
    lines: index.lines,
    encoding: index.encoding.label,
    lf: index.lf,
    crlf: index.crlf,
    finalNewline: index.finalNewline,
  };
}

function clampContext(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(FILE_DIFF_MAX_CONTEXT, Math.floor(value))) : 3;
}

async function compare(id: number, request: Extract<FileDiffRequest, { type: "compare" }>): Promise<FileDiffSuccess> {
  const started = performance.now();
  session = null;
  const { fileA, fileB } = request;
  const readA = reader(fileA);
  const readB = reader(fileB);
  let mode = request.mode;
  if (mode === "auto") {
    const [headA, headB] = await Promise.all([readA(0, Math.min(fileA.size, HEAD_BYTES)), readB(0, Math.min(fileB.size, HEAD_BYTES))]);
    mode = looksBinary(headA) || looksBinary(headB) ? "binary" : "text";
  }
  const sessionId = nextSessionId++;

  if (mode === "binary") {
    const result = await compareBinary(fileA.size, fileB.size, readA, readB, (processed, total) => progress(id, processed, total, started));
    session = { mode: "binary", id: sessionId, fileA, fileB, result };
    return {
      kind: "compare",
      mode: "binary",
      sessionId,
      identical: result.identical,
      binary: {
        sizeA: result.sizeA,
        sizeB: result.sizeB,
        rangeCount: result.rangeCount,
        keptRanges: result.offsets.length,
        differingBytes: result.differingBytes,
        firstDifference: result.firstDifference,
      },
    };
  }

  const total = Math.max(1, fileA.size + fileB.size);
  progress(id, 0, total, started);
  const indexA = await indexLines(fileA.size, readA, request.text, (done) => progress(id, done, total, started));
  const indexB = await indexLines(fileB.size, readB, request.text, (done) => progress(id, fileA.size + done, total, started));
  // Indexing is complete: the page shows the line-matching stage while the diff runs.
  progress(id, total, total, started);
  const diff = diffLineHashes(indexA, indexB);
  const layout = new DiffLayout(diff.regions, indexA.lines, indexB.lines, clampContext(request.context));
  session = {
    mode: "text",
    id: sessionId,
    fileA,
    fileB,
    indexA,
    indexB,
    regions: diff.regions,
    layout,
    cursorA: new LineCursor(indexA, readA),
    cursorB: new LineCursor(indexB, readB),
  };
  return {
    kind: "compare",
    mode: "text",
    sessionId,
    identical: diff.regions.count === 0,
    text: {
      a: sideSummary(fileA, indexA),
      b: sideSummary(fileB, indexB),
      removed: diff.removed,
      added: diff.added,
      hunks: layout.hunks,
      rows: layout.rows,
      approximate: diff.approximate,
    },
  };
}

/** Lines `wanted` (ascending, unique) of one file, decoded and clipped for the table. */
async function previewLines(cursor: LineCursor, index: LineIndex, wanted: readonly number[]): Promise<Map<number, string>> {
  const decoder = new TextDecoder(index.encoding.label, { ignoreBOM: true });
  const out = new Map<number, string>();
  for (const line of wanted) {
    await cursor.seek(line);
    const read = await cursor.next(ROW_LINE_BYTES);
    if (!read) continue;
    const clipped = clipLine(stripLineEnd(decoder.decode(read.bytes)));
    out.set(line, read.truncated && !clipped.truncated ? `${clipped.text}…` : clipped.text);
  }
  return out;
}

async function textRows(current: TextSession, start: number, count: number): Promise<FileDiffTextRow[]> {
  const { layout, indexA, indexB } = current;
  const end = Math.min(layout.rows, start + count);
  const rows = [];
  const wantA = new Set<number>();
  const wantB = new Set<number>();
  for (let row = start; row < end; row++) {
    const item = layout.row(row);
    rows.push(item);
    if (item.a >= 0) wantA.add(item.a);
    if (item.b >= 0 && item.kind !== DiffRowKind.Context) wantB.add(item.b);
  }
  const sorted = (set: Set<number>) => [...set].sort((left, right) => left - right);
  const textA = await previewLines(current.cursorA, indexA, sorted(wantA));
  const textB = await previewLines(current.cursorB, indexB, sorted(wantB));
  return rows.map((item) => {
    if (item.kind === DiffRowKind.Header) {
      return { kind: item.kind, a: 0, b: 0, text: formatHunkHeader(layout.header(item.hunk)), noNewline: false };
    }
    const fromA = item.kind !== DiffRowKind.Added;
    const line = fromA ? item.a : item.b;
    const index = fromA ? indexA : indexB;
    const noNewline = item.kind === DiffRowKind.Context
      ? (item.a === indexA.lines - 1 && !indexA.finalNewline) || (item.b === indexB.lines - 1 && !indexB.finalNewline)
      : line === index.lines - 1 && !index.finalNewline;
    return {
      kind: item.kind,
      a: item.a + 1,
      b: item.b + 1,
      text: (fromA ? textA : textB).get(line) ?? "",
      noNewline,
    };
  });
}

async function binaryRows(current: BinarySession, start: number, count: number): Promise<FileDiffBinaryRow[]> {
  const { result } = current;
  const end = Math.min(result.offsets.length, start + count);
  const readA = blockReader(current.fileA);
  const readB = blockReader(current.fileB);
  const rows: FileDiffBinaryRow[] = [];
  for (let index = start; index < end; index++) {
    const offset = result.offsets[index];
    const length = result.lengths[index];
    const take = Math.min(length, FILE_DIFF_RANGE_PREVIEW_BYTES);
    rows.push({ offset, length, a: hexPreview(await readA(offset, take)), b: hexPreview(await readB(offset, take)) });
  }
  return rows;
}

/** Buffers UTF-8 output and hands the writer bounded chunks. */
function chunkedOutput(write: (bytes: Uint8Array) => Promise<void>) {
  const encoder = new TextEncoder();
  const buffer = new Uint8Array(EXPORT_CHUNK_BYTES);
  let used = 0;
  const flush = async () => {
    if (used === 0) return;
    await write(buffer.slice(0, used));
    used = 0;
  };
  const bytes = async (data: Uint8Array) => {
    if (used + data.length > buffer.length) await flush();
    if (data.length > buffer.length) {
      await write(data.slice());
      return;
    }
    buffer.set(data, used);
    used += data.length;
  };
  return {
    bytes,
    text: (value: string) => bytes(encoder.encode(value)),
    flush,
  };
}

const NEWLINE = new Uint8Array([0x0a]);

/** Unified diff of the whole comparison, `diff -u` style; non-UTF-8 lines are re-encoded as UTF-8. */
async function exportText(id: number, current: TextSession, write: (bytes: Uint8Array) => Promise<void>): Promise<number> {
  const started = performance.now();
  const { layout, indexA, indexB } = current;
  const out = chunkedOutput(write);
  const cursorA = new LineCursor(indexA, reader(current.fileA), 1024 * 1024);
  const cursorB = new LineCursor(indexB, reader(current.fileB), 1024 * 1024);
  const encoder = new TextEncoder();
  const decoderA = indexA.encoding.kind === "utf-8" ? null : new TextDecoder(indexA.encoding.label, { ignoreBOM: true });
  const decoderB = indexB.encoding.kind === "utf-8" ? null : new TextDecoder(indexB.encoding.label, { ignoreBOM: true });
  const line = async (cursor: LineCursor, decoder: TextDecoder | null, number: number) => {
    await cursor.seek(number);
    const read = await cursor.next(FILE_DIFF_MAX_EXPORT_LINE_BYTES);
    if (!read) return new Uint8Array(0);
    if (read.truncated) throw new FileDiffError("line-too-long", "A line is longer than the export limit");
    return decoder ? encoder.encode(decoder.decode(read.bytes)) : read.bytes;
  };
  const noNewline = "\\ No newline at end of file\n";
  await out.text(`--- ${current.fileA.name}\n+++ ${current.fileB.name}\n`);
  const total = Math.max(1, layout.rows);
  for (let row = 0; row < layout.rows; row++) {
    const item = layout.row(row);
    if (item.kind === DiffRowKind.Header) {
      await out.text(`${formatHunkHeader(layout.header(item.hunk))}\n`);
    } else if (item.kind === DiffRowKind.Context) {
      await out.text(" ");
      await out.bytes(await line(cursorA, decoderA, item.a));
      await out.bytes(NEWLINE);
      if (item.a === indexA.lines - 1 && !indexA.finalNewline) await out.text(noNewline);
    } else if (item.kind === DiffRowKind.Removed) {
      await out.text("-");
      await out.bytes(await line(cursorA, decoderA, item.a));
      await out.bytes(NEWLINE);
      if (item.a === indexA.lines - 1 && !indexA.finalNewline) await out.text(noNewline);
    } else {
      await out.text("+");
      await out.bytes(await line(cursorB, decoderB, item.b));
      await out.bytes(NEWLINE);
      if (item.b === indexB.lines - 1 && !indexB.finalNewline) await out.text(noNewline);
    }
    if ((row & 4095) === 0) progress(id, row, total, started);
  }
  await out.flush();
  progress(id, total, total, started);
  return layout.hunks;
}

/** CSV of the kept byte ranges with up to 16 bytes of each side. */
async function exportBinary(id: number, current: BinarySession, write: (bytes: Uint8Array) => Promise<void>): Promise<number> {
  const started = performance.now();
  const { result } = current;
  const out = chunkedOutput(write);
  const readA = blockReader(current.fileA);
  const readB = blockReader(current.fileB);
  await out.text("offset,offset_hex,length,bytes_a,bytes_b\n");
  const total = Math.max(1, result.offsets.length);
  for (let index = 0; index < result.offsets.length; index++) {
    const offset = result.offsets[index];
    const length = result.lengths[index];
    const take = Math.min(length, FILE_DIFF_RANGE_PREVIEW_BYTES);
    const a = hexPreview(await readA(offset, take));
    const b = hexPreview(await readB(offset, take));
    await out.text(`${offset},${formatHexOffset(offset)},${length},${a},${b}\n`);
    if ((index & 1023) === 0) progress(id, index, total, started);
  }
  await out.flush();
  progress(id, total, total, started);
  return result.offsets.length;
}

async function handle(id: number, request: FileDiffRequest): Promise<void> {
  try {
    let result: FileDiffSuccess;
    switch (request.type) {
      case "compare":
        result = await compare(id, request);
        break;
      case "layout": {
        const current = requireSession(request.sessionId);
        if (current.mode !== "text") throw new FileDiffError("invalid", "Not a text comparison");
        current.layout = new DiffLayout(current.regions, current.indexA.lines, current.indexB.lines, clampContext(request.context));
        result = { kind: "layout", sessionId: current.id, hunks: current.layout.hunks, rows: current.layout.rows };
        break;
      }
      case "rows": {
        const current = requireSession(request.sessionId);
        const count = Math.max(0, Math.min(MAX_ROWS, request.count));
        result = current.mode === "text"
          ? { kind: "rows", sessionId: current.id, start: request.start, text: await textRows(current, request.start, count) }
          : { kind: "rows", sessionId: current.id, start: request.start, binary: await binaryRows(current, request.start, count) };
        break;
      }
      case "hunk-row": {
        const current = requireSession(request.sessionId);
        if (current.mode !== "text") throw new FileDiffError("invalid", "Not a text comparison");
        result = { kind: "hunk-row", sessionId: current.id, row: current.layout.hunkStartRow(request.hunk) };
        break;
      }
      case "export": {
        const current = requireSession(request.sessionId);
        const writer = createWorkerByteWriter(request.stream);
        const write = (bytes: Uint8Array) => writer.write(bytes);
        const rowCount = current.mode === "text" ? await exportText(id, current, write) : await exportBinary(id, current, write);
        writer.close();
        result = { kind: "export", sessionId: current.id, extension: current.mode === "text" ? "diff" : "csv", rowCount };
        break;
      }
    }
    post({ id, ok: true, ...result });
  } catch (error) {
    const diffError = error instanceof FileDiffError ? error : null;
    if (diffError && request.type === "compare") session = null;
    const fallback = diffError ? (LIMIT_CODES.has(diffError.code) ? "input-too-large" : "unknown") : "worker-failed";
    const classified = classifyWorkerError(error, fallback);
    post({ id, ok: false, code: classified.code, message: diffError?.code ?? classified.message });
  }
}

let queue = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<FileDiffRequest & { id: number }>) => {
  const { id, ...request } = event.data;
  queue = queue.then(() => handle(id, request as FileDiffRequest));
});

export {};
