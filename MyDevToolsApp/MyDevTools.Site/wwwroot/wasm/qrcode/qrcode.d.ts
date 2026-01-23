/* tslint:disable */
/* eslint-disable */

/**
 * Decode QR code from image bytes
 * Returns the decoded text content
 */
export function decode_qr(image_bytes: Uint8Array): string;

/**
 * Generate QR code as PNG bytes
 *
 * # Arguments
 * * `data` - Text to encode
 * * `size` - Output image size in pixels
 * * `fg_color` - Foreground color as hex (#RRGGBB)
 * * `bg_color` - Background color as hex (#RRGGBB)
 * * `ec_level` - Error correction level (L, M, Q, H)
 * * `style` - Module style: "square", "dots", or "rounded"
 * * `logo_data` - Optional logo image bytes (PNG/WEBP)
 */
export function generate_qr_png(data: string, size: number, fg_color: string, bg_color: string, ec_level: string, style: string, logo_data?: Uint8Array | null): Uint8Array;

/**
 * Generate QR code as SVG string (for vector output)
 */
export function generate_qr_svg(data: string, fg_color: string, bg_color: string, ec_level: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly decode_qr: (a: number, b: number) => [number, number, number, number];
    readonly generate_qr_png: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => [number, number, number, number];
    readonly generate_qr_svg: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
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
