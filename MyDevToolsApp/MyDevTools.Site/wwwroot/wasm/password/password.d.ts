/* tslint:disable */
/* eslint-disable */

export class PasswordOptions {
    free(): void;
    [Symbol.dispose](): void;
    constructor(length: number, uppercase: boolean, lowercase: boolean, numbers: boolean, special: boolean, special_chars: string);
    length: number;
    lowercase: boolean;
    numbers: boolean;
    special_chars: string;
    special: boolean;
    uppercase: boolean;
}

export function generate_password(options: PasswordOptions): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_passwordoptions_free: (a: number, b: number) => void;
    readonly __wbg_get_passwordoptions_length: (a: number) => number;
    readonly __wbg_set_passwordoptions_length: (a: number, b: number) => void;
    readonly __wbg_get_passwordoptions_uppercase: (a: number) => number;
    readonly __wbg_set_passwordoptions_uppercase: (a: number, b: number) => void;
    readonly __wbg_get_passwordoptions_lowercase: (a: number) => number;
    readonly __wbg_set_passwordoptions_lowercase: (a: number, b: number) => void;
    readonly __wbg_get_passwordoptions_numbers: (a: number) => number;
    readonly __wbg_set_passwordoptions_numbers: (a: number, b: number) => void;
    readonly __wbg_get_passwordoptions_special: (a: number) => number;
    readonly __wbg_set_passwordoptions_special: (a: number, b: number) => void;
    readonly __wbg_get_passwordoptions_special_chars: (a: number) => [number, number];
    readonly __wbg_set_passwordoptions_special_chars: (a: number, b: number, c: number) => void;
    readonly passwordoptions_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly generate_password: (a: number) => [number, number, number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
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
