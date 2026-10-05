export type ConfigurationCommand = {
  matched: boolean;
  repository: string | null;
};

export type VerificationCommand = {
  matched: boolean;
  command: string[] | null;
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

export function parseVerificationCommand(text: string): VerificationCommand {
  const match = text.trim().match(/^verify(?:\s+(.+))?$/i);
  if (!match) return { matched: false, command: null };
  const source = match[1]?.trim();
  if (!source || /[\r\n]/.test(source)) return { matched: true, command: null };
  const command = tokenizeCommand(source);
  return { matched: true, command: command.length > 0 ? command : null };
}

function tokenizeCommand(value: string): string[] {
  const tokens: string[] = [];
  const pattern = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  for (const token of value.match(pattern) ?? []) {
    const normalized = token.replace(/["']/g, "");
    if (normalized) tokens.push(normalized);
  }
  return tokens;
}
