import type { HttpAuth, HttpFormDataRow, HttpSavedRequest, HttpSavedRow } from "./http-workspace.ts";

/**
 * cURL import for the HTTP client: a command copied from a terminal or from
 * browser DevTools («Copy as cURL» bash and cmd) becomes request fields.
 * Files named with `@` cannot be read by the page and are listed for re-picking.
 */
export type CurlFields = Pick<HttpSavedRequest, "method" | "url" | "params" | "headers" | "body" | "bodyFormat" | "bodyMode"
  | "urlencoded" | "formdata" | "binary" | "followRedirects" | "verifyTls" | "httpVersion"> & { timeoutMs?: number; auth?: HttpAuth };

export interface CurlImport {
  fields: CurlFields;
  /** Options with an effect the client cannot reproduce (TLS, proxy, cookies jar…). */
  ignored: string[];
  /** Files referenced with `@name`: their rows or the binary body wait for a file. */
  files: string[];
}

export class CurlParseError extends Error {
  readonly code: "not_curl" | "no_url" | "quote";
  constructor(code: CurlParseError["code"]) {
    super(code);
    this.code = code;
  }
}

export function looksLikeCurl(text: string): boolean {
  return /^\s*curl(?:\.exe)?\s/iu.test(text);
}

const ANSI_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", "\"": "\"", "?": "?" };

/** POSIX shell words: quotes, backslash escapes, `\` line continuation and `$'…'`. */
function bashWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let index = 0;
  const flush = (): void => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/u.test(char)) {
      flush();
      index++;
    } else if (char === "\\") {
      const next = text[index + 1];
      if (next === "\n") index += 2;
      else if (next === "\r" && text[index + 2] === "\n") index += 3;
      else {
        if (next !== undefined) word += next;
        started = true;
        index += 2;
      }
    } else if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) throw new CurlParseError("quote");
      word += text.slice(index + 1, end);
      started = true;
      index = end + 1;
    } else if (char === "$" && text[index + 1] === "'") {
      index += 2;
      started = true;
      while (text[index] !== "'") {
        if (index >= text.length) throw new CurlParseError("quote");
        if (text[index] !== "\\") {
          word += text[index++];
          continue;
        }
        const code = text[index + 1] ?? "";
        const hex = code === "x" ? /^[0-9a-fA-F]{1,2}/u : code === "u" ? /^[0-9a-fA-F]{1,4}/u : code === "U" ? /^[0-9a-fA-F]{1,8}/u : null;
        if (hex) {
          const digits = hex.exec(text.slice(index + 2))?.[0] ?? "";
          word += digits ? String.fromCodePoint(parseInt(digits, 16)) : `\\${code}`;
          index += 2 + digits.length;
        } else if (/[0-7]/u.test(code)) {
          const digits = /^[0-7]{1,3}/u.exec(text.slice(index + 1))![0];
          word += String.fromCharCode(parseInt(digits, 8));
          index += 1 + digits.length;
        } else {
          word += ANSI_ESCAPES[code] ?? `\\${code}`;
          index += 2;
        }
      }
      index++;
    } else if (char === "\"") {
      index++;
      started = true;
      while (text[index] !== "\"") {
        if (index >= text.length) throw new CurlParseError("quote");
        if (text[index] === "\\" && /["\\$`\n]/u.test(text[index + 1] ?? "")) {
          if (text[index + 1] !== "\n") word += text[index + 1];
          index += 2;
        } else {
          word += text[index++];
        }
      }
      index++;
    } else if (char === "#" && !started) {
      while (index < text.length && text[index] !== "\n") index++;
    } else {
      word += char;
      started = true;
      index++;
    }
  }
  flush();
  return words;
}

