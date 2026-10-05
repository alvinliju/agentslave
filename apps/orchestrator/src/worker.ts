import { ContentStore } from "@agentslave/object-store";
import { extname } from "node:path";
import pino, { type Logger } from "pino";
import {
  isRecoverableImageInputError,
  reportedBlocker,
  type AgentRun,
  type AgentRunner,
} from "./agent.js";
import type { Database } from "./database.js";
import type { GitHubAppClient } from "./github.js";
import type { IncusWorkspace, IncusWorkspaceManager } from "./incus.js";
import { buildFixPrompt, buildImageInputRecoveryPrompt, buildRepairPrompt } from "./prompt.js";
import type { Job } from "./types.js";

export type WorkerDependencies = {
  database: Database;
  github: GitHubAppClient;
  workspaces: IncusWorkspaceManager;
  agent: AgentRunner;
  contentStore: ContentStore;
  pollMs: number;
  maxAgentAttempts: number;
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
      if (repository.verificationCommands.length === 0) {
        throw new Error("No PR was created because this repository has no required verification commands configured. Configure at least one command so AgentSlave can independently prove the reported fix.");
      }

      const branchName = `agentslave/${job.id}`;
      workspace = await this.dependencies.workspaces.provision(job.id);
      const token = await this.dependencies.github.installationToken(repository.installationId);
      await this.dependencies.workspaces.cloneRepository(
        workspace, repository.fullName, repository.defaultBranch, branchName, token,
      );
      let current = await this.dependencies.database.transition(
        job.id, "RUNNING", "workspace.ready",
        { instance: workspace.instanceName },
        { workspaceInstance: workspace.instanceName, branchName },
      );
      await this.notify(current, `Started the coding agent in Incus instance \`${workspace.instanceName}\`.`);

      const attachedFiles = await this.prepareImageAttachments(job.id, workspace);
      let run = await this.dependencies.agent.run(
        this.dependencies.workspaces, workspace,
        buildFixPrompt(current, attachedFiles, repository.verificationCommands), attachedFiles,
      );
      await this.persistAgentRun(job.id, run, 1);
      if (isRecoverableImageInputError(run.exitDetail)) {
        await this.dependencies.database.appendEvent(job.id, "agent.retrying", {
          reason: "tiny_image_provider_rejection",
          previousExitCode: run.exitCode,
        });
        run = await this.dependencies.agent.run(
          this.dependencies.workspaces, workspace,
          buildImageInputRecoveryPrompt(current, attachedFiles, repository.verificationCommands), attachedFiles,
        );
        await this.persistAgentRun(job.id, run, 2);
      }
      if (run.exitCode !== 0) {
        await this.dependencies.database.appendEvent(job.id, "agent.nonzero_exit", {
          exitCode: run.exitCode,
          detail: run.exitDetail,
        });
      }
      current = await this.dependencies.database.transition(
        job.id, "VERIFYING", "agent.finished",
        { runId: run.runId, steps: run.steps, totalTokens: run.totalTokens, exitCode: run.exitCode },
        { agentRunId: run.runId },
      );

      const blocker = reportedBlocker(run.finalResponse);
      if (blocker) throw new Error(`The agent reported that no PR should be created: ${blocker}`);

      if (run.timedOut) {
        throw new Error("Agent time budget exceeded before a reviewable result was reported.");
      }

      let verification = await this.verify(workspace, repository.verificationCommands);
      let agentAttempts = isRecoverableImageInputError(run.exitDetail) ? 2 : 1;
      while (!verification.ok && agentAttempts < this.dependencies.maxAgentAttempts) {
        agentAttempts += 1;
        await this.dependencies.database.appendEvent(job.id, "verification.retrying", {
          attempt: agentAttempts,
          command: verification.command,
          output: verification.output.slice(-4_000),
        });
        run = await this.dependencies.agent.run(
          this.dependencies.workspaces,
          workspace,
          buildRepairPrompt(
            current, attachedFiles, verification.command, verification.output,
            agentAttempts, repository.verificationCommands,
          ),
          attachedFiles,
        );
        await this.persistAgentRun(job.id, run, agentAttempts);
        if (run.timedOut) {
          throw new Error(`Agent repair attempt ${agentAttempts} exceeded its time budget.`);
        }
        const repairBlocker = reportedBlocker(run.finalResponse);
        if (repairBlocker) throw new Error(`The agent reported that no PR should be created: ${repairBlocker}`);
        verification = await this.verify(workspace, repository.verificationCommands);
      }
      if (!verification.ok) {
        throw new Error(`Verification failed after ${agentAttempts} attempt${agentAttempts === 1 ? "" : "s"}: ${verification.command.join(" ")}: ${verification.output}`);
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
        body: pullRequestBody(current, run.finalResponse, diffStat.stdout, run.exitCode, run.exitDetail),
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
        await this.notify(failed, `No PR was created: ${conciseReason(reason)}`);
      }
    } finally {
      if (workspace && this.dependencies.workspaces.shouldAutoDelete()) {
        await this.dependencies.workspaces.destroy(workspace.instanceName).catch((error: unknown) => {
          this.logger.warn({ error, instance: workspace?.instanceName }, "failed to delete instance");
        });
      }
    }
  }

  private async persistAgentRun(jobId: string, run: AgentRun, attempt: number): Promise<void> {
    const transcript = await this.dependencies.contentStore.putJson({
      jobId,
      runId: run.runId,
      attempt,
      exitCode: run.exitCode,
      exitDetail: run.exitDetail,
      finalResponse: run.finalResponse,
      steps: run.steps,
      totalTokens: run.totalTokens,
      transcript: run.transcript,
      timedOut: run.timedOut,
    });
    await this.dependencies.database.addArtifact({
      jobId, kind: "agent.transcript", ...transcript,
    });
    await this.dependencies.database.appendEvent(jobId, "agent.run_recorded", {
      attempt,
      runId: run.runId,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
    });
  }

  private async notify(job: Job, message: string): Promise<void> {
    if (this.dependencies.notify) await this.dependencies.notify(job, message);
  }

  private async verify(
    workspace: IncusWorkspace,
    commands: string[][],
  ): Promise<{ ok: true } | { ok: false; command: string[]; output: string }> {
    const checks = [["git", "status", "--porcelain"], ["git", "diff", "--check"], ...commands];
    for (const command of checks) {
      const result = await this.dependencies.workspaces.execResult(
        workspace.instanceName,
        command,
        { cwd: workspace.workingDirectory, timeoutMs: 15 * 60_000 },
      );
      if (result.timedOut) return { ok: false, command, output: "command exceeded its 15 minute verification budget" };
      if (result.exitCode !== 0) return { ok: false, command, output: (result.stderr || result.stdout || "no output").slice(-4_000) };
      if (command[0] === "git" && command[1] === "status" && !result.stdout.trim()) {
        return { ok: false, command, output: "agent produced no file changes" };
      }
    }
    return { ok: true };
  }

  private async prepareImageAttachments(jobId: string, workspace: IncusWorkspace): Promise<string[]> {
    const artifacts = (await this.dependencies.database.listArtifacts(jobId))
      .filter((artifact) => artifact.kind === "slack.attachment")
      .filter((artifact) => supportedImageTypes.has(artifact.contentType.toLowerCase()))
      .slice(0, 5);
    if (artifacts.length === 0) return [];

    const directory = "/workspace/.agentslave/attachments";
    await this.dependencies.workspaces.exec(workspace.instanceName, ["mkdir", "-p", directory]);
    const paths: string[] = [];
    for (const [index, artifact] of artifacts.entries()) {
      const extension = extname(artifact.storageLocation) || ".bin";
      const destination = `${directory}/evidence-${index + 1}${extension}`;
      const bytes = await this.dependencies.contentStore.readBytes(artifact.sha256, extension);
      await this.dependencies.workspaces.push(workspace.instanceName, destination, bytes);
      paths.push(destination);
    }
    await this.dependencies.workspaces.push(
      workspace.instanceName,
      "/workspace/.agentslave/evidence.json",
      Buffer.from(JSON.stringify({
        version: 1,
        source: "agentslave-object-store",
        artifacts: artifacts.map((artifact, index) => ({
          kind: artifact.kind,
          contentType: artifact.contentType,
          sha256: artifact.sha256,
          path: paths[index],
        })),
      }, null, 2)),
    );
    await this.dependencies.database.appendEvent(jobId, "agent.attachments_prepared", {
      count: paths.length,
      contentTypes: artifacts.map((artifact) => artifact.contentType),
    });
    return paths;
  }
}

const supportedImageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function pullRequestBody(
  job: Job,
  agentSummary: string,
  diffStat: string,
  agentExitCode: number,
  agentExitDetail: string | null,
): string {
  const exitNote = agentExitCode === 0
    ? "The coding agent exited normally."
    : `The coding agent exited with code ${agentExitCode} after producing changes. AgentSlave independently verified the working tree before creating this PR.${agentExitDetail ? `\n\nExit detail:\n\n\`\`\`\n${agentExitDetail}\n\`\`\`` : ""}`;
  return `## Bug report

${job.details}

## Agent summary

${agentSummary || "The agent did not provide a final summary."}

## Agent outcome

${exitNote}

## Diff stat

\`\`\`
${diffStat.trim()}
\`\`\`

This is a draft generated by AgentSlave. Human review and merge are required.`;
}

function conciseReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 497)}...`;
}
