/* tslint:disable */
/* eslint-disable */

export function base32_decode(input: string, alphabet: string, padding: string, allow_whitespace: boolean): Uint8Array;

export function base32_encode(bytes: Uint8Array, alphabet: string, padding: string, _case?: string | null): string;

export function base58_decode(input: string, alphabet: string, allow_whitespace: boolean): Uint8Array;

export function base58_encode(bytes: Uint8Array, alphabet: string): string;

export function base64_decode(input: string, alphabet: string, padding: string, allow_whitespace: boolean): Uint8Array;

export function base64_encode(bytes: Uint8Array, alphabet: string, padding: string, line_wrap?: number | null): string;

export function decode_bytes_to_text(bytes: Uint8Array, charset: string): string;

export function encode_text_to_bytes(text: string, charset: string): Uint8Array;

export function hex_decode(input: string, ignore_whitespace: boolean, allow_separators: boolean, allow_0x: boolean): Uint8Array;

export function hex_encode(bytes: Uint8Array, upper: boolean): string;

export function url_decode(input: string, mode: string): Uint8Array;

export function url_encode(bytes: Uint8Array, mode: string): string;

export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly base32_decode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly base32_encode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly base58_decode: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly base58_encode: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly base64_decode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly base64_encode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly decode_bytes_to_text: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly encode_text_to_bytes: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly hex_decode: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly hex_encode: (a: number, b: number, c: number) => [number, number];
    readonly url_decode: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly url_encode: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly version: () => [number, number];
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