/** Windows cmd words as Chrome's «Copy as cURL (cmd)» writes them: `^` escapes, `"` quotes, `\"` a quote. */
function cmdWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    let char = text[index]!;
    if (char === "^") {
      char = text[++index] ?? "";
      if (char === "\r" && text[index + 1] === "\n") index++;
      if (char === "\n" || char === "\r") continue;
      if (char === "\\" && text[index + 1] === "^" && text[index + 2] === "\"") {
        word += "\"";
        started = true;
        index += 2;
        continue;
      }
      if (char !== "\"") {
        word += char;
        started = true;
        continue;
      }
    } else if (char === "\\" && text[index + 1] === "\"") {
      word += "\"";
      started = true;
      index++;
      continue;
    }
    if (char === "\"") {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/u.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quoted) throw new CurlParseError("quote");
  if (started) words.push(word);
  return words;
}

/** Options that take a value and do not change the request this client sends. */
const SKIP_WITH_VALUE = new Set(["-o", "--output", "-w", "--write-out", "--connect-timeout", "--retry", "--retry-delay",
  "--retry-max-time", "-c", "--cookie-jar", "-D", "--dump-header", "--trace", "--trace-ascii", "--stderr", "--limit-rate",
  "-y", "--speed-time", "-Y", "--speed-limit", "--max-redirs", "--keepalive-time", "--output-dir", "--config", "-K"]);
const SKIP_FLAGS = new Set(["-s", "--silent", "-S", "--show-error", "-v", "--verbose", "-i", "--include", "--compressed",
  "-#", "--progress-bar", "-f", "--fail", "--fail-with-body", "-N", "--no-buffer", "-g", "--globoff", "-O", "--remote-name",
  "-J", "--remote-header-name", "--http3", "-n", "--netrc",
  "--no-progress-meter", "-q", "--disable", "--tr-encoding", "--path-as-is", "--location-trusted"]);
/** Options with an effect the client cannot reproduce; reported to the user. */
const IGNORED_WITH_VALUE = new Set(["-x", "--proxy", "-E", "--cert", "--key", "--cacert", "--capath", "--resolve",
  "--connect-to", "--interface", "-U", "--proxy-user", "--cert-type", "--key-type", "--pass", "--ciphers", "--tls-max",
  "--oauth2-bearer", "-z", "--time-cond", "--aws-sigv4"]);
const IGNORED_FLAGS = new Set(["--digest", "--ntlm", "--negotiate", "--anyauth", "-4", "--ipv4",
  "-6", "--ipv6", "-0", "--http1.0", "--tlsv1.2", "--tlsv1.3", "--ssl-no-revoke", "--proxy-insecure"]);
const SHORT_WITH_VALUE = new Set(["X", "H", "d", "F", "u", "A", "e", "b", "m", "T", "r", "o", "w", "c", "D", "x", "E",
  "U", "K", "y", "Y", "z"]);

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function formatOf(contentType: string): HttpSavedRequest["bodyFormat"] {
  const mime = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (mime.endsWith("json") || mime.endsWith("+json")) return "json";
  if (mime.endsWith("xml")) return "xml";
  if (mime === "text/html") return "html";
  return "text";
}

