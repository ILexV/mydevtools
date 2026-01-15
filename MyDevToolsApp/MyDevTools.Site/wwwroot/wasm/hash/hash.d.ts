/* tslint:disable */
/* eslint-disable */

/**
 * Streaming hasher for large inputs (files).
 *
 * Intended usage from JS:
 * - `const h = new hash.Hasher("sha256");`
 * - `h.update(chunkUint8Array);` for each chunk
 * - `const hex = h.finalize();`
 */
export class Hasher {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns normalized algorithm id (for debugging/telemetry).
     */
    algorithm(): string;
    /**
     * Finalize and return hex string (lowercase).
     *
     * Consumes the hasher instance to avoid accidental re-use.
     */
    finalize(): string;
    constructor(algorithm: string);
    /**
     * Update hasher state with the next chunk.
     */
    update(chunk: Uint8Array): void;
}

/**
 * One-shot hashing for small inputs.
 *
 * For large files prefer `Hasher` + chunked updates.
 */
export function hash_bytes(algorithm: string, bytes: Uint8Array): string;

/**
 * One-shot helper for text inputs (UTF-8).
 */
export function hash_text_utf8(algorithm: string, text: string): string;

/**
 * Placeholder hash implementation.
 *
 * This is NOT a real hash yet; it only exists to validate toolchain and module wiring.
 */
export function placeholder_hash(input: string): string;

export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly version: () => [number, number];
    readonly __wbg_hasher_free: (a: number, b: number) => void;
    readonly hasher_new: (a: number, b: number) => [number, number, number];
    readonly hasher_update: (a: number, b: number, c: number) => void;
    readonly hasher_finalize: (a: number) => [number, number];
    readonly hasher_algorithm: (a: number) => [number, number];
    readonly hash_bytes: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly hash_text_utf8: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly placeholder_hash: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
