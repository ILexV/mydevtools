/**
 * Postman-style pre-request and test scripts of the HTTP client: the `pm.*`
 * subset (variables, request, response, `pm.test`, chai-like `pm.expect`,
 * `pm.response.to.*`), legacy `postman.*`/`tests[]` globals and console capture.
 *
 * `runHttpScripts` is self-contained on purpose: the sandbox ships its source
 * (`Function.prototype.toString`) into a Worker inside an opaque, network-less
 * iframe, so it must not touch anything outside its own body. Types only.
 */

export type ScriptEvent = "prerequest" | "test";
export type VariableScopeName = "globals" | "collection" | "environment";

export interface ScriptHeader {
  name: string;
  value: string;
}

export interface ScriptRequest {
  name: string;
  method: string;
  url: string;
  headers: ScriptHeader[];
  /** Raw body text; null when the request uses another body mode. */
  body: string | null;
}

export interface ScriptResponse {
  code: number;
  status: string;
  headers: ScriptHeader[];
  /** Decoded text of the body ("" for binary bodies). */
  body: string;
  responseTime: number;
  responseSize: number;
}

export interface ScriptJob {
  event: ScriptEvent;
  /** Folder scripts from the root down, then the request's own. */
  scripts: { label: string; code: string }[];
  globals: [string, string][];
  collection: [string, string][];
  /** Null when no environment is active: `pm.environment.set` is then ignored. */
  environment: [string, string][] | null;
  environmentName: string;
  locals: [string, string][];
  iterationData: [string, unknown][];
  info: { requestName: string; requestId: string; iteration: number; iterationCount: number };
  request: ScriptRequest;
  response?: ScriptResponse;
}

export type VariableOp =
  | { scope: VariableScopeName; op: "set"; name: string; value: string }
  | { scope: VariableScopeName; op: "unset"; name: string }
  | { scope: VariableScopeName; op: "clear" };

export interface ScriptTestResult {
  name: string;
  status: "pass" | "fail" | "skip";
  error?: string;
}

export interface ScriptLog {
  level: "log" | "info" | "warn" | "error";
  text: string;
}

export interface ScriptOutcome {
  ops: VariableOp[];
  locals: [string, string][];
  request: ScriptRequest;
  tests: ScriptTestResult[];
  logs: ScriptLog[];
  error: { script: string; message: string } | null;
  /** Runner order: a request name, null to stop, undefined when not set. */
  nextRequest?: string | null;
  skipRequest: boolean;
}

