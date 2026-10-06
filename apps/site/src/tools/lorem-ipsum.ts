/**
 * Lorem Ipsum logic module — pure generation, no DOM.
 *
 * The word pool and the canonical opening sentence are copied verbatim from the
 * legacy tool (`wwwroot/tools/lorem-ipsum-generator.js`) so the generated text
 * keeps the same character as the original (parity). Sentence/paragraph length
 * ranges (5–15 words, 3–7 sentences) and the classic-start quirks are preserved
 * exactly.
 */

export const LOREM_WORDS: readonly string[] = [
  "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit",
  "sed", "do", "eiusmod", "tempor", "incididunt", "ut", "labore", "et", "dolore",
  "magna", "aliqua", "enim", "ad", "minim", "veniam", "quis", "nostrud",
  "exercitation", "ullamco", "laboris", "nisi", "aliquip", "ex", "ea", "commodo",
  "consequat", "duis", "aute", "irure", "in", "reprehenderit", "voluptate",
  "velit", "esse", "cillum", "fugiat", "nulla", "pariatur", "excepteur", "sint",
  "occaecat", "cupidatat", "non", "proident", "sunt", "culpa", "qui", "officia",
  "deserunt", "mollit", "anim", "id", "est", "laborum", "vivamus", "suspendisse",
  "potenti", "nullam", "ac", "tortor", "vitae", "purus", "faucibus", "ornare",
  "luctus", "cum", "sociis", "natoque", "penatibus", "magnis", "dis", "parturient",
  "montes", "nascetur", "ridiculus", "mus", "donec", "quam", "felis", "ultricies",
  "nec", "pellentesque", "eu", "pretium", "sem", "nulla", "consequat", "massa",
  "quis", "enim", "etiam", "rhoncus", "mauris", "erat", "volutpat", "maecenas",
  "tempus", "tellus", "eget", "condimentum", "nibh", "pulvinar", "sapien", "ligula",
  "venenatis", "lacus", "vel", "scelerisque", "nisl", "consectetur", "pede",
  "metus", "mollis", "justo", "iaculis", "porttitor", "lacinia", "posuere",
  "cubilia", "curae", "proin", "blandit", "odio", "sodales", "tincidunt",
  "integer", "ante", "dapibus", "augue", "facilisis", "gravida", "neque",
  "convallis", "morbi", "vestibulum", "velit", "id", "pretium", "iaculis",
  "diam", "erat", "fermentum", "justo", "nec", "sagittis", "aliquam",
  "malesuada", "bibendum", "arcu", "elementum", "cursus", "turpis", "massa",
  "tincidunt", "dui", "tempus", "viverra", "accumsan", "tortor", "urna",
  "habitant", "tristique", "senectus", "netus", "fames", "nisl", "suscipit",
  "adipiscing", "bibendum", "est", "ultricies", "integer", "quis", "auctor",
];

export const CLASSIC_START =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";

export type LoremType = "paragraphs" | "sentences" | "words";
export type LoremFormat = "plain" | "html" | "markdown";

/** Upper bound for `count` (matches the input's max; protects the tab from freezing). */
export const MAX_COUNT = 1000;
export const DEFAULT_COUNT = 5;

export interface LoremOptions {
  type: LoremType;
  count: number;
  format: LoremFormat;
  startClassic: boolean;
  wrapParagraphs: boolean;
  /** Random source in [0, 1); defaults to Math.random. Inject for deterministic output. */
  rng?: () => number;
}

/**
 * Normalize a requested count: non-finite → default (5, legacy), otherwise
 * floored and clamped to 1..MAX_COUNT (0 / negatives → 1, huge → 1000).
 */
export function clampCount(count: number): number {
  if (!Number.isFinite(count)) return DEFAULT_COUNT;
  return Math.max(1, Math.min(MAX_COUNT, Math.floor(count)));
}

export interface LoremResult {
  text: string;
  words: number;
  chars: number;
}

function randomWord(rng: () => number): string {
  return LOREM_WORDS[Math.floor(rng() * LOREM_WORDS.length)];
}

function generateSentence(rng: () => number, min = 5, max = 15): string {
  const n = Math.floor(rng() * (max - min + 1)) + min;
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(randomWord(rng));
  const joined = words.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1) + ".";
}

function generateParagraph(rng: () => number, min = 3, max = 7): string {
  const n = Math.floor(rng() * (max - min + 1)) + min;
  const sentences: string[] = [];
  for (let i = 0; i < n; i++) sentences.push(generateSentence(rng));
  return sentences.join(" ");
}

/**
 * Generate lorem ipsum text. Mirrors the legacy generator:
 * - `words` + classic: seeds from the canonical sentence (legacy quirk preserved
 *   — only the first comma and the trailing period are stripped, so the seeded
 *   run still contains one comma inside "elit,"), then fills with random words.
 * - `sentences` + classic: the canonical sentence is the first item.
 * - `paragraphs` + classic: the first paragraph is the canonical sentence
 *   followed by one generated paragraph.
 *
 * Count is normalized by `clampCount` (1..1000; non-numeric → 5).
 *
 * Formatting: paragraphs in HTML mode are wrapped in `<p>` only when
 * `wrapParagraphs` is set (matches the "Wrap paragraphs with <p> tags" toggle);
 * markdown/plain paragraphs and all words/sentences output are joined plainly,
 * exactly as the legacy tool did once inline rich-text injection is excluded.
 */
export function generateLorem(opts: LoremOptions): LoremResult {
  const count = clampCount(opts.count);
  const rng = opts.rng ?? Math.random;
  const items: string[] = [];

  if (opts.type === "words") {
    let words: string[] = [];
    if (opts.startClassic) {
      // String-form replace (not regex) — removes only the first match, as legacy.
      words = CLASSIC_START.replace(".", "").toLowerCase().replace(",", "").split(" ");
    }
    while (words.length < count) {
      words.push(randomWord(rng));
    }
    items.push(words.slice(0, count).join(" "));
  } else if (opts.type === "sentences") {
    let remaining = count;
    if (opts.startClassic) {
      items.push(CLASSIC_START);
      remaining--;
    }
    for (let i = 0; i < remaining; i++) items.push(generateSentence(rng));
  } else {
    let remaining = count;
    if (opts.startClassic) {
      items.push(`${CLASSIC_START} ${generateParagraph(rng)}`);
      remaining--;
    }
    for (let i = 0; i < remaining; i++) items.push(generateParagraph(rng));
  }

  let text: string;
  if (opts.type === "paragraphs") {
    if (opts.format === "html" && opts.wrapParagraphs) {
      text = items.map((p) => `<p>${p}</p>`).join("\n\n");
    } else {
      text = items.join("\n\n");
    }
  } else {
    text = items.join(" ");
  }

  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  return { text, words, chars: text.length };
}