function decodeForm(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

/** Query rows the way the URL field shows them. */
export function paramsFromUrl(url: string): HttpSavedRow[] {
  const beforeFragment = url.split("#", 1)[0]!;
  const queryAt = beforeFragment.indexOf("?");
  return queryAt < 0 ? [] : [...new URLSearchParams(beforeFragment.slice(queryAt + 1))].map(([name, value]) => ({ name, value, enabled: true }));
}

export function parseCurl(command: string): CurlImport {
  const cmd = /\^\r?\n|\^"/u.test(command);
  const words = cmd ? cmdWords(command) : bashWords(command);
  if (!words.length || !/^curl(?:\.exe)?$/iu.test(words[0]!)) throw new CurlParseError("not_curl");

  let method = "";
  let url = "";
  const headers: HttpSavedRow[] = [];
  const data: { text: string; encode: boolean; /** `--data-raw`: a leading `@` is text, not a file. */ raw: boolean }[] = [];
  const form: HttpFormDataRow[] = [];
  let json = false;
  let getData = false;
  let upload: string | null = null;
  let head = false;
  let user: string | null = null;
  let followRedirects = false;
  let verifyTls = true;
  let httpVersion: CurlFields["httpVersion"];
  let timeoutMs: number | undefined;
  const ignored: string[] = [];
  const files: string[] = [];

  // Split `-XPOST` and `-sSL` into separate options.
  const args: string[] = [];
  for (const word of words.slice(1)) {
    if (/^-[A-Za-z0-9#]{2,}$/u.test(word) && !word.startsWith("--")) {
      let rest = word.slice(1);
      while (rest) {
        const letter = rest[0]!;
        rest = rest.slice(1);
        args.push(`-${letter}`);
        if (SHORT_WITH_VALUE.has(letter) && rest) {
          args.push(rest);
          rest = "";
        }
      }
    } else {
      const eq = /^(--[a-z0-9.-]+)=(.*)$/su.exec(word);
      if (eq) args.push(eq[1]!, eq[2]!);
      else args.push(word);
    }
  }

  for (let index = 0; index < args.length; index++) {
    const option = args[index]!;
    const value = (): string => args[++index] ?? "";
    if (!option.startsWith("-") || option === "-") {
      if (!url) url = option;
      continue;
    }
    switch (option) {
      case "-X": case "--request": {
        const requested = value().toUpperCase();
        if (METHODS.includes(requested)) method = requested;
        else ignored.push(`-X ${requested}`);
        break;
      }
      case "--url": url = value(); break;
      case "-H": case "--header": {
        const header = value();
        const colon = header.indexOf(":");
        // `Name: value` adds a header, `Name;` an empty one; `Name:` only removes a curl default.
        if (colon > 0 && header.slice(colon + 1).trim()) {
          headers.push({ name: header.slice(0, colon).trim(), value: header.slice(colon + 1).trim(), enabled: true });
        } else if (colon < 0 && header.endsWith(";") && header.length > 1) {
          headers.push({ name: header.slice(0, -1).trim(), value: "", enabled: true });
        }
        break;
      }
      case "-d": case "--data": case "--data-ascii": data.push({ text: value(), encode: false, raw: false }); break;
      case "--data-binary": data.push({ text: value(), encode: false, raw: false }); break;
      case "--data-raw": data.push({ text: value(), encode: false, raw: true }); break;
      case "--data-urlencode": data.push({ text: value(), encode: true, raw: false }); break;
      case "--json": json = true; data.push({ text: value(), encode: false, raw: false }); break;
      case "-F": case "--form": case "--form-string": {
        const field = value();
        const eq = field.indexOf("=");
        const name = eq < 0 ? field : field.slice(0, eq);
        let content = eq < 0 ? "" : field.slice(eq + 1);
        if (option !== "--form-string" && (content.startsWith("@") || content.startsWith("<"))) {
          const fileName = content.slice(1).split(";", 1)[0]!.replace(/^"(.*)"$/su, "$1");
          files.push(fileName);
          form.push({ name, value: "", enabled: true, kind: "file", file: null });
        } else {
          if (option !== "--form-string") content = content.replace(/^"(.*)"(;.*)?$/su, "$1").split(/;type=/u, 1)[0]!;
          form.push({ name, value: content, enabled: true, kind: "text" });
        }
        break;
      }
      case "-u": case "--user": user = value(); break;
      case "-A": case "--user-agent": headers.push({ name: "User-Agent", value: value(), enabled: true }); break;
      case "-e": case "--referer": headers.push({ name: "Referer", value: value(), enabled: true }); break;
      case "-b": case "--cookie": {
        const cookie = value();
        if (cookie.includes("=")) headers.push({ name: "Cookie", value: cookie, enabled: true });
        else ignored.push(option);
        break;
      }
      case "-r": case "--range": headers.push({ name: "Range", value: `bytes=${value()}`, enabled: true }); break;
      case "-G": case "--get": getData = true; break;
      case "-I": case "--head": head = true; break;
      case "-L": case "--location": followRedirects = true; break;
      case "-k": case "--insecure": verifyTls = false; break;
      case "--http1.1": httpVersion = "http1"; break;
      case "--http2": case "--http2-prior-knowledge": httpVersion = "http2"; break;
      case "-m": case "--max-time": {
        const seconds = Number(value());
        if (Number.isFinite(seconds) && seconds > 0) timeoutMs = Math.round(Math.min(120, Math.max(0.1, seconds)) * 1000);
        break;
      }
      case "-T": case "--upload-file": upload = value(); break;
      default:
        if (SKIP_WITH_VALUE.has(option)) index++;
        else if (IGNORED_WITH_VALUE.has(option)) {
          index++;
          ignored.push(option);
        } else if (!SKIP_FLAGS.has(option)) {
          ignored.push(option);
          if (!IGNORED_FLAGS.has(option) && args[index + 1] !== undefined && !args[index + 1]!.startsWith("-")
            && url) index++;
        }
    }
  }
  if (!url) throw new CurlParseError("no_url");
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(url) && !url.startsWith("{{")) url = `http://${url}`;

  const header = (name: string) => headers.find((entry) => entry.name.toLowerCase() === name);
  if (json) {
    if (!header("content-type")) headers.push({ name: "Content-Type", value: "application/json", enabled: true });
    if (!header("accept")) headers.push({ name: "Accept", value: "application/json", enabled: true });
  }
  // A stale length or a boundary from another body would break the edited request.
  const kept = headers.filter((entry) => entry.name.toLowerCase() !== "content-length"
    && !(form.length && entry.name.toLowerCase() === "content-type"));

  const fields: CurlFields = {
    method: "", url, params: [], headers: kept, body: "", bodyFormat: "text", bodyMode: "none",
    urlencoded: [], formdata: [], binary: null, followRedirects,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(verifyTls ? {} : { verifyTls: false }),
    ...(httpVersion ? { httpVersion } : {}),
  };
  if (user !== null) {
    const colon = user.indexOf(":");
    fields.auth = { type: "basic", username: colon < 0 ? user : user.slice(0, colon), password: colon < 0 ? "" : user.slice(colon + 1) };
  }

  const fileData = data.find((entry) => !entry.raw && !entry.encode && entry.text.startsWith("@"));
  const pieces = data.map((entry) => {
    if (!entry.encode) return entry.text;
    const eq = entry.text.indexOf("=");
    if (eq < 0) return encodeURIComponent(entry.text);
    return `${entry.text.slice(0, eq)}=${encodeURIComponent(entry.text.slice(eq + 1))}`;
  });
  const joined = pieces.join("&");
  const contentType = header("content-type")?.value ?? "";
  if (form.length) {
    fields.bodyMode = "formdata";
    fields.formdata = form;
  } else if (upload !== null || (fileData && data.length === 1)) {
    const name = upload ?? fileData!.text.slice(1);
    files.push(name);
    fields.bodyMode = "binary";
  } else if (data.length && getData) {
    url += (url.includes("?") ? "&" : "?") + joined;
    fields.url = url;
  } else if (data.length) {
    const urlencoded = !contentType || /^application\/x-www-form-urlencoded/iu.test(contentType);
    const pairs = joined.split("&").filter(Boolean);
    if (urlencoded && !json && pairs.every((pair) => /^[^=\s{]+=\S*$/u.test(pair))) {
      fields.bodyMode = "urlencoded";
      fields.urlencoded = pairs.map((pair) => {
        const eq = pair.indexOf("=");
        return { name: decodeForm(eq < 0 ? pair : pair.slice(0, eq)), value: eq < 0 ? "" : decodeForm(pair.slice(eq + 1)), enabled: true };
      });
    } else {
      fields.bodyMode = "raw";
      fields.body = joined;
      fields.bodyFormat = formatOf(contentType);
    }
  }
  const hasBody = fields.bodyMode !== "none";
  fields.method = head ? "HEAD" : method || (upload !== null ? "PUT" : hasBody ? "POST" : "GET");
  fields.params = paramsFromUrl(fields.url);
  return { fields, ignored: [...new Set(ignored)], files };
}