export async function runHttpScripts(job: ScriptJob): Promise<ScriptOutcome> {
  const ops: VariableOp[] = [];
  const logs: ScriptLog[] = [];
  const tests: ScriptTestResult[] = [];
  const testRuns: Promise<void>[] = [];
  const request: ScriptRequest = JSON.parse(JSON.stringify(job.request));
  const response = job.response;
  let nextRequest: string | null | undefined;
  let skipRequest = false;
  const LOG_LIMIT = 500;

  const inspect = (value: unknown, depth = 0): string => {
    if (typeof value === "string") return depth ? `'${value}'` : value;
    if (typeof value === "function") return `[Function${value.name ? `: ${value.name}` : ""}]`;
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value !== "object" || value === null) return String(value);
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value instanceof RegExp || value instanceof Date) return String(value);
    try {
      const text = JSON.stringify(value);
      return text === undefined ? String(value) : text.length > 400 ? `${text.slice(0, 400)}…` : text;
    } catch {
      return Object.prototype.toString.call(value);
    }
  };
  const stringValue = (value: unknown): string => typeof value === "string" ? value
    : value === undefined ? "" : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
  const log = (level: ScriptLog["level"], args: unknown[]): void => {
    if (logs.length < LOG_LIMIT) logs.push({ level, text: args.map((arg) => inspect(arg)).join(" ") });
  };
  const scriptConsole = {
    log: (...args: unknown[]) => log("log", args),
    debug: (...args: unknown[]) => log("log", args),
    info: (...args: unknown[]) => log("info", args),
    warn: (...args: unknown[]) => log("warn", args),
    error: (...args: unknown[]) => log("error", args),
  };

  // ---- Variables ---------------------------------------------------------
  const globals = new Map(job.globals);
  const collection = new Map(job.collection);
  const environment = job.environment ? new Map(job.environment) : null;
  const locals = new Map(job.locals);
  const iterationData = new Map(job.iterationData);

  const dynamicValue = (name: string): string | null => {
    switch (name) {
      case "$guid": return crypto.randomUUID();
      case "$timestamp": return String(Math.floor(Date.now() / 1000));
      case "$isoTimestamp": return new Date().toISOString();
      case "$randomInt": return String(Math.floor(Math.random() * 1001));
      default: return null;
    }
  };
  const lookup = (name: string): string | undefined => {
    if (locals.has(name)) return locals.get(name);
    if (iterationData.has(name)) return stringValue(iterationData.get(name));
    if (environment?.has(name)) return environment.get(name);
    if (collection.has(name)) return collection.get(name);
    return globals.get(name);
  };
  const replaceIn = (text: unknown): string => {
    const expand = (input: string, depth: number): string => input.replace(/\{\{([^{}]+)\}\}/g, (match, raw: string) => {
      const name = raw.trim();
      if (name.startsWith("secret:")) return match;
      const dynamic = name.startsWith("$") ? dynamicValue(name) : null;
      if (dynamic !== null) return dynamic;
      const value = lookup(name);
      return value === undefined || depth > 8 ? match : expand(value, depth + 1);
    });
    return expand(stringValue(text), 0);
  };
  const scope = (name: VariableScopeName, store: Map<string, string> | null, label: string) => ({
    get: (key: string) => store?.get(key),
    has: (key: string) => store?.has(key) ?? false,
    set: (key: string, value: unknown) => {
      if (!store) {
        log("warn", [`${label}.set("${key}"): no environment is selected, the value is not saved`]);
        return;
      }
      const text = stringValue(value);
      store.set(String(key), text);
      ops.push({ scope: name, op: "set", name: String(key), value: text });
    },
    unset: (key: string) => {
      if (!store) return;
      store.delete(String(key));
      ops.push({ scope: name, op: "unset", name: String(key) });
    },
    clear: () => {
      if (!store) return;
      store.clear();
      ops.push({ scope: name, op: "clear" });
    },
    toObject: () => Object.fromEntries(store ?? []),
    replaceIn,
  });
  const environmentScope = { ...scope("environment", environment, "pm.environment"), name: job.environmentName };
  const globalsScope = scope("globals", globals, "pm.globals");
  const collectionScope = scope("collection", collection, "pm.collectionVariables");
  const variablesScope = {
    get: (key: string) => lookup(key),
    has: (key: string) => lookup(key) !== undefined,
    set: (key: string, value: unknown) => { locals.set(String(key), stringValue(value)); },
    unset: (key: string) => { locals.delete(String(key)); },
    toObject: () => Object.fromEntries([...globals, ...collection, ...(environment ?? []),
      ...[...iterationData].map(([key, value]) => [key, stringValue(value)] as const), ...locals]),
    replaceIn,
  };

  // ---- Assertions (chai-like subset) ------------------------------------
  class AssertionError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AssertionError";
    }
  }
  const typeName = (value: unknown): string => {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    const tag = Object.prototype.toString.call(value).slice(8, -1).toLowerCase();
    return typeof value === "object" ? tag : typeof value;
  };
  const deepEqual = (left: unknown, right: unknown): boolean => {
    if (Object.is(left, right)) return true;
    if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
    if (typeName(left) !== typeName(right)) return false;
    if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
    if (left instanceof RegExp && right instanceof RegExp) return String(left) === String(right);
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
      && deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  };
  const show = (value: unknown): string => inspect(value, 1);
  const lengthOf = (value: unknown): number => {
    if (value instanceof Map || value instanceof Set) return value.size;
    const length = (value as { length?: unknown } | null | undefined)?.length;
    if (typeof length !== "number") throw new AssertionError(`expected ${show(value)} to have a length`);
    return length;
  };
  const pathValue = (value: unknown, path: string): { found: boolean; value: unknown } => {
    let current = value;
    for (const part of path.replace(/\[(\w+)\]/g, ".$1").split(".").filter(Boolean)) {
      if (current === null || current === undefined || !(part in Object(current))) return { found: false, value: undefined };
      current = (current as Record<string, unknown>)[part];
    }
    return { found: true, value: current };
  };

  interface Flags {
    not?: boolean;
    deep?: boolean;
    own?: boolean;
    nested?: boolean;
    any?: boolean;
    all?: boolean;
    contains?: boolean;
    length?: boolean;
    message?: string;
    call?: (...args: unknown[]) => unknown;
  }
  const CHAINS = new Set(["to", "be", "been", "is", "that", "which", "and", "has", "have", "with", "at", "of", "same", "but", "does", "still", "also"]);
  const assertion = (subject: unknown, flags: Flags): unknown => {
    const assert = (passed: boolean, positive: string, negative: string): void => {
      if (flags.not ? passed : !passed) {
        const text = flags.not ? negative : positive;
        throw new AssertionError(flags.message ? `${flags.message}: ${text}` : text);
      }
    };
    const next = (extra: Flags = {}, value: unknown = subject): unknown => {
      const { call: _call, ...kept } = flags;
      return assertion(value, { ...kept, ...extra });
    };
    const self = (): unknown => next();
    const compare = (op: string, limit: number, test: (value: number) => boolean) => {
      const value = flags.length ? lengthOf(subject) : subject as number;
      const label = flags.length ? `${show(subject)} to have a length ${op} ${limit} but got ${value}` : `${show(subject)} to be ${op} ${limit}`;
      assert(test(value), `expected ${label}`, `expected ${show(subject)} not to be ${op} ${limit}`);
      return self();
    };
    const includes = (expected: unknown): boolean => {
      if (typeof subject === "string") return subject.includes(String(expected));
      if (Array.isArray(subject)) return subject.some((item) => flags.deep ? deepEqual(item, expected) : item === expected);
      if (subject instanceof Set || subject instanceof Map) return [...subject.keys()].includes(expected);
      if (typeof subject === "object" && subject !== null && typeof expected === "object" && expected !== null) {
        return Object.entries(expected).every(([key, value]) => key in subject
          && (flags.deep ? deepEqual((subject as Record<string, unknown>)[key], value) : (subject as Record<string, unknown>)[key] === value));
      }
      return false;
    };
    const methods: Record<string, (...args: never[]) => unknown> = {
      equal: (expected: unknown) => {
        const passed = flags.deep ? deepEqual(subject, expected) : subject === expected;
        assert(passed, `expected ${show(subject)} to ${flags.deep ? "deeply " : ""}equal ${show(expected)}`,
          `expected ${show(subject)} to not ${flags.deep ? "deeply " : ""}equal ${show(expected)}`);
        return self();
      },
      eql: (expected: unknown) => {
        assert(deepEqual(subject, expected), `expected ${show(subject)} to deeply equal ${show(expected)}`,
          `expected ${show(subject)} to not deeply equal ${show(expected)}`);
        return self();
      },
      above: (limit: number) => compare("above", limit, (value) => value > limit),
      least: (limit: number) => compare("at least", limit, (value) => value >= limit),
      below: (limit: number) => compare("below", limit, (value) => value < limit),
      most: (limit: number) => compare("at most", limit, (value) => value <= limit),
      within: (low: number, high: number) => {
        const value = flags.length ? lengthOf(subject) : subject as number;
        assert(value >= low && value <= high, `expected ${show(subject)} to be within ${low}..${high}`,
          `expected ${show(subject)} to not be within ${low}..${high}`);
        return self();
      },
      closeTo: (expected: number, delta: number) => {
        assert(Math.abs((subject as number) - expected) <= delta, `expected ${show(subject)} to be close to ${expected} +/- ${delta}`,
          `expected ${show(subject)} not to be close to ${expected} +/- ${delta}`);
        return self();
      },
      property: (name: string, ...rest: unknown[]) => {
        const target = Object(subject);
        const found = flags.nested ? pathValue(subject, name)
          : flags.own ? { found: Object.prototype.hasOwnProperty.call(target, name), value: target[name] }
          : { found: subject !== null && subject !== undefined && name in target, value: subject === null || subject === undefined ? undefined : target[name] };
        if (rest.length) {
          const passed = found.found && (flags.deep ? deepEqual(found.value, rest[0]) : found.value === rest[0]);
          assert(passed, `expected ${show(subject)} to have property '${name}' of ${show(rest[0])}, but got ${show(found.value)}`,
            `expected ${show(subject)} to not have property '${name}' of ${show(rest[0])}`);
        } else {
          assert(found.found, `expected ${show(subject)} to have property '${name}'`, `expected ${show(subject)} to not have property '${name}'`);
        }
        return flags.not ? self() : next({}, found.value);
      },
      lengthOf: (expected: number) => {
        const value = lengthOf(subject);
        assert(value === expected, `expected ${show(subject)} to have a length of ${expected} but got ${value}`,
          `expected ${show(subject)} to not have a length of ${expected}`);
        return self();
      },
      match: (pattern: RegExp) => {
        assert(pattern.test(String(subject)), `expected ${show(subject)} to match ${pattern}`, `expected ${show(subject)} not to match ${pattern}`);
        return self();
      },
      string: (part: string) => {
        assert(String(subject).includes(part), `expected ${show(subject)} to contain ${show(part)}`, `expected ${show(subject)} to not contain ${show(part)}`);
        return self();
      },
      oneOf: (list: unknown[]) => {
        assert(list.some((item) => flags.deep ? deepEqual(item, subject) : item === subject),
          `expected ${show(subject)} to be one of ${show(list)}`, `expected ${show(subject)} to not be one of ${show(list)}`);
        return self();
      },
      keys: (...input: unknown[]) => {
        const expected = (input.length === 1 && Array.isArray(input[0]) ? input[0]
          : input.length === 1 && typeof input[0] === "object" && input[0] !== null ? Object.keys(input[0]) : input).map(String);
        const actual = subject instanceof Map || subject instanceof Set ? [...subject.keys()].map(String) : Object.keys(Object(subject));
        const passed = flags.any ? expected.some((key) => actual.includes(key))
          : flags.contains ? expected.every((key) => actual.includes(key))
          : expected.length === actual.length && expected.every((key) => actual.includes(key));
        assert(passed, `expected ${show(subject)} to have ${flags.any ? "any of " : ""}keys ${show(expected)}`,
          `expected ${show(subject)} to not have ${flags.any ? "any of " : ""}keys ${show(expected)}`);
        return self();
      },
      members: (expected: unknown[]) => {
        const list = Array.isArray(subject) ? subject : [];
        const same = (left: unknown, right: unknown) => flags.deep ? deepEqual(left, right) : left === right;
        const contained = expected.every((item) => list.some((entry) => same(entry, item)));
        const passed = flags.contains ? contained : contained && list.length === expected.length && list.every((entry) => expected.some((item) => same(entry, item)));
        assert(passed, `expected ${show(subject)} to ${flags.contains ? "be a superset of" : "have the same members as"} ${show(expected)}`,
          `expected ${show(subject)} to not ${flags.contains ? "be a superset of" : "have the same members as"} ${show(expected)}`);
        return self();
      },
      instanceOf: (type: new (...args: never[]) => unknown) => {
        assert(subject instanceof type, `expected ${show(subject)} to be an instance of ${type.name}`, `expected ${show(subject)} to not be an instance of ${type.name}`);
        return self();
      },
      satisfy: (test: (value: unknown) => unknown) => {
        assert(!!test(subject), `expected ${show(subject)} to satisfy ${show(test)}`, `expected ${show(subject)} to not satisfy ${show(test)}`);
        return self();
      },
      throw: (expected?: unknown, text?: string | RegExp) => {
        let thrown: unknown = null;
        let didThrow = false;
        try {
          (subject as () => unknown)();
        } catch (error) {
          didThrow = true;
          thrown = error;
        }
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        const pattern = typeof expected === "string" || expected instanceof RegExp ? expected : text;
        let passed = didThrow;
        if (passed && typeof expected === "function") passed = thrown instanceof (expected as new () => unknown);
        if (passed && pattern !== undefined) passed = typeof pattern === "string" ? message.includes(pattern) : pattern.test(message);
        assert(passed, `expected [Function] to throw${pattern !== undefined ? ` ${show(pattern)}` : ""}${didThrow ? ` but got '${message}'` : ""}`,
          "expected [Function] to not throw an error");
        return self();
      },
    };
    const aliases: Record<string, string> = {
      equals: "equal", eq: "equal", eqls: "eql", gt: "above", greaterThan: "above", gte: "least", greaterThanOrEqual: "least",
      lt: "below", lessThan: "below", lte: "most", lessThanOrEqual: "most", haveOwnProperty: "property", ownProperty: "property",
      matches: "match", key: "keys", instanceof: "instanceOf", satisfies: "satisfy", approximately: "closeTo", throws: "throw", Throw: "throw",
    };
    const properties: Record<string, () => void> = {
      ok: () => assert(!!subject, `expected ${show(subject)} to be truthy`, `expected ${show(subject)} to be falsy`),
      true: () => assert(subject === true, `expected ${show(subject)} to be true`, `expected ${show(subject)} to be false`),
      false: () => assert(subject === false, `expected ${show(subject)} to be false`, `expected ${show(subject)} to be true`),
      null: () => assert(subject === null, `expected ${show(subject)} to be null`, `expected ${show(subject)} not to be null`),
      undefined: () => assert(subject === undefined, `expected ${show(subject)} to be undefined`, `expected ${show(subject)} not to be undefined`),
      NaN: () => assert(Number.isNaN(subject), `expected ${show(subject)} to be NaN`, `expected ${show(subject)} not to be NaN`),
      exist: () => assert(subject !== null && subject !== undefined, `expected ${show(subject)} to exist`, `expected ${show(subject)} to not exist`),
      empty: () => {
        const size = typeof subject === "string" || Array.isArray(subject) ? subject.length
          : subject instanceof Map || subject instanceof Set ? subject.size
          : typeof subject === "object" && subject !== null ? Object.keys(subject).length : NaN;
        if (Number.isNaN(size)) throw new AssertionError(`.empty was passed non-string primitive ${show(subject)}`);
        assert(size === 0, `expected ${show(subject)} to be empty`, `expected ${show(subject)} not to be empty`);
      },
    };
    const typeCheck = (expected: string) => {
      const article = /^[aeiou]/i.test(expected) ? "an" : "a";
      assert(typeName(subject) === String(expected).toLowerCase(), `expected ${show(subject)} to be ${article} ${expected}`,
        `expected ${show(subject)} not to be ${article} ${expected}`);
      return self();
    };
    const includeCheck = (expected: unknown) => {
      assert(includes(expected), `expected ${show(subject)} to include ${show(expected)}`, `expected ${show(subject)} to not include ${show(expected)}`);
      return self();
    };
    return new Proxy(() => undefined, {
      apply: (_target, _this, args: unknown[]) => {
        if (!flags.call) throw new TypeError("assertion is not a function");
        return flags.call(...args);
      },
      get: (_target, key) => {
        if (typeof key !== "string") return undefined;
        if (CHAINS.has(key)) return self();
        if (key === "not") return next({ not: !flags.not });
        if (key === "deep" || key === "own" || key === "nested" || key === "any" || key === "all") return next({ [key]: true });
        if (key === "a" || key === "an") return next({ call: (type) => typeCheck(type as string) });
        if (key === "include" || key === "includes" || key === "contain" || key === "contains") {
          return next({ contains: true, call: (expected) => includeCheck(expected) });
        }
        if (key === "length") return next({ length: true, call: (expected) => methods.lengthOf!(expected as never) });
        if (key in properties) {
          properties[key]!();
          return self();
        }
        const method = methods[aliases[key] ?? key];
        if (method) return (...args: never[]) => method(...args);
        return undefined;
      },
    });
  };
  const expect = Object.assign((value: unknown, message?: string) => assertion(value, message ? { message } : {}), {
    fail: (message?: string) => {
      throw new AssertionError(message ?? "expect.fail()");
    },
  });

  // ---- Request and response --------------------------------------------
  const headerList = (list: ScriptHeader[], editable: boolean) => {
    const find = (name: string) => list.find((header) => header.name.toLowerCase() === String(name).toLowerCase());
    const api = {
      get: (name: string) => find(name)?.value,
      has: (name: string, value?: string) => {
        const header = find(name);
        return !!header && (value === undefined || header.value === value);
      },
      toObject: () => Object.fromEntries(list.map((header) => [header.name, header.value])),
      all: () => list.map((header) => ({ key: header.name, value: header.value })),
      each: (callback: (header: { key: string; value: string }) => void) => {
        for (const header of list) callback({ key: header.name, value: header.value });
      },
      count: () => list.length,
    };
    if (!editable) return api;
    const entry = (input: unknown, value?: unknown): ScriptHeader => typeof input === "string"
      ? { name: input.split(":", 1)[0]!.trim(), value: value === undefined ? input.slice(input.indexOf(":") + 1).trim() : stringValue(value) }
      : { name: String((input as { key?: unknown }).key ?? ""), value: stringValue((input as { value?: unknown }).value) };
    return Object.assign(api, {
      add: (input: unknown, value?: unknown) => { list.push(entry(input, value)); },
      upsert: (input: unknown, value?: unknown) => {
        const header = entry(input, value);
        const existing = find(header.name);
        if (existing) existing.value = header.value;
        else list.push(header);
      },
      remove: (name: string) => {
        for (let index = list.length - 1; index >= 0; index--) {
          if (list[index]!.name.toLowerCase() === String(name).toLowerCase()) list.splice(index, 1);
        }
      },
    });
  };
  const queryApi = () => {
    const split = () => {
      const hashAt = request.url.indexOf("#");
      const fragment = hashAt < 0 ? "" : request.url.slice(hashAt);
      const base = hashAt < 0 ? request.url : request.url.slice(0, hashAt);
      const queryAt = base.indexOf("?");
      const path = queryAt < 0 ? base : base.slice(0, queryAt);
      const pairs = queryAt < 0 ? [] : base.slice(queryAt + 1).split("&").filter(Boolean).map((part) => {
        const at = part.indexOf("=");
        return at < 0 ? [part, ""] as [string, string] : [part.slice(0, at), part.slice(at + 1)] as [string, string];
      });
      return { path, pairs, fragment };
    };
    const write = (path: string, pairs: [string, string][], fragment: string) => {
      request.url = `${path}${pairs.length ? `?${pairs.map(([key, value]) => `${key}=${value}`).join("&")}` : ""}${fragment}`;
    };
    const pair = (input: unknown, value?: unknown): [string, string] => typeof input === "string"
      ? [input, stringValue(value)] : [String((input as { key?: unknown }).key ?? ""), stringValue((input as { value?: unknown }).value)];
    return {
      get: (key: string) => split().pairs.find(([name]) => name === key)?.[1],
      has: (key: string) => split().pairs.some(([name]) => name === key),
      toObject: () => Object.fromEntries(split().pairs),
      add: (input: unknown, value?: unknown) => {
        const { path, pairs, fragment } = split();
        write(path, [...pairs, pair(input, value)], fragment);
      },
      upsert: (input: unknown, value?: unknown) => {
        const { path, pairs, fragment } = split();
        const [key, text] = pair(input, value);
        const existing = pairs.find(([name]) => name === key);
        if (existing) existing[1] = text;
        else pairs.push([key, text]);
        write(path, pairs, fragment);
      },
      remove: (key: string) => {
        const { path, pairs, fragment } = split();
        write(path, pairs.filter(([name]) => name !== key), fragment);
      },
    };
  };
  const urlApi = {
    toString: () => request.url,
    update: (url: string) => { request.url = String(url); },
    query: queryApi(),
    getHost: () => request.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#:]/, 1)[0],
    getPath: () => {
      const rest = request.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
      return rest.split(/[?#]/, 1)[0] || "/";
    },
  };
  const requestApi = {
    get url() { return urlApi; },
    set url(value: unknown) { request.url = String(value); },
    get method() { return request.method; },
    set method(value: string) { request.method = String(value).toUpperCase(); },
    get name() { return request.name; },
    headers: headerList(request.headers, job.event === "prerequest"),
    body: {
      get raw() { return request.body ?? ""; },
      set raw(value: string) {
        if (request.body === null) log("warn", ["pm.request.body.raw: the request does not use a raw body, the change is not sent"]);
        else request.body = stringValue(value);
      },
      get mode() { return request.body === null ? "other" : "raw"; },
      toString: () => request.body ?? "",
      update: (value: unknown) => {
        const text = typeof value === "string" ? value : stringValue((value as { raw?: unknown } | null)?.raw ?? value);
        if (request.body !== null) request.body = text;
      },
    },
  };
  const parseJson = (): unknown => {
    if (!response) throw new Error("pm.response is only available in test scripts");
    return JSON.parse(response.body);
  };
  const responseTo = (negate: boolean): unknown => {
    const check = (passed: boolean, positive: string, negative: string) => {
      if (negate ? passed : !passed) throw new AssertionError(negate ? negative : positive);
      return responseTo(negate);
    };
    const code = response?.code ?? 0;
    const statusProps: Record<string, [(status: number) => boolean, string]> = {
      ok: [(status) => status === 200, "200"], success: [(status) => status >= 200 && status < 300, "2XX"],
      info: [(status) => status >= 100 && status < 200, "1XX"], redirection: [(status) => status >= 300 && status < 400, "3XX"],
      clientError: [(status) => status >= 400 && status < 500, "4XX"], serverError: [(status) => status >= 500, "5XX"],
      error: [(status) => status >= 400, "4XX or 5XX"], accepted: [(status) => status === 202, "202"],
      badRequest: [(status) => status === 400, "400"], unauthorized: [(status) => status === 401, "401"],
      forbidden: [(status) => status === 403, "403"], notFound: [(status) => status === 404, "404"],
      rateLimited: [(status) => status === 429, "429"],
    };
    const responseMethods: Record<string, (...args: never[]) => unknown> = {
      status: (expected: number | string) => typeof expected === "number"
        ? check(code === expected, `expected response to have status code ${expected} but got ${code}`, `expected response to not have status code ${expected}`)
        : check(response?.status === expected, `expected response to have status reason '${expected}' but got '${response?.status}'`,
          `expected response to not have status reason '${expected}'`),
      header: (name: string, value?: string) => {
        const header = response?.headers.find((entry) => entry.name.toLowerCase() === String(name).toLowerCase());
        return value === undefined
          ? check(!!header, `expected response to have header ${name}`, `expected response to not have header ${name}`)
          : check(header?.value === value, `expected '${name}' response header to be '${value}' but got '${header?.value}'`,
            `expected '${name}' response header to not be '${value}'`);
      },
      body: (expected?: string | RegExp) => {
        const body = response?.body ?? "";
        if (expected === undefined) return check(body.length > 0, "expected response to have content in body", "expected response to not have content in body");
        if (expected instanceof RegExp) return check(expected.test(body), `expected response body to match ${expected}`, `expected response body to not match ${expected}`);
        return check(body === stringValue(expected), `expected response body to equal ${show(expected)}`, `expected response body to not equal ${show(expected)}`);
      },
      jsonBody: (path?: string, ...rest: unknown[]) => {
        let data: unknown;
        try {
          data = parseJson();
        } catch {
          return check(false, "expected response body to be a valid JSON", "expected response body not to be a valid JSON");
        }
        if (path === undefined) return check(true, "", "expected response body not to be a valid JSON");
        const found = pathValue(data, path);
        if (!rest.length) return check(found.found, `expected response body json to have path '${path}'`, `expected response body json to not have path '${path}'`);
        return check(found.found && deepEqual(found.value, rest[0]), `expected response body json at '${path}' to contain ${show(rest[0])}`,
          `expected response body json at '${path}' to not contain ${show(rest[0])}`);
      },
    };
    return new Proxy({}, {
      get: (_target, key) => {
        if (typeof key !== "string") return undefined;
        if (CHAINS.has(key)) return responseTo(negate);
        if (key === "not") return responseTo(!negate);
        if (key in statusProps) {
          const [test, label] = statusProps[key]!;
          return check(test(code), `expected response code to be ${label} but found ${code}`, `expected response code to not be ${label}`);
        }
        if (key === "json" || key === "withBody") {
          return key === "json" ? responseMethods.jsonBody!() : responseMethods.body!();
        }
        const method = responseMethods[key];
        return method ? (...args: never[]) => method(...args) : undefined;
      },
    });
  };
  const responseApi = response ? {
    code: response.code,
    status: response.status,
    responseTime: response.responseTime,
    responseSize: response.responseSize,
    headers: headerList(response.headers.map((header) => ({ ...header })), false),
    text: () => response.body,
    json: () => parseJson(),
    get to() { return responseTo(false); },
  } : undefined;

  // ---- pm.test and timers ------------------------------------------------
  let pendingTimers = 0;
  let wakeTimers: (() => void) | null = null;
  const timerIds = new Map<unknown, boolean>();
  const timerFailure: { error: unknown } = { error: null };
  const settleTimer = (id: unknown) => {
    if (timerIds.delete(id)) pendingTimers--;
    if (!pendingTimers) wakeTimers?.();
  };
  const scriptSetTimeout = (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const id: unknown = setTimeout(() => {
      settleTimer(id);
      try {
        callback(...args);
      } catch (error) {
        timerFailure.error ??= error;
      }
    }, delay);
    timerIds.set(id, true);
    pendingTimers++;
    return id;
  };
  const scriptClearTimeout = (id: unknown) => {
    clearTimeout(id as number);
    settleTimer(id);
  };
  const scriptSetInterval = (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const id: unknown = setInterval(() => {
      try {
        callback(...args);
      } catch (error) {
        timerFailure.error ??= error;
      }
    }, delay);
    timerIds.set(id, true);
    pendingTimers++;
    return id;
  };
  const scriptClearInterval = (id: unknown) => {
    clearInterval(id as number);
    settleTimer(id);
  };

  const errorText = (error: unknown): string => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const test = Object.assign((name: string, callback: (done?: (error?: unknown) => void) => unknown) => {
    const result: ScriptTestResult = { name: String(name), status: "pass" };
    tests.push(result);
    const fail = (error: unknown) => {
      result.status = "fail";
      result.error = errorText(error);
    };
    try {
      if (typeof callback !== "function") return;
      if (callback.length > 0) {
        testRuns.push(new Promise<void>((resolve) => {
          const done = (error?: unknown) => {
            if (error) fail(error);
            resolve();
          };
          try {
            const value = callback(done);
            if (value && typeof (value as Promise<unknown>).then === "function") (value as Promise<unknown>).then(undefined, (error) => { fail(error); resolve(); });
          } catch (error) {
            fail(error);
            resolve();
          }
        }));
        return;
      }
      const value = callback();
      if (value && typeof (value as Promise<unknown>).then === "function") {
        testRuns.push((value as Promise<unknown>).then(() => undefined, fail));
      }
    } catch (error) {
      fail(error);
    }
  }, {
    skip: (name: string) => {
      tests.push({ name: String(name), status: "skip" });
    },
  });

  const setNext = (name: unknown) => {
    nextRequest = name === null ? null : String(name);
  };
  const pm = {
    info: { eventName: job.event, iteration: job.info.iteration, iterationCount: job.info.iterationCount,
      requestName: job.info.requestName, requestId: job.info.requestId },
    environment: environmentScope,
    globals: globalsScope,
    collectionVariables: collectionScope,
    variables: variablesScope,
    iterationData: {
      get: (key: string) => iterationData.get(key),
      has: (key: string) => iterationData.has(key),
      toObject: () => Object.fromEntries(iterationData),
      toJSON: () => Object.fromEntries(iterationData),
    },
    request: requestApi,
    response: responseApi,
    test,
    expect,
    execution: {
      setNextRequest: setNext,
      skipRequest: () => {
        if (job.event === "prerequest") skipRequest = true;
      },
    },
    sendRequest: () => {
      throw new Error("pm.sendRequest is not supported: scripts run without network access");
    },
  };
  const legacyTests: Record<string, unknown> = {};
  const postman = {
    setNextRequest: setNext,
    setEnvironmentVariable: (key: string, value: unknown) => environmentScope.set(key, value),
    getEnvironmentVariable: (key: string) => environmentScope.get(key),
    clearEnvironmentVariable: (key: string) => environmentScope.unset(key),
    clearEnvironmentVariables: () => environmentScope.clear(),
    setGlobalVariable: (key: string, value: unknown) => globalsScope.set(key, value),
    getGlobalVariable: (key: string) => globalsScope.get(key),
    clearGlobalVariable: (key: string) => globalsScope.unset(key),
    clearGlobalVariables: () => globalsScope.clear(),
    getResponseHeader: (name: string) => responseApi?.headers.get(name),
  };
  const unsupported = (name: string) => () => {
    throw new Error(`${name} is not supported in these scripts`);
  };

  const names = ["pm", "postman", "console", "tests", "responseBody", "responseCode", "responseTime", "responseHeaders",
    "environment", "globals", "data", "iteration", "request", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "require"];
  const values = [pm, postman, scriptConsole, legacyTests, response?.body, response ? { code: response.code, name: response.status, detail: response.status } : undefined,
    response?.responseTime, response ? Object.fromEntries(response.headers.map((header) => [header.name, header.value])) : undefined,
    Object.fromEntries(environment ?? []), Object.fromEntries(globals), Object.fromEntries(iterationData), job.info.iteration,
    { url: request.url, method: request.method, name: request.name, headers: Object.fromEntries(request.headers.map((header) => [header.name, header.value])),
      data: request.body ?? "" },
    scriptSetTimeout, scriptClearTimeout, scriptSetInterval, scriptClearInterval, unsupported("require")];
  const AsyncFunction = (async () => undefined).constructor as new (...args: string[]) => (...input: unknown[]) => Promise<unknown>;

  let error: ScriptOutcome["error"] = null;
  for (const script of job.scripts) {
    if (!script.code.trim()) continue;
    try {
      const run = new AsyncFunction(...names, `"use strict";\n${script.code}\n`);
      await run(...values);
      while (pendingTimers > 0) await new Promise<void>((resolve) => { wakeTimers = resolve; });
      wakeTimers = null;
      if (timerFailure.error !== null) throw timerFailure.error;
      await Promise.all(testRuns.splice(0));
    } catch (failure) {
      error = { script: script.label, message: errorText(failure) };
      break;
    }
  }
  // Legacy `tests["name"] = condition` results come after the pm.test ones.
  for (const [name, value] of Object.entries(legacyTests)) tests.push({ name, status: value ? "pass" : "fail" });
  return { ops, locals: [...locals], request, tests, logs, error, ...(nextRequest !== undefined ? { nextRequest } : {}), skipRequest };
}
