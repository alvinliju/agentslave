import { ContentStore } from "@agentslave/object-store";
import pino, { type Logger } from "pino";
import type { Database } from "./database.js";
import type { GitHubAppClient } from "./github.js";
import type { IncusWorkspace, IncusWorkspaceManager } from "./incus.js";
import type { OpenHandsClient } from "./openhands.js";
import { buildFixPrompt } from "./prompt.js";
import type { Job } from "./types.js";

export type WorkerDependencies = {
  database: Database;
  github: GitHubAppClient;
  workspaces: IncusWorkspaceManager;
  openhands: OpenHandsClient;
  contentStore: ContentStore;
  pollMs: number;
  logger?: Logger;
  notify?: (job: Job, message: string) => Promise<void>;
};

export class Worker {
  private stopped = false;
  private readonly logger: Logger;

  constructor(private readonly dependencies: WorkerDependencies) {
    this.logger = dependencies.logger ?? pino();
  }

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      const worked = await this.tick().catch((error: unknown) => {
        this.logger.error({ error }, "worker tick failed");
        return false;
      });
      if (!worked) await new Promise((resolve) => setTimeout(resolve, this.dependencies.pollMs));
    }
  }

  async tick(): Promise<boolean> {
    const job = await this.dependencies.database.claimNextReady();
    if (!job) return false;
    await this.process(job);
    return true;
  }

  private async process(job: Job): Promise<void> {
    let workspace: IncusWorkspace | null = null;
    try {
      if (!job.repository) throw new Error("Claimed job has no repository");
      const repository = await this.dependencies.database.getRepository(job.repository);
      if (!repository) throw new Error(`Repository ${job.repository} is not registered`);
      if (!this.dependencies.github.configured()) throw new Error("GitHub App is not configured");

      const branchName = `agentslave/${job.id}`;
      workspace = await this.dependencies.workspaces.provision(job.id);
      const token = await this.dependencies.github.installationToken(repository.installationId);
      await this.dependencies.workspaces.cloneRepository(
        workspace, repository.fullName, repository.defaultBranch, branchName, token,
      );
      let current = await this.dependencies.database.transition(
        job.id, "RUNNING", "workspace.ready",
        { instance: workspace.instanceName, agentServerUrl: workspace.agentServerUrl },
        { workspaceInstance: workspace.instanceName, branchName },
      );
      await this.notify(current, `Started OpenHands in Incus instance \`${workspace.instanceName}\`.`);

      const run = await this.dependencies.openhands.run(
        workspace.agentServerUrl, workspace.workingDirectory, buildFixPrompt(current),
      );
      const transcript = await this.dependencies.contentStore.putJson({
        jobId: job.id,
        conversationId: run.conversationId,
        finalResponse: run.finalResponse,
        accumulatedCost: run.accumulatedCost,
      });
      await this.dependencies.database.addArtifact({
        jobId: job.id, kind: "openhands.final", ...transcript,
      });
      current = await this.dependencies.database.transition(
        job.id, "VERIFYING", "agent.finished",
        { conversationId: run.conversationId, accumulatedCost: run.accumulatedCost },
        { openhandsConversationId: run.conversationId },
      );

      const status = await this.dependencies.workspaces.execResult(
        workspace.instanceName, ["git", "status", "--porcelain"],
        { cwd: workspace.workingDirectory },
      );
      if (status.exitCode !== 0) throw new Error(`git status failed: ${status.stderr}`);
      if (!status.stdout.trim()) throw new Error("Agent finished without changing files");
      await this.dependencies.workspaces.exec(
        workspace.instanceName, ["git", "diff", "--check"],
        { cwd: workspace.workingDirectory },
      );
      for (const command of repository.verificationCommands) {
        if (command.length === 0) continue;
        await this.dependencies.workspaces.exec(
          workspace.instanceName, command,
          { cwd: workspace.workingDirectory, timeoutMs: 15 * 60_000 },
        );
      }

      const diffStat = await this.dependencies.workspaces.exec(
        workspace.instanceName, ["git", "diff", "--stat"],
        { cwd: workspace.workingDirectory },
      );
      const pushToken = await this.dependencies.github.installationToken(repository.installationId);
      await this.dependencies.workspaces.commitAndPush(
        workspace, branchName, pushToken, `fix: ${job.title}`,
      );
      const pullRequestUrl = await this.dependencies.github.createDraftPullRequest({
        installationId: repository.installationId,
        repository: repository.fullName,
        head: branchName,
        base: repository.defaultBranch,
        title: `fix: ${job.title}`,
        body: pullRequestBody(current, run.finalResponse, diffStat.stdout),
      });
      current = await this.dependencies.database.transition(
        job.id, "PR_READY", "github.pull_request_opened",
        { url: pullRequestUrl }, { pullRequestUrl },
      );
      await this.notify(current, `Draft pull request ready: ${pullRequestUrl}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error({ jobId: job.id, error }, "job failed");
      const current = await this.dependencies.database.getJob(job.id);
      if (current && current.status !== "FAILED" && current.status !== "CANCELLED") {
        const failed = await this.dependencies.database.transition(
          job.id, "FAILED", "job.failed", { reason }, { failureReason: reason },
        );
        await this.notify(failed, `Run failed: ${reason.slice(0, 500)}`);
      }
    } finally {
      if (workspace && this.dependencies.workspaces.shouldAutoDelete()) {
        await this.dependencies.workspaces.destroy(workspace.instanceName).catch((error: unknown) => {
          this.logger.warn({ error, instance: workspace?.instanceName }, "failed to delete instance");
        });
      }
    }
  }

  private async notify(job: Job, message: string): Promise<void> {
    if (this.dependencies.notify) await this.dependencies.notify(job, message);
  }
}

function pullRequestBody(job: Job, agentSummary: string, diffStat: string): string {
  return `## Bug report

${job.details}

## Agent summary

${agentSummary || "The agent did not provide a final summary."}

## Diff stat

\`\`\`
${diffStat.trim()}
\`\`\`

This is a draft generated by AgentSlave. Human review and merge are required.`;
}
