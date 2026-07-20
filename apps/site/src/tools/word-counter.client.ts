/**
 * Word Counter client. Recomputes stats on every input. Pure JS, no network.
 * Reading time = words/200 wpm; speaking time = words/130 wpm (legacy parity).
 */
interface Stats {
  words: number;
  charsSpaces: number;
  charsNoSpaces: number;
  lines: number;
  paragraphs: number;
  sentences: number;
}

function computeStats(text: string): Stats {
  const words = (text.match(/\S+/g) ?? []).length;
  const charsSpaces = text.length;
  const charsNoSpaces = text.replace(/\s/g, "").length;
  const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
  const paragraphs = (text.split(/\n\s*\n/).filter((p) => p.trim().length > 0)).length;
  const sentences = (text.match(/[^.!?]+[.!?]+/g) ?? []).length + ((/\S/.test(text) && !/[.!?]$/.test(text.trim())) ? 1 : 0);
  return { words, charsSpaces, charsNoSpaces, lines, paragraphs, sentences };
}

function minutes(wpm: number, words: number): number {
  if (words === 0) return 0;
  return Math.max(1, Math.round(words / wpm));
}

interface Strings {
  copy: string;
  copied: string;
  minutes: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-wc-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-wc-tool]");
  if (!root) return;
  const strings = readStrings();
  const textareaEl = root.querySelector<HTMLTextAreaElement>("[data-wc-textarea]");
  if (!textareaEl) return;
  const textarea = textareaEl;

  const els = {
    words: root.querySelector<HTMLElement>("[data-wc-words]"),
    charsSpaces: root.querySelector<HTMLElement>("[data-wc-chars-spaces]"),
    charsNoSpaces: root.querySelector<HTMLElement>("[data-wc-chars-nospaces]"),
    lines: root.querySelector<HTMLElement>("[data-wc-lines]"),
    paragraphs: root.querySelector<HTMLElement>("[data-wc-paragraphs]"),
    sentences: root.querySelector<HTMLElement>("[data-wc-sentences]"),
    reading: root.querySelector<HTMLElement>("[data-wc-reading]"),
    speaking: root.querySelector<HTMLElement>("[data-wc-speaking]"),
  };

  function render() {
    const s = computeStats(textarea.value);
    if (els.words) els.words.textContent = String(s.words);
    if (els.charsSpaces) els.charsSpaces.textContent = String(s.charsSpaces);
    if (els.charsNoSpaces) els.charsNoSpaces.textContent = String(s.charsNoSpaces);
    if (els.lines) els.lines.textContent = String(s.lines);
    if (els.paragraphs) els.paragraphs.textContent = String(s.paragraphs);
    if (els.sentences) els.sentences.textContent = String(s.sentences);
    const minSuffix = strings?.minutes ?? "min";
    if (els.reading) els.reading.textContent = `${minutes(200, s.words)} ${minSuffix}`;
    if (els.speaking) els.speaking.textContent = `${minutes(130, s.words)} ${minSuffix}`;
  }

  textarea.addEventListener("input", render);

  root.querySelector<HTMLButtonElement>("[data-wc-clear]")?.addEventListener("click", () => {
    textarea.value = "";
    render();
    textarea.focus();
  });

  root.querySelector<HTMLButtonElement>("[data-wc-copy]")?.addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(textarea.value);
      const btn = e.currentTarget as HTMLButtonElement;
      const orig = btn.textContent;
      btn.textContent = strings?.copied ?? "Copied";
      setTimeout(() => { btn.textContent = orig; }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  });

  root.querySelector<HTMLButtonElement>("[data-wc-paste]")?.addEventListener("click", async () => {
    try {
      textarea.value = await navigator.clipboard.readText();
      render();
    } catch {
      /* clipboard read blocked */
    }
  });

  render();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
