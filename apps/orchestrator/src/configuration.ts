export type ConfigurationCommand = {
  matched: boolean;
  repository: string | null;
};

const repositoryPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export function parseConfigurationCommand(text: string): ConfigurationCommand {
  const match = text.trim().match(/^configure(?:\s+(.+))?$/i);
  if (!match) return { matched: false, repository: null };
  return { matched: true, repository: match[1] ? parseGitHubRepository(match[1]) : null };
}

export function parseGitHubRepository(value: string): string | null {
  const normalized = value.trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git\/?$/i, "")
    .replace(/\/$/, "");
  return repositoryPattern.test(normalized) ? normalized : null;
}
