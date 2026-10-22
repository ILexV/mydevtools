/**
 * Code snippets for the HTTP client «Code» window: cURL, JavaScript fetch,
 * Python requests and HTTPie from the resolved request (variables and auth
 * applied, `{{secret:…}}` left as placeholders, files referenced by name).
 */
export type CodeLanguage = "curl" | "fetch" | "python" | "httpie";

export const CODE_LANGUAGES: readonly CodeLanguage[] = ["curl", "fetch", "python", "httpie"];

export type CodeBody =
  | { kind: "none" }
  | { kind: "text"; text: string }
  | { kind: "urlencoded"; pairs: [string, string][] }
  | { kind: "formdata"; parts: ({ name: string; value: string } | { name: string; file: { name: string; type: string } })[] }
  | { kind: "file"; name: string; type: string };

export interface CodeRequest {
  method: string;
  url: string;
  /** Multipart Content-Type is left out: each tool writes its own boundary. */
  headers: { name: string; value: string }[];
  body: CodeBody;
  basicAuth?: { username: string; password: string };
  timeoutMs: number;
  followRedirects: boolean;
}

/** POSIX shell single quotes. */
export function shellQuote(text: string): string {
  return /^[A-Za-z0-9_\/:.,=@%+-]+$/u.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

const literal = (text: string): string => JSON.stringify(text);
const seconds = (ms: number): string => String(Number((ms / 1000).toFixed(3)));
const quotedFile = (name: string): string => `"${name.replace(/["\\]/g, "\\$&")}"`;

function curl(request: CodeRequest): string {
  const first = request.method === "GET" ? "curl" : request.method === "HEAD" ? "curl --head" : `curl -X ${request.method}`;
  const lines = [`${first} ${shellQuote(request.url)}`];
  if (request.followRedirects) lines.push("-L");
  lines.push(`--max-time ${seconds(request.timeoutMs)}`);
  for (const header of request.headers) lines.push(`-H ${shellQuote(header.value ? `${header.name}: ${header.value}` : `${header.name};`)}`);
  if (request.basicAuth) lines.push(`-u ${shellQuote(`${request.basicAuth.username}:${request.basicAuth.password}`)}`);
  const body = request.body;
  if (body.kind === "text") lines.push(`--data-raw ${shellQuote(body.text)}`);
  else if (body.kind === "urlencoded") {
    // curl encodes only the part after `=`, so the name is encoded here.
    for (const [name, value] of body.pairs) lines.push(`--data-urlencode ${shellQuote(`${encodeURIComponent(name)}=${value}`)}`);
  } else if (body.kind === "formdata") {
    for (const part of body.parts) {
      lines.push("file" in part
        ? `-F ${shellQuote(`${part.name}=@${quotedFile(part.file.name)}${part.file.type ? `;type=${part.file.type}` : ""}`)}`
        : `--form-string ${shellQuote(`${part.name}=${part.value}`)}`);
    }
  } else if (body.kind === "file") lines.push(`--data-binary ${shellQuote(`@${body.name}`)}`);
  return lines.join(" \\\n  ");
}

function headerObject(request: CodeRequest, indent: string, extra: [string, string][] = [], step = "  "): string {
  const merged = new Map<string, [string, string]>();
  for (const { name, value } of request.headers) {
    const key = name.toLowerCase();
    const existing = merged.get(key);
    merged.set(key, existing ? [existing[0], `${existing[1]}, ${value}`] : [name, value]);
  }
  const entries = [...[...merged.values()].map(([name, value]) => `${literal(name)}: ${literal(value)}`), ...extra.map(([name, code]) => `${literal(name)}: ${code}`)];
  return entries.length ? `{\n${entries.map((entry) => `${indent}${step}${entry},`).join("\n")}\n${indent}}` : "{}";
}

function fetchCode(request: CodeRequest): string {
  const prelude: string[] = [];
  const body = request.body;
  let bodyCode: string | null = null;
  if (body.kind === "text") bodyCode = literal(body.text);
  else if (body.kind === "urlencoded") bodyCode = `new URLSearchParams([${body.pairs.map(([name, value]) => `[${literal(name)}, ${literal(value)}]`).join(", ")}])`;
  else if (body.kind === "formdata") {
    prelude.push("const form = new FormData();");
    for (const part of body.parts) {
      prelude.push("file" in part
        ? `form.append(${literal(part.name)}, await openAsBlob(${literal(part.file.name)}${part.file.type ? `, { type: ${literal(part.file.type)} }` : ""}), ${literal(part.file.name)});`
        : `form.append(${literal(part.name)}, ${literal(part.value)});`);
    }
    bodyCode = "form";
  } else if (body.kind === "file") {
    bodyCode = `await openAsBlob(${literal(body.name)})`;
  }
  const usesFiles = body.kind === "file" || (body.kind === "formdata" && body.parts.some((part) => "file" in part));
  const auth: [string, string][] = request.basicAuth
    ? [["Authorization", `"Basic " + btoa(${literal(`${request.basicAuth.username}:${request.basicAuth.password}`)})`]] : [];
  const options = [`  method: ${literal(request.method)},`, `  headers: ${headerObject(request, "  ", auth)},`];
  if (bodyCode) options.push(`  body: ${bodyCode},`);
  if (!request.followRedirects) options.push(`  redirect: "manual",`);
  options.push(`  signal: AbortSignal.timeout(${request.timeoutMs}),`);
  return [
    ...(usesFiles ? ["import { openAsBlob } from \"node:fs\";", ""] : []),
    ...(prelude.length ? [...prelude, ""] : []),
    `const response = await fetch(${literal(request.url)}, {`,
    ...options,
    "});",
    "console.log(response.status);",
    "console.log(await response.text());",
  ].join("\n");
}

function python(request: CodeRequest): string {
  const lines = ["import requests", "", `url = ${literal(request.url)}`];
  const args = ["url"];
  if (request.headers.length) {
    lines.push(`headers = ${headerObject(request, "", [], "    ")}`);
    args.push("headers=headers");
  }
  const body = request.body;
  if (body.kind === "text") {
    // A str body is sent as Latin-1 by http.client, so non-ASCII text is encoded explicitly.
    lines.push(`data = ${literal(body.text)}${/[^\x00-\x7f]/u.test(body.text) ? ".encode(\"utf-8\")" : ""}`);
    args.push("data=data");
  } else if (body.kind === "urlencoded") {
    lines.push(`data = [${body.pairs.map(([name, value]) => `(${literal(name)}, ${literal(value)})`).join(", ")}]`);
    args.push("data=data");
  } else if (body.kind === "formdata") {
    lines.push(`files = [\n${body.parts.map((part) => "file" in part
      ? `    (${literal(part.name)}, (${literal(part.file.name)}, open(${literal(part.file.name)}, "rb")${part.file.type ? `, ${literal(part.file.type)}` : ""})),`
      : `    (${literal(part.name)}, (None, ${literal(part.value)})),`).join("\n")}\n]`);
    args.push("files=files");
  } else if (body.kind === "file") {
    lines.push(`data = open(${literal(body.name)}, "rb")`);
    args.push("data=data");
  }
  if (request.basicAuth) args.push(`auth=(${literal(request.basicAuth.username)}, ${literal(request.basicAuth.password)})`);
  args.push(`timeout=${seconds(request.timeoutMs)}`, `allow_redirects=${request.followRedirects ? "True" : "False"}`);
  lines.push("", `response = requests.request(${literal(request.method)}, ${args.join(", ")})`, "print(response.status_code)", "print(response.text)");
  return lines.join("\n");
}

/** Item names escape HTTPie's separators so `a:b` is not read as a header. */
const httpieName = (name: string): string => name.replace(/([\\:=@;])/g, "\\$1");

function httpie(request: CodeRequest): string {
  const flags = [`--timeout=${seconds(request.timeoutMs)}`];
  if (request.followRedirects) flags.push("--follow");
  if (request.basicAuth) flags.push(`-a ${shellQuote(`${request.basicAuth.username}:${request.basicAuth.password}`)}`);
  const body = request.body;
  const items: string[] = request.headers.map((header) => shellQuote(header.value
    ? `${httpieName(header.name)}:${header.value}` : `${httpieName(header.name)};`));
  let stdin = "";
  if (body.kind === "text") flags.push(`--raw ${shellQuote(body.text)}`);
  else if (body.kind === "urlencoded") {
    flags.push("--form");
    items.push(...body.pairs.map(([name, value]) => shellQuote(`${httpieName(name)}=${value}`)));
  } else if (body.kind === "formdata") {
    flags.push("--multipart");
    items.push(...body.parts.map((part) => shellQuote("file" in part
      ? `${httpieName(part.name)}@${part.file.name}${part.file.type ? `;type=${part.file.type}` : ""}`
      : `${httpieName(part.name)}=${part.value}`)));
  } else if (body.kind === "file") stdin = ` < ${shellQuote(body.name)}`;
  return [`http ${flags.join(" ")} ${request.method} ${shellQuote(request.url)}`, ...items].join(" \\\n  ") + stdin;
}

export function generateCode(language: CodeLanguage, request: CodeRequest): string {
  switch (language) {
    case "fetch": return fetchCode(request);
    case "python": return python(request);
    case "httpie": return httpie(request);
    default: return curl(request);
  }
}

/** Snippet input from a built request; multipart drops its Content-Type (boundary). */
export function codeRequest(
  built: { method: string; url: string; headers: { name: string; value: string }[]; basicAuth?: { username: string; password: string }; bodySpec: CodeBody },
  timeoutMs: number,
  followRedirects: boolean,
): CodeRequest {
  const headers = built.bodySpec.kind === "formdata"
    ? built.headers.filter(({ name }) => name.toLowerCase() !== "content-type") : built.headers;
  return {
    method: built.method, url: built.url, headers: headers.map(({ name, value }) => ({ name, value })), body: built.bodySpec,
    ...(built.basicAuth ? { basicAuth: built.basicAuth } : {}), timeoutMs, followRedirects,
  };
}
