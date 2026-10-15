/**
 * Hex viewer worker messages. The File is structured-cloned (the bytes stay
 * in the blob store). Search and entropy are the only jobs; row windows are
 * read on the page with File.slice.
 */
import type { EntropySample } from "./hex-viewer.ts";

export type HexViewerRequest =
  | { type: "search"; file: File; needle: Uint8Array }
  | { type: "entropy"; file: File };

export type HexViewerSuccess =
  | { kind: "search"; offsets: number[]; capped: boolean }
  | { kind: "entropy"; samples: EntropySample[]; average: number; sampled: boolean };
