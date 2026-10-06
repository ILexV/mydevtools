/**
 * JSON → TypeScript type inference for json-to-typescript (pure; tested in
 * `test/json-to-typescript.test.ts`). Builds named interfaces (or type
 * aliases) for nested objects, `T[]` / `(A | B)[]` for arrays, merges all
 * objects of an array into one item interface (keys missing in some items
 * become optional), marks null fields optional when `optional` is on, quotes
 * non-identifier keys, sanitizes type names, and numbers colliding names
 * (`RootUser2`) — every referenced type is emitted.
 */

export interface ConvertOptions {
  rootName: string;
  exportKw: boolean;
  optional: boolean;
  useType: boolean;
}

/** PascalCase + valid TS identifier (`my-root` → `MyRoot`, `1st` → `_1st`, `$` kept). */
export function toTypeName(str: string): string {
  const pascal = str
    .replace(/[-_\s.]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (_, c: string) => c.toUpperCase())
    .replace(/[^\p{ID_Continue}$]/gu, "");
  if (!pascal) return "";
  return /^[\p{ID_Start}$_]/u.test(pascal) ? pascal : `_${pascal}`;
}

/** Property key as written in TS: bare identifier or a JSON-quoted string. */
export function toSafeKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isObject = (v: unknown): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

class Builder {
  /** name → body lines (insertion order = output order, dependencies first). */
  private readonly bodies = new Map<string, string>();
  private readonly opts: ConvertOptions;
  constructor(opts: ConvertOptions) {
    this.opts = opts;
  }

  /** Type for a set of sample values seen at the same position. */
  typeOf(values: Json[], name: string): string {
    const parts: string[] = [];
    const add = (t: string) => {
      if (!parts.includes(t)) parts.push(t);
    };
    const objects = values.filter(isObject);
    const arrays = values.filter(Array.isArray) as Json[][];
    for (const v of values) {
      if (v === null) add("null");
      else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") add(typeof v);
    }
    if (objects.length) add(this.objectType(objects, name));
    if (arrays.length) {
      const items = arrays.flat();
      if (!items.length) add("unknown[]");
      else {
        const el = this.typeOf(items, toTypeName(name) + "Item");
        add(el.includes(" | ") ? `(${el})[]` : `${el}[]`);
      }
    }
    return parts.length ? parts.join(" | ") : "unknown";
  }

  /** Register one interface merged from all `objects`; returns its (possibly numbered) name. */
  objectType(objects: Record<string, Json>[], name: string): string {
    const base = toTypeName(name) || "Root";
    const keys: string[] = [];
    for (const o of objects) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
    const lines = keys.map((key) => {
      const present = objects.filter((o) => Object.hasOwn(o, key));
      const vals = present.map((o) => o[key]);
      const missing = present.length < objects.length;
      const nullable = this.opts.optional && vals.some((v) => v === null);
      const type = this.typeOf(vals, base + toTypeName(key));
      return `  ${toSafeKey(key)}${missing || nullable ? "?" : ""}: ${type};`;
    });
    const body = lines.join("\n");
    // Same name + same shape → reuse; same name, different shape → Name2, Name3…
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? base : `${base}${i}`;
      const existing = this.bodies.get(candidate);
      if (existing === undefined) {
        this.bodies.set(candidate, body);
        return candidate;
      }
      if (existing === body) return candidate;
    }
  }

  render(extra: Array<[string, string]>): string {
    const exp = this.opts.exportKw ? "export " : "";
    const out: string[] = [];
    for (const [name, body] of this.bodies) {
      const block = body ? `{\n${body}\n}` : "{}";
      out.push(this.opts.useType ? `${exp}type ${name} = ${block};` : `${exp}interface ${name} ${block}`);
    }
    for (const [name, type] of extra) out.push(`${exp}type ${name} = ${type};`);
    return out.join("\n\n");
  }
}

/** Convert JSON text to TypeScript declarations. Throws SyntaxError on invalid JSON. */
export function jsonToTypeScript(jsonStr: string, opts: ConvertOptions): string {
  const parsed = JSON.parse(jsonStr) as Json;
  const rootName = toTypeName(opts.rootName || "Root") || "Root";
  const b = new Builder(opts);
  if (isObject(parsed)) {
    b.objectType([parsed], rootName);
    return b.render([]);
  }
  // Arrays and primitives: `type Root = …` alias after the item interfaces.
  return b.render([[rootName, b.typeOf([parsed], rootName)]]);
}
