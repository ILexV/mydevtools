/**
 * Live window links ("pipelines"): one window's result keeps flowing into another
 * window's input, e.g. JSON → TypeScript → hash. Each target follows at most one
 * source; a source can feed several windows; cycles are refused so an update
 * never loops. Links live only in the open desk tab and are never persisted.
 */

export interface WindowLink {
  id: string;
  sourceId: string;
  targetId: string;
}

/** Why a link cannot be made, or null when it can. */
export function linkProblem(links: readonly WindowLink[], sourceId: string, targetId: string): "self" | "taken" | "cycle" | null {
  if (sourceId === targetId) return "self";
  if (links.some((link) => link.targetId === targetId)) return "taken";
  // The new edge closes a loop when the source already follows the target, directly or through others.
  let current: string | undefined = sourceId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === targetId) return "cycle";
    seen.add(current);
    current = links.find((link) => link.targetId === current)?.sourceId;
  }
  return null;
}

export function addLink(links: readonly WindowLink[], link: WindowLink): WindowLink[] {
  return linkProblem(links, link.sourceId, link.targetId) ? [...links] : [...links, link];
}

/** Drops every link that starts or ends at one of these windows. */
export function dropWindows(links: readonly WindowLink[], ids: Iterable<string>): WindowLink[] {
  const gone = new Set(ids);
  return links.filter((link) => !gone.has(link.sourceId) && !gone.has(link.targetId));
}

export function outgoing(links: readonly WindowLink[], sourceId: string): WindowLink[] {
  return links.filter((link) => link.sourceId === sourceId);
}

export function incoming(links: readonly WindowLink[], targetId: string): WindowLink | undefined {
  return links.find((link) => link.targetId === targetId);
}
