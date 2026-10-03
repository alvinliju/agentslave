import { App } from "@octokit/app";

export type GitHubAppConfig = {
  appId?: string;
  privateKey?: string;
};

export class GitHubAppClient {
  private readonly app: App | null;

  constructor(config: GitHubAppConfig) {
    this.app = config.appId && config.privateKey
      ? new App({ appId: config.appId, privateKey: normalizePrivateKey(config.privateKey) })
      : null;
  }

  configured(): boolean {
    return this.app !== null;
  }

  async installationToken(installationId: number): Promise<string> {
    const app = this.requireApp();
    const response = await app.octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      { installation_id: installationId },
    );
    return response.data.token;
  }

  async createDraftPullRequest(input: {
    installationId: number;
    repository: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<string> {
    const [owner, repo] = splitRepository(input.repository);
    const octokit = await this.requireApp().getInstallationOctokit(input.installationId);
    const response = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner, repo, head: input.head, base: input.base,
      title: input.title, body: input.body, draft: true,
    });
    return response.data.html_url;
  }

  private requireApp(): App {
    if (!this.app) throw new Error("GitHub App is not configured");
    return this.app;
  }
}

function splitRepository(value: string): [string, string] {
  const [owner, repo, extra] = value.split("/");
  if (!owner || !repo || extra) throw new Error(`Invalid GitHub repository: ${value}`);
  return [owner, repo];
}

function normalizePrivateKey(value: string): string {
  return value.replaceAll("\\n", "\n");
}
