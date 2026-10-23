/**
 * Page-side handle for the file diff worker. One worker keeps the comparison session until
 * cancel, clear or a new comparison terminates it.
 */
import { createJobWorker, type JobProgress } from "@/scripts/wasm/job-worker";
import type { FileDiffTextOptions } from "@/tools/large-file-diff";
import type {
  FileDiffBinaryRow,
  FileDiffCompareResult,
  FileDiffMode,
  FileDiffRequest,
  FileDiffSuccess,
  FileDiffTextRow,
} from "@/tools/large-file-diff-protocol";

export interface FileDiffWorkerClient {
  compare(fileA: File, fileB: File, mode: FileDiffMode, text: FileDiffTextOptions, context: number, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<FileDiffCompareResult>;
  layout(sessionId: number, context: number): Promise<{ hunks: number; rows: number }>;
  rows(sessionId: number, start: number, count: number): Promise<{ text?: FileDiffTextRow[]; binary?: FileDiffBinaryRow[] }>;
  hunkRow(sessionId: number, hunk: number): Promise<number>;
  exportReport(sessionId: number, stream: MessagePort, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<Extract<FileDiffSuccess, { kind: "export" }>>;
  terminate(): void;
}

function resultOfKind<K extends FileDiffSuccess["kind"]>(result: FileDiffSuccess, kind: K): Extract<FileDiffSuccess, { kind: K }> {
  if (result.kind !== kind) throw new Error(`Unexpected file diff response: ${result.kind}`);
  return result as Extract<FileDiffSuccess, { kind: K }>;
}

export function createFileDiffWorker(): FileDiffWorkerClient {
  const worker = createJobWorker<FileDiffRequest, FileDiffSuccess>(
    () => new Worker(new URL("../workers/large-file-diff.worker.ts", import.meta.url), { type: "module" }),
  );
  return {
    async compare(fileA, fileB, mode, text, context, signal, onProgress) {
      const { kind: _kind, ...result } = resultOfKind(await worker.run({ type: "compare", fileA, fileB, mode, text, context }, [], signal, onProgress), "compare");
      return result as FileDiffCompareResult;
    },
    async layout(sessionId, context) {
      const { hunks, rows } = resultOfKind(await worker.run({ type: "layout", sessionId, context }), "layout");
      return { hunks, rows };
    },
    async rows(sessionId, start, count) {
      const { text, binary } = resultOfKind(await worker.run({ type: "rows", sessionId, start, count }), "rows");
      return { text, binary };
    },
    async hunkRow(sessionId, hunk) {
      return resultOfKind(await worker.run({ type: "hunk-row", sessionId, hunk }), "hunk-row").row;
    },
    async exportReport(sessionId, stream, signal, onProgress) {
      return resultOfKind(await worker.run({ type: "export", sessionId, stream }, [stream], signal, onProgress), "export");
    },
    terminate() {
      worker.terminate();
    },
  };
}
