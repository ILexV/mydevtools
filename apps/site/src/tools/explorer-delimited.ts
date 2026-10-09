/**
 * Encode one RFC 4180 CSV record. The caller owns the record separator.
 *
 * Spreadsheet programs can execute cells beginning with formula sigils. By
 * default such values are prefixed with an apostrophe, including when the
 * sigil follows leading whitespace or control characters. Pass `false` only
 * when byte-for-byte cell text matters more than spreadsheet safety.
 */
export function encodeCsvRow(values: readonly string[], protectFormulas = true): string {
  return values.map((original) => {
    const value = protectFormulas && /^[\s\u0000-\u001f\u007f-\u009f]*[=+\-@]/u.test(original)
      ? `'${original}`
      : original;
    return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  }).join(",");
}
