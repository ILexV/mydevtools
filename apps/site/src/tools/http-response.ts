const MAX_OUTPUT_LENGTH = 2 * 1024 * 1024;
const MAX_NESTING = 64;
const OUTPUT_CHUNK_LENGTH = 8192;
const INDENTS = Array.from({ length: MAX_NESTING + 1 }, (_, depth) => "  ".repeat(depth));
const LINE_INDENTS = INDENTS.map((indent) => `\n${indent}`);

class ResponseJsonFormatter {
  private position = 0;
  private outputLength = 0;
  private readonly outputChunks: string[] = [];
  private outputChunk = "";

  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  format(): string | null {
    this.skipWhitespace();
    if (!this.parseValue(0)) return null;
    this.skipWhitespace();
    if (this.position !== this.source.length) return null;
    if (this.outputChunk.length > 0) this.outputChunks.push(this.outputChunk);
    return this.outputChunks.join("");
  }

  private append(text: string): boolean {
    if (text.length > MAX_OUTPUT_LENGTH - this.outputLength) return false;
    this.outputChunk += text;
    if (this.outputChunk.length >= OUTPUT_CHUNK_LENGTH) {
      this.outputChunks.push(this.outputChunk);
      this.outputChunk = "";
    }
    this.outputLength += text.length;
    return true;
  }

  private parseValue(depth: number): boolean {
    const character = this.source[this.position];
    if (character === '"') return this.parseString();
    if (character === "{") return depth < MAX_NESTING && this.parseObject(depth + 1);
    if (character === "[") return depth < MAX_NESTING && this.parseArray(depth + 1);
    if (character === "-" || (character >= "0" && character <= "9")) return this.parseNumber();
    if (this.source.startsWith("true", this.position)) return this.parseLiteral("true");
    if (this.source.startsWith("false", this.position)) return this.parseLiteral("false");
    if (this.source.startsWith("null", this.position)) return this.parseLiteral("null");
    return false;
  }

  private parseObject(depth: number): boolean {
    this.position++;
    if (!this.append("{")) return false;
    this.skipWhitespace();

    if (this.source[this.position] === "}") {
      this.position++;
      return this.append("}");
    }

    while (true) {
      if (!this.append(LINE_INDENTS[depth]) || !this.parseString()) return false;
      this.skipWhitespace();
      if (this.source[this.position] !== ":") return false;
      this.position++;
      if (!this.append(": ")) return false;
      this.skipWhitespace();
      if (!this.parseValue(depth)) return false;
      this.skipWhitespace();

      const separator = this.source[this.position];
      if (separator === ",") {
        this.position++;
        if (!this.append(",")) return false;
        this.skipWhitespace();
        continue;
      }
      if (separator !== "}") return false;
      this.position++;
      return this.append(LINE_INDENTS[depth - 1]) && this.append("}");
    }
  }

  private parseArray(depth: number): boolean {
    this.position++;
    if (!this.append("[")) return false;
    this.skipWhitespace();

    if (this.source[this.position] === "]") {
      this.position++;
      return this.append("]");
    }

    while (true) {
      if (!this.append(LINE_INDENTS[depth]) || !this.parseValue(depth)) return false;
      this.skipWhitespace();

      const separator = this.source[this.position];
      if (separator === ",") {
        this.position++;
        if (!this.append(",")) return false;
        this.skipWhitespace();
        continue;
      }
      if (separator !== "]") return false;
      this.position++;
      return this.append(LINE_INDENTS[depth - 1]) && this.append("]");
    }
  }

  private parseString(): boolean {
    const start = this.position;
    if (this.source[this.position] !== '"') return false;
    this.position++;

    while (this.position < this.source.length) {
      const code = this.source.charCodeAt(this.position++);
      if (code === 0x22) return this.append(this.source.slice(start, this.position));
      if (code < 0x20) return false;
      if (code !== 0x5c) continue;
      if (this.position >= this.source.length) return false;

      const escape = this.source[this.position++];
      if (escape === "u") {
        for (let index = 0; index < 4; index++) {
          const hex = this.source.charCodeAt(this.position++);
          const isDigit = hex >= 0x30 && hex <= 0x39;
          const isUpper = hex >= 0x41 && hex <= 0x46;
          const isLower = hex >= 0x61 && hex <= 0x66;
          if (!isDigit && !isUpper && !isLower) return false;
        }
      } else if (!'"\\/bfnrt'.includes(escape)) {
        return false;
      }
    }
    return false;
  }

  private parseNumber(): boolean {
    const start = this.position;
    if (this.source[this.position] === "-") this.position++;

    if (this.source[this.position] === "0") {
      this.position++;
    } else {
      const first = this.source[this.position];
      if (!(first >= "1" && first <= "9")) return false;
      do this.position++;
      while (this.source[this.position] >= "0" && this.source[this.position] <= "9");
    }

    if (this.source[this.position] === ".") {
      this.position++;
      if (!(this.source[this.position] >= "0" && this.source[this.position] <= "9")) return false;
      do this.position++;
      while (this.source[this.position] >= "0" && this.source[this.position] <= "9");
    }

    const exponent = this.source[this.position];
    if (exponent === "e" || exponent === "E") {
      this.position++;
      const sign = this.source[this.position];
      if (sign === "+" || sign === "-") this.position++;
      if (!(this.source[this.position] >= "0" && this.source[this.position] <= "9")) return false;
      do this.position++;
      while (this.source[this.position] >= "0" && this.source[this.position] <= "9");
    }

    return this.append(this.source.slice(start, this.position));
  }

  private parseLiteral(literal: "true" | "false" | "null"): boolean {
    this.position += literal.length;
    return this.append(literal);
  }

  private skipWhitespace(): void {
    while (true) {
      const code = this.source.charCodeAt(this.position);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
      this.position++;
    }
  }
}

/** Pretty-prints complete JSON while preserving every non-whitespace source token. */
export function formatResponseJson(text: string): string | null {
  return new ResponseJsonFormatter(text).format();
}

/** Content types shown as text and handed to scripts as text. */
export function isTextContentType(value: string): boolean {
  const mime = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mime.startsWith("text/")
    || mime === "application/json"
    || mime.endsWith("+json")
    || mime === "application/xml"
    || mime.endsWith("+xml")
    || mime === "application/javascript"
    || mime === "application/x-javascript"
    || mime === "application/x-www-form-urlencoded"
    || mime === "image/svg+xml";
}

export function textDecoderFor(value: string): TextDecoder {
  const match = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/iu.exec(value);
  try {
    return new TextDecoder(match?.[1] || "utf-8");
  } catch {
    return new TextDecoder();
  }
}
