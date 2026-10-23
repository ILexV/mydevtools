/**
 * Page-side handle for the archive explorer worker. One worker keeps the opened archive until
 * cancel, clear or the next archive terminates it.
 */
import { createJobWorker, type JobProgress } from "@/scripts/wasm/job-worker";
import type {
  ArchiveCreateFormat,
  ArchiveRequest,
  ArchiveRow,
  ArchiveSuccess,
  ArchiveSummary,
  ExtractSummary,
  ExtractTarget,
  SelectAction,
  SelectionSummary,
} from "@/tools/archive-explorer-protocol";

export interface ArchiveWorkerClient {
  open(file: File, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<ArchiveSummary>;
  filter(sessionId: number, query: string): Promise<number>;
  rows(sessionId: number, start: number, count: number): Promise<ArchiveRow[]>;
  select(sessionId: number, action: SelectAction, row?: number): Promise<SelectionSummary>;
  extract(sessionId: number, target: ExtractTarget, destination: { stream?: MessagePort; directory?: FileSystemDirectoryHandle }, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<ExtractSummary>;
  create(files: File[], paths: string[], format: ArchiveCreateFormat, level: number, stream: MessagePort, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<{ entries: number; inputBytes: number; outputBytes: number }>;
  terminate(): void;
}

function resultOfKind<K extends ArchiveSuccess["kind"]>(result: ArchiveSuccess, kind: K): Extract<ArchiveSuccess, { kind: K }> {
  if (result.kind !== kind) throw new Error(`Unexpected archive response: ${result.kind}`);
  return result as Extract<ArchiveSuccess, { kind: K }>;
}

export function createArchiveWorker(): ArchiveWorkerClient {
  const worker = createJobWorker<ArchiveRequest, ArchiveSuccess>(
    () => new Worker(new URL("../workers/archive-explorer.worker.ts", import.meta.url), { type: "module" }),
  );
  return {
    async open(file, signal, onProgress) {
      const { kind: _kind, ...summary } = resultOfKind(await worker.run({ type: "open", file }, [], signal, onProgress), "open");
      return summary;
    },
    async filter(sessionId, query) {
      return resultOfKind(await worker.run({ type: "filter", sessionId, query }), "filter").count;
    },
    async rows(sessionId, start, count) {
      return resultOfKind(await worker.run({ type: "rows", sessionId, start, count }), "rows").rows;
    },
    async select(sessionId, action, row) {
      const { kind: _kind, sessionId: _id, ...selection } = resultOfKind(await worker.run({ type: "select", sessionId, action, row }), "select");
      return selection;
    },
    async extract(sessionId, target, destination, signal, onProgress) {
      const transfer = destination.stream ? [destination.stream] : [];
      const { kind: _kind, sessionId: _id, ...summary } = resultOfKind(
        await worker.run({ type: "extract", sessionId, target, ...destination }, transfer, signal, onProgress),
        "extract",
      );
      return summary;
    },
    async create(files, paths, format, level, stream, signal, onProgress) {
      const { entries, inputBytes, outputBytes } = resultOfKind(
        await worker.run({ type: "create", files, paths, format, level, stream }, [stream], signal, onProgress),
        "create",
      );
      return { entries, inputBytes, outputBytes };
    },
    terminate() {
      worker.terminate();
    },
  };
}
