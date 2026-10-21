/**
 * AWS Signature Version 4 for the HTTP client's Auth tab, computed in the
 * browser with WebCrypto (HMAC-SHA256, SHA-256). Signs host, x-amz-date, the
 * optional session token, content-type when present, and for S3 the payload hash.
 */
export interface AwsSigV4Input {
  method: string;
  url: URL;
  headers: readonly { name: string; value: string }[];
  body: Uint8Array;
  accessKey: string;
  secretKey: string;
  sessionToken: string;
  region: string;
  service: string;
  now?: Date;
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

/** RFC 3986 unreserved characters stay; everything else is %XX in upper case. */
function strictEncode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalPath(url: URL, service: string): string {
  const segments = url.pathname.split("/").map((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Keep a malformed escape as written.
    }
    const once = strictEncode(decoded);
    // Every service except S3 signs the path encoded twice.
    return service === "s3" ? once : strictEncode(once);
  });
  const path = segments.join("/");
  return path.startsWith("/") ? path : `/${path}`;
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams]
    .map(([key, value]) => [strictEncode(key), strictEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/** `YYYYMMDDTHHMMSSZ` */
function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Headers to add to the request: Authorization, X-Amz-Date and, when used, the token and payload hash. */
export async function signAwsV4(input: AwsSigV4Input): Promise<{ name: string; value: string }[]> {
  const date = amzDate(input.now ?? new Date());
  const day = date.slice(0, 8);
  const payloadHash = await sha256Hex(input.body);
  const added: { name: string; value: string }[] = [{ name: "X-Amz-Date", value: date }];
  if (input.sessionToken) added.push({ name: "X-Amz-Security-Token", value: input.sessionToken });
  if (input.service === "s3") added.push({ name: "X-Amz-Content-Sha256", value: payloadHash });

  const signed = new Map<string, string>([["host", input.url.host]]);
  for (const header of [...input.headers, ...added]) {
    const name = header.name.toLowerCase();
    if (name === "content-type" || name.startsWith("x-amz-")) {
      signed.set(name, header.value.trim().replace(/\s+/g, " "));
    }
  }
  const names = [...signed.keys()].sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(input.url, input.service),
    canonicalQuery(input.url),
    names.map((name) => `${name}:${signed.get(name)}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, await sha256Hex(canonicalRequest)].join("\n");
  let key = await hmac(encoder.encode(`AWS4${input.secretKey}`), day);
  for (const part of [input.region, input.service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));
  added.unshift({
    name: "Authorization",
    value: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  });
  return added;
}
