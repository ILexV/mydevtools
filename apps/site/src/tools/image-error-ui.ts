/**
 * Error box filling for the image tools (compressor / converter / resizer):
 * a localized message plus, optionally, the technical detail as a muted
 * secondary line (`.img-error-detail`, styled in each tool's .astro). Decode
 * failures pass no detail, so raw decoder text never reaches the UI.
 */
export function showImageError(box: HTMLElement, message: string, detail?: string): void {
  if (!detail) {
    box.textContent = message;
  } else {
    const body = document.createElement("span");
    body.append(message);
    const extra = document.createElement("span");
    extra.className = "ds-status img-error-detail";
    extra.dir = "auto";
    extra.textContent = detail;
    body.append(extra);
    box.replaceChildren(body);
  }
  box.hidden = false;
}
