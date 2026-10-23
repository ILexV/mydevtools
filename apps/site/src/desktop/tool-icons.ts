/**
 * Desktop tool glyphs: one picture per tool for shortcut tiles, the folder
 * popover, the launcher, taskbar buttons and window titles. Prism geometry:
 * 20×20 viewBox, stroke 1.7, round caps, currentColor (drawn white on the
 * category tile). Tools without an entry fall back to their registry monogram.
 */

const MONO = `font-family="JetBrains Mono Variable, ui-monospace, monospace" font-weight="700" fill="currentColor" stroke="none" text-anchor="middle"`;
const dot = (x: number, y: number, r = 0.95) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`;
const label = (text: string, y = 12.6, size = 6.6) => `<text x="10" y="${y}" font-size="${size}" ${MONO}>${text}</text>`;
/** Base-N family: the radix itself, large, over a short baseline. */
const radix = (text: string) => `${label(text, 12.4, 10.5)}<path d="M4 16h12"/>`;
const page = `<path d="M11.5 2.8H6.2a1.6 1.6 0 0 0-1.6 1.6v11.2a1.6 1.6 0 0 0 1.6 1.6h7.6a1.6 1.6 0 0 0 1.6-1.6V6.7Z"/><path d="M11.5 2.8v3.9h3.9"/>`;

export const TOOL_ICONS: Record<string, string> = {
  /* encoding */
  "base64-encoder": radix("64"),
  "base32-encoder": radix("32"),
  "base58-encoder": radix("58"),
  "hex-encoder": `<path d="M10 2.6 16.4 6.3v7.4L10 17.4 3.6 13.7V6.3Z"/>${label("0x", 12.6, 7.4)}`,
  "hex-viewer": `<rect x="3" y="3.5" width="14" height="13" rx="2"/><path d="M6 7.3h2M10.5 7.3h3.5M6 10h2M10.5 10h3.5M6 12.7h2M10.5 12.7h2"/>`,
  "archive-explorer": `<rect x="3.5" y="3" width="13" height="14" rx="2"/><path d="M10 3v2M10 6.5v1.5M10 9.5v1.5"/><rect x="8.6" y="12" width="2.8" height="2.6" rx="0.6"/>`,
  "compression-benchmark": `<path d="M3.5 16.5h13"/><path d="M5 16.5V6.5M8.7 16.5V10M12.4 16.5V12.5M16 16.5v-3"/><path d="M4 4.5l3 1.5 3-1.5 3 1.5 3-1.5"/>`,
  "url-encoder": `<path d="M8.6 11.4a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M11.4 8.6a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1"/>`,
  "html-entity-encoder": `<path d="M5.5 6 2.5 10l3 4M14.5 6l3 4-3 4"/>${label("&amp;", 13.6, 9.5)}`,

  /* structured data */
  "json-beautifier": `<path d="M6.3 3.8c-1.5 0-2 .8-2 2v2.1c0 .9-.5 1.6-1.4 2.1.9.5 1.4 1.2 1.4 2.1v2.1c0 1.2.5 2 2 2M13.7 3.8c1.5 0 2 .8 2 2v2.1c0 .9.5 1.6 1.4 2.1-.9.5-1.4 1.2-1.4 2.1v2.1c0 1.2-.5 2-2 2"/><path d="M8 7.4h4M9.3 10h3M8 12.6h4"/>`,
  "json-to-typescript": `<path d="M3 3.5h14v13H3z" stroke-opacity=".55"/>${label("TS", 13.9, 9.5)}`,
  "json-explorer": `<circle cx="5" cy="4.6" r="1.7"/><circle cx="11" cy="10" r="1.5"/><circle cx="11" cy="15.4" r="1.5"/><path d="M5 6.3v9.1h4.5M5 10h4.5M14 10h3M14 15.4h3"/>`,
  "csv-explorer": `<rect x="3" y="3.5" width="14" height="13" rx="2"/><path d="M3 7.8h14M3 12.2h14M8 3.5v13M12.5 3.5v13"/>`,
  "log-analyzer": `<path d="M3 4.5h14M3 8h9M3 11.5h12M3 15h7"/><path d="M14.5 13.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6ZM16.5 17.2l2 2"/>`,
  "parquet-explorer": `<rect x="3" y="3.5" width="3.6" height="13" rx="1"/><rect x="8.2" y="3.5" width="3.6" height="13" rx="1"/><rect x="13.4" y="3.5" width="3.6" height="13" rx="1"/><path d="M3 8.5h3.6M8.2 11.5h3.6M13.4 7h3.6"/>`,
  "sqlite-explorer": `<ellipse cx="9" cy="4.8" rx="5.5" ry="2.2"/><path d="M3.5 4.8v9.4c0 1.2 2.5 2.2 5.5 2.2M14.5 4.8V9M3.5 9.5c0 1.2 2.5 2.2 5.5 2.2"/><circle cx="14" cy="14" r="2.6"/><path d="m16 16 2 2"/>`,
  "local-data-playground": `<ellipse cx="10" cy="5" rx="6.5" ry="2.5"/><path d="M3.5 5v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V5M3.5 10v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-5"/>`,
  "data-format-converter": `<path d="M3 5h10M10 2l3 3-3 3M17 15H7M10 12l-3 3 3 3"/><path d="M4 9.5h12" stroke-opacity=".45"/>`,
  "xml-beautifier": `<path d="M6.5 6 3 10l3.5 4M13.5 6 17 10l-3.5 4M11.4 4.5 8.6 15.5"/>`,
  "yaml-beautifier-validator": `<path d="M3.5 5h1.5M7.5 5h9M6 10h1.5M10 10h6.5M6 15h1.5M10 15h6.5"/>`,
  "cron-generator": `<circle cx="8.5" cy="9" r="5.5"/><path d="M8.5 6v3l2.1 1.4M15.5 13v4.5M13.25 15.25h4.5"/>`,
  "cron-parser": `<circle cx="7.5" cy="7.8" r="4.6"/><path d="M7.5 5.6v2.2l1.6 1M14 5.5h3M14 8.5h3M3.5 15.5h13.5"/>`,

  /* text */
  "word-counter": `<path d="M3.5 5h13M3.5 8.5h13M3.5 12h6.5"/>${`<text x="14.2" y="17" font-size="6.2" ${MONO}>12</text>`}`,
  "text-case-converter": label("Aa", 14.6, 12),
  "text-diff-viewer": `<rect x="2.5" y="3.5" width="6.6" height="13" rx="1.6"/><rect x="10.9" y="3.5" width="6.6" height="13" rx="1.6"/><path d="M4.3 10h3M12.7 10h3M14.2 8.5v3"/>`,
  "large-file-diff": `<path d="M4 2.5h6l3 3V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z"/><path d="M8 7h8a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V13"/><path d="M5.5 7.5h3M10 12.5h3M11.5 11v3"/>`,

  /* JWT */
  "jwt-decoder": `<rect x="3" y="3" width="14" height="6.4" rx="3.2"/>${dot(6.6, 6.2)}${dot(10, 6.2)}${dot(13.4, 6.2)}<path d="M5 12.5h10M5 15.6h6.5"/>`,
  "jwt-encoder": `<path d="M5 4.4h10M5 7.5h6.5"/><rect x="3" y="10.6" width="14" height="6.4" rx="3.2"/>${dot(6.6, 13.8)}${dot(10, 13.8)}${dot(13.4, 13.8)}`,

  /* regex */
  "regex-tester": `<path d="M13 3.5v7M10 5.3l6 3.4M16 5.3l-6 3.4"/>${dot(5.5, 15, 1.6)}`,

  /* hashing */
  "hash-calculator": `<path d="M5 9a5 5 0 0 1 10 0v1.6"/><path d="M7.6 16c.6-1.3.9-2.8.9-4.4V9.4a1.5 1.5 0 0 1 3 0v2.3c0 1.7-.3 3.2-.9 4.6"/><path d="M4.8 12.7c.2-.9.2-1.8.2-2.7M14.8 13.8c.1-.6.2-1.2.2-1.9"/>`,
  "password-generator": `<rect x="2.5" y="6" width="15" height="8" rx="2.2"/><path d="M6 8.5v3M4.7 9.25l2.6 1.5M7.3 9.25l-2.6 1.5M11 8.5v3M9.7 9.25l2.6 1.5M12.3 9.25l-2.6 1.5M14.6 11.6h1.4"/>`,

  /* cryptography */
  "hmac-calculator": `<path d="M3.5 4.2h6.3l6.8 6.8-5.6 5.6-6.8-6.8Z"/><circle cx="7" cy="7.7" r="1.3"/>`,
  "aead-file": `${page}<rect x="7.2" y="10.6" width="5.6" height="4.2" rx=".9"/><path d="M8.4 10.6v-1a1.6 1.6 0 0 1 3.2 0v1"/>`,
  "openssh-keys": `<circle cx="6.5" cy="13.5" r="3.2"/><path d="m8.8 11.2 7.7-7.7M13.8 5.9l2 2M11.6 8.1l1.6 1.6"/>`,
  "file-signature": `<path d="M5 2.5h6.5L15 6v4"/><path d="M11.5 2.5V6H15"/><path d="M5 2.5A1.5 1.5 0 0 0 3.5 4v12A1.5 1.5 0 0 0 5 17.5h4"/><path d="m11 15.5 1.8 1.8 3.7-4"/>`,
  x509: `<rect x="2.5" y="3.5" width="15" height="10.5" rx="1.6"/><path d="M5.5 7h9M5.5 10h4.5"/><circle cx="14" cy="13.6" r="2.3"/><path d="m12.8 15.5-.6 2.5 1.8-1 1.8 1-.6-2.5"/>`,

  /* generators */
  "uuid-generator": `<rect x="3.2" y="3.2" width="13.6" height="13.6" rx="3"/>${dot(6.9, 6.9, 1.1)}${dot(13.1, 6.9, 1.1)}${dot(10, 10, 1.1)}${dot(6.9, 13.1, 1.1)}${dot(13.1, 13.1, 1.1)}`,
  "lorem-ipsum-generator": `<path d="M9 4h7.5M9.3 4v12.5M13.3 4v12.5"/><path d="M9.3 4a3.6 3.6 0 0 0 0 7.2"/>`,

  /* converters */
  "unit-converter": `<rect x="2.5" y="6.5" width="15" height="7" rx="1.3"/><path d="M5.5 6.5v2.8M8.5 6.5v1.7M11.5 6.5v2.8M14.5 6.5v1.7"/>`,
  "date-converter": `<rect x="3" y="4.5" width="14" height="12.5" rx="2"/><path d="M3 8.6h14M7 3v3M13 3v3"/>${dot(7, 12.6)}${dot(10, 12.6)}${dot(13, 12.6)}`,

  /* networking */
  "ip-subnet-calculator": `<rect x="7.5" y="2.8" width="5" height="4.2" rx="1"/><rect x="2.5" y="13" width="5" height="4.2" rx="1"/><rect x="12.5" y="13" width="5" height="4.2" rx="1"/><path d="M10 7v3M5 13v-3h10v3"/>`,
  "http-client": `<path d="M3 5h8M8 2l3 3-3 3M17 15H9M12 12l-3 3 3 3"/><path d="M5 10h10" stroke-opacity=".45"/>`,
  "path-trace": `<circle cx="4.2" cy="4.2" r="1.7"/><circle cx="10" cy="10" r="1.7"/><circle cx="15.8" cy="15.8" r="1.7"/><path d="M5.6 5.4 8.6 8.5M11.4 11.5 14.4 14.6"/>`,
  "dns-lookup": `<circle cx="10" cy="10" r="6.2"/><path d="M10 3.8v12.4M4.2 10h11.6M5.2 6.6c1.4 1.2 3 1.8 4.8 1.8s3.4-.6 4.8-1.8M5.2 13.4c1.4-1.2 3-1.8 4.8-1.8s3.4.6 4.8 1.8"/>`,
  "tcp-connect": `<path d="M7 3.2v3.6M13 3.2v3.6M5.2 7.4h9.6v2.4a4.8 4.8 0 0 1-9.6 0V7.4zM10 14.6v2.6"/>`,
  "tls-inspect": `<rect x="4.2" y="9" width="11.6" height="8" rx="1.4"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>`,
  "whois-lookup": `${page}<path d="M7.2 9.2h5.6M7.2 11.6h5.6M7.2 14h3.4"/>`,
  "asn-lookup": `<circle cx="4.6" cy="7.2" r="2"/><circle cx="15.4" cy="13.2" r="2"/><path d="M6.4 8.2 13.5 12.2"/>`,
  "port-scanner": `<rect x="2.8" y="4" width="14.4" height="12" rx="1.6"/><path d="M5.8 8h2M9 8h2M12.2 8h2M5.8 12h2M9 12h2M12.2 12h2"/>`,
  "network-scanner": `<circle cx="10" cy="10" r="2"/><path d="M6.2 13.8a5.4 5.4 0 0 1 0-7.6M13.8 6.2a5.4 5.4 0 0 1 0 7.6M3.6 16.4a9 9 0 0 1 0-12.8M16.4 3.6a9 9 0 0 1 0 12.8"/>`,

  /* design */
  "color-converter": `<path d="M10 3a7 7 0 0 0 0 14c1 0 1.5-.6 1.5-1.4 0-.8-.6-1.2-.6-2 0-.9.7-1.6 1.6-1.6H14a3 3 0 0 0 3-3C17 5.8 13.9 3 10 3Z"/>${dot(6.4, 9.2)}${dot(8.4, 6.2)}${dot(12.4, 6.3)}`,
  "markdown-preview": `<rect x="2" y="5" width="16" height="10" rx="2"/><path d="M5 12.5v-5l2 2.5 2-2.5v5M13.5 7.5v5M11.5 10.6l2 2 2-2"/>`,

  /* images */
  "image-compressor": `<rect x="3" y="3" width="14" height="14" rx="2.6"/><path d="M6.3 6.3 9 9M9 6.4V9H6.4M13.7 13.7 11 11M11 13.6V11h2.6"/>`,
  "image-converter": `<rect x="2.5" y="3.5" width="11" height="9.5" rx="1.6"/><path d="m2.5 11 3-3 3 3 2-2 3 3"/><path d="M16.5 7.5v7A1.6 1.6 0 0 1 14.9 16H6.5"/>`,
  "image-batch": `<rect x="6" y="6" width="11" height="11" rx="2"/><path d="M3.5 13V5a1.5 1.5 0 0 1 1.5-1.5h8"/><path d="m8.5 14 2.4-2.8 1.7 1.9 1-1.1 1.4 2"/>`,
  "image-resizer": `<rect x="3" y="8" width="9" height="9" rx="1.5"/><path d="M8 3.2h7.3a1.5 1.5 0 0 1 1.5 1.5V12M12.5 3.2h4.3v4.3M16.8 3.2 11.5 8.5"/>`,

  /* PDF */
  "pdf-compressor": `${page}<path d="M10 8.6v5M7.9 11.6 10 13.7l2.1-2.1"/>`,
  "pdf-merger": `<rect x="2.5" y="2.8" width="7.5" height="9.5" rx="1.4"/><rect x="10" y="7.7" width="7.5" height="9.5" rx="1.4"/><path d="M4.6 15.2h3M6.1 13.7v3"/>`,
  "pdf-to-text": `${page}<path d="M7.4 9.6h5.2M10 9.6v5"/>`,
  "pdf-organizer": `${page}<path d="M7.3 11.6a2.8 2.8 0 1 0 1-2.4"/><path d="M7.4 7.9v1.6h1.6"/>`,

  /* QR */
  "qr-code-generator": `<rect x="3" y="3" width="5.6" height="5.6" rx="1.1"/><rect x="11.4" y="3" width="5.6" height="5.6" rx="1.1"/><rect x="3" y="11.4" width="5.6" height="5.6" rx="1.1"/>${dot(5.8, 5.8, 0.9)}${dot(14.2, 5.8, 0.9)}${dot(5.8, 14.2, 0.9)}<path d="M14.2 11.4v5.6M11.4 14.2H17"/>`,
  "qr-scanner": `<path d="M3 7V4.6A1.6 1.6 0 0 1 4.6 3H7M13 3h2.4A1.6 1.6 0 0 1 17 4.6V7M17 13v2.4a1.6 1.6 0 0 1-1.6 1.6H13M7 17H4.6A1.6 1.6 0 0 1 3 15.4V13M3 10h14"/>`,
};
