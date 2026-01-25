/* tslint:disable */
/* eslint-disable */

/**
 * Placeholder "format" operation.
 *
 * For now it just trims outer whitespace; later this module will handle JSON/XML/YAML
 * formatting, normalization, validation, and (optionally) conversions.
 */
export function normalize_whitespace(input: string): string;

export function version(): string;

/**
 * YAML beautifier: formats YAML, but comments are not preserved due to library limitations.
 */
export function yaml_format(input: string): string;

/**
 * YAML validator: checks if input is valid YAML.
 */
export function yaml_validate(input: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly normalize_whitespace: (a: number, b: number) => [number, number];
    readonly version: () => [number, number];
    readonly yaml_format: (a: number, b: number) => [number, number, number, number];
    readonly yaml_validate: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
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
