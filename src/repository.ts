// The repository-name normalizer. One copy serves every place a repository is
// named — the git module's `origin` read, the GitHub Tracker Adapter's `repo`
// option — so two spellings of the same repository cannot drift apart.

export function normalizeRepository(value: string): string {
  return stripRepoDecorations(value).toLowerCase();
}

export function stripRepoDecorations(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
}

export function parseOwnerRepo(url: string): string | undefined {
  const trimmed = stripRepoDecorations(url);
  const ssh = trimmed.match(/^git@[^:]+:(.+\/.+)$/);
  if (ssh?.[1] !== undefined) {
    return ssh[1];
  }
  const path = trimmed.match(/[:/]([^/]+\/[^/]+)$/);
  return path?.[1];
}
