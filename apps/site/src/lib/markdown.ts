/**
 * Minimal Markdown→HTML for build-time SEO copy (`ToolSeoContent.astro`).
 * Port of the legacy `ToolSeoContent.razor` converter: supports `#`/`##`/`###`
 * headings, `**bold**`, `- ` bullet lists, and paragraphs. Input is trusted
 * locale JSON compiled at build time — no escaping (matches the legacy
 * `MarkupString` behavior).
 */
export function seoMarkdownToHtml(markdown: string): string {
  if (!markdown) return "";

  let html = markdown;
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  const out: string[] = [];
  let inList = false;
  for (const line of html.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${trimmed.slice(2)}</li>`);
    } else {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      // Wrap prose lines; pass through headings and closing tags untouched.
      if (trimmed && !trimmed.startsWith("<h") && !trimmed.startsWith("</")) {
        out.push(`<p>${trimmed}</p>`);
      } else {
        out.push(line);
      }
    }
  }
  if (inList) out.push("</ul>");

  return out.join("\n");
}

export interface HowToStep {
  name: string;
  text: string;
}

/**
 * Parses "### Step N: Title\nBody" markdown into HowTo steps (drives the
 * HowTo JSON-LD in `seo.ts`). Port of `MetaTags.razor` `ParseHowToSteps`:
 * the "Step N:" prefix is dropped from the name, remaining lines become text.
 */
export function parseHowToSteps(markdown: string): HowToStep[] {
  const steps: HowToStep[] = [];
  for (const part of markdown.trim().split(/(?=###\s+Step\s+\d+)/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const nl = trimmed.indexOf("\n");
    const heading = (nl === -1 ? trimmed : trimmed.slice(0, nl))
      .replace(/^#+\s*/, "")
      .replace(/^Step\s+\d+:\s*/, "")
      .trim();
    const text = nl === -1 ? "" : trimmed.slice(nl + 1).trim();
    steps.push({ name: heading, text });
  }
  return steps;
}
