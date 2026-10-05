import { App } from "@slack/bolt";
import { ContentStore } from "@agentslave/object-store";
import type { Database } from "./database.js";
import { parseConfigurationCommand } from "./configuration.js";
import type { GitHubAppClient } from "./github.js";
import { evaluateIntake } from "./intake.js";
import { cleanSlackText, extractRepository } from "./supervisor.js";
import type { Job } from "./types.js";

type SlackFile = {
  id: string;
  mimetype?: string;
  name?: string;
  url_private_download?: string;
};

type Mention = {
  channel: string;
  ts: string;
  thread_ts?: string;
  text: string;
  files?: SlackFile[];
};

type SlackEnvelope = { team_id?: string };

export type SlackConfig = {
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  bugChannels: Set<string>;
};

export class SlackIntake {
  private readonly app: App | null;

  constructor(
    private readonly config: SlackConfig,
    private readonly database: Database,
    private readonly contentStore: ContentStore,
    private readonly github: GitHubAppClient,
  ) {
    this.app = config.botToken && config.appToken
      ? new App({
          token: config.botToken,
          appToken: config.appToken,
          signingSecret: config.signingSecret ?? "socket-mode-development",
          socketMode: true,
        })
      : null;
    this.app?.command("/agentslave", async ({ command, ack, respond }) => {
      await ack();
      const configuration = parseConfigurationCommand(command.text);
      if (!configuration.matched || !configuration.repository) {
        await respond("Usage: `/agentslave configure https://github.com/owner/repository`");
        return;
      }
      await respond(await this.configureRepository(
        command.team_id, command.user_id, configuration.repository,
      ));
    });
    this.app?.event("app_mention", async ({ event, body, say }) => {
      const mention = event as unknown as Mention;
      const teamId = (body as SlackEnvelope).team_id;
      if (this.config.bugChannels.size > 0 && !this.config.bugChannels.has(mention.channel)) return;
      const threadTs = mention.thread_ts ?? mention.ts;
      const text = cleanSlackText(mention.text);
      const configuration = parseConfigurationCommand(text);
      if (configuration.matched) {
        const message = teamId && configuration.repository
          ? await this.configureRepository(teamId, undefined, configuration.repository)
          : "Usage: `@AgentSlave configure https://github.com/owner/repository`";
        await say({ text: message, thread_ts: threadTs });
        return;
      }
      const repository = extractRepository(text)
        ?? (teamId ? await this.database.getSlackRepository(teamId) : null);
      const existing = await this.database.findJobBySlackThread(mention.channel, threadTs);
      if (existing) {
        const updated = await this.database.updateIntake(
          existing.id,
          `${existing.details}\n\nSlack follow-up: ${text}`,
          repository,
        );
        const outcome = await evaluateIntake(this.database, updated);
        await say({ text: outcome.message, thread_ts: threadTs });
        return;
      }

      const job = await this.database.createJob({
        title: titleFromText(text),
        details: text,
        repository,
        source: "slack",
        slackChannel: mention.channel,
        slackThreadTs: threadTs,
      });
      await this.storeFiles(job.id, mention.files ?? []);
      const outcome = await evaluateIntake(this.database, job);
      await say({ text: outcome.message, thread_ts: threadTs });
    });
  }

  configured(): boolean {
    return this.app !== null;
  }

  async start(): Promise<void> {
    if (this.app) await this.app.start();
  }

  async stop(): Promise<void> {
    if (this.app) await this.app.stop();
  }

  async notify(job: Job, message: string): Promise<void> {
    if (!this.app || !job.slackChannel || !job.slackThreadTs) return;
    await this.app.client.chat.postMessage({
      channel: job.slackChannel,
      thread_ts: job.slackThreadTs,
      text: message,
    });
  }

  private async configureRepository(
    teamId: string,
    userId: string | undefined,
    repository: string,
  ): Promise<string> {
    if (!this.github.configured()) {
      return "The GitHub App is not configured on AgentSlave yet. Install it first, then retry this command.";
    }
    try {
      const registration = await this.github.discoverRepository(repository);
      await this.database.registerRepository(registration);
      await this.database.bindSlackRepository(teamId, registration.fullName, userId);
      return `Configured this Slack workspace to use \`${registration.fullName}\` (${registration.defaultBranch}).`;
    } catch {
      return `I could not access \`${repository}\`. Install the AgentSlave GitHub App on that repository, then retry.`;
    }
  }

  private async storeFiles(jobId: string, files: SlackFile[]): Promise<void> {
    if (!this.config.botToken) return;
    for (const file of files) {
      if (!file.url_private_download) continue;
      const response = await fetch(file.url_private_download, {
        headers: { authorization: `Bearer ${this.config.botToken}` },
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        await this.database.appendEvent(jobId, "slack.attachment_failed", {
          fileId: file.id, status: response.status,
        });
        continue;
      }
      const contentType = file.mimetype ?? response.headers.get("content-type") ?? "application/octet-stream";
      const stored = await this.contentStore.putBytes(new Uint8Array(await response.arrayBuffer()), contentType);
      await this.database.addArtifact({
        jobId, kind: "slack.attachment", ...stored, sourceUrl: file.url_private_download,
      });
      await this.database.appendEvent(jobId, "slack.attachment_stored", {
        fileId: file.id, name: file.name, sha256: stored.sha256,
      });
    }
  }
}

function titleFromText(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() || "Slack bug report";
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}
