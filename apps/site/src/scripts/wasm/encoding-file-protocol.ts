/**
 * Encoding file protocol (worker, Stage 7/9). One job at a time per worker.
 * The File arrives via structured clone; the worker reads it in 1 MiB chunks
 * with progress + cooperative cancel, then encodes/decodes in one pass.
 *
 * Chunk-wise streaming encoding (legacy carry logic) is intentionally not
 * replicated: parity holds for valid inputs, and the output is a single string
 * either way. For encode the full bytes are read first (progress shown during
 * read); for decode the full encoded text is read first.
 */
import type { EncodingOptions } from "@/scripts/wasm/encoding-client";
import type { WasmErrorCode } from "@/scripts/wasm/worker-protocol";

export type EncodingWorkerRequest =
  | { type: "start"; id: number; direction: "encode" | "decode"; options: EncodingOptions; file: File }
  | { type: "cancel"; id: number };

export type EncodingWorkerResponse =
  | { type: "progress"; id: number; processed: number; total: number; elapsedMs: number }
  | { type: "result"; id: number; direction: "encode" | "decode"; text: string; bytes?: Uint8Array }
  | { type: "error"; id: number; message: string; code: WasmErrorCode };
