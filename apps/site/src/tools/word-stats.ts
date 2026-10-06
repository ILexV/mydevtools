/**
 * Word counter statistics (pure, DOM-free; unit-tested in test/word-stats.test.ts).
 * Words = whitespace-separated tokens, except Chinese/Japanese runs (no spaces
 * between words) which are split with `Intl.Segmenter` word segmentation.
 * Characters = user-perceived graphemes (emoji / combining marks count as 1),
 * not UTF-16 code units. Reading time 200 wpm, speaking 130 wpm (legacy parity).
 */
export interface TextStats {
  words: number;
  charsSpaces: number;
  charsNoSpaces: number;
  lines: number;
  paragraphs: number;
  sentences: number;
}

/** Han ideographs, Hiragana, Katakana — scripts written without word spaces. */
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** Sentence terminators incl. CJK full stops and the ellipsis character. */
const SENTENCE_RE = /[^.!?。！？…]+[.!?。！？…]+/gu;
const TRAILING_TERMINATOR_RE = /[.!?。！？…]$/u;

type SegmenterCtor = new (
  locale?: string,
  options?: { granularity: "grapheme" | "word" },
) => { segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }> };

function segmenter(granularity: "grapheme" | "word") {
  const Ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  return Ctor ? new Ctor(undefined, { granularity }) : null;
}

/** Number of user-perceived characters (grapheme clusters); code points as fallback. */
export function countGraphemes(text: string): number {
  if (!text) return 0;
  const seg = segmenter("grapheme");
  if (!seg) return Array.from(text).length;
  let n = 0;
  for (const _ of seg.segment(text)) n++;
  return n;
}

/** Word count: 1 per whitespace token; CJK tokens are split into dictionary words. */
export function countWords(text: string): number {
  const tokens = text.match(/\S+/g) ?? [];
  let words = 0;
  let wordSeg: ReturnType<typeof segmenter> | undefined;
  for (const token of tokens) {
    if (!CJK_RE.test(token)) {
      words++;
      continue;
    }
    wordSeg ??= segmenter("word");
    if (!wordSeg) {
      words++;
      continue;
    }
    let inToken = 0;
    for (const s of wordSeg.segment(token)) if (s.isWordLike) inToken++;
    words += Math.max(1, inToken);
  }
  return words;
}

export function computeStats(text: string): TextStats {
  const trimmed = text.trim();
  return {
    words: countWords(text),
    charsSpaces: countGraphemes(text),
    charsNoSpaces: countGraphemes(text.replace(/\s/g, "")),
    lines: text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length,
    paragraphs: text.split(/\r?\n\s*\r?\n/).filter((p) => p.trim().length > 0).length,
    sentences:
      (text.match(SENTENCE_RE) ?? []).filter((s) => /[\p{L}\p{N}]/u.test(s)).length +
      (trimmed && !TRAILING_TERMINATOR_RE.test(trimmed) ? 1 : 0),
  };
}

/** Minutes at `wpm`, rounded, at least 1 for non-empty text (legacy parity). */
export function readingMinutes(words: number, wpm: number): number {
  if (words === 0) return 0;
  return Math.max(1, Math.round(words / wpm));
}
