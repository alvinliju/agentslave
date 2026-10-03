import { setTimeout as delay } from "node:timers/promises";
import { runChecked, runCommand, type CommandResult } from "./process.js";

export type IncusConfig = {
  project: string;
  image: string;
  profile: string;
  cpu: number;
  memory: string;
  autoDelete: boolean;
};

export type IncusWorkspace = {
  instanceName: string;
  workingDirectory: "/workspace/repository";
};

export class IncusWorkspaceManager {
  constructor(private readonly config: IncusConfig) {}

  async checkAvailable(): Promise<void> {
    await runChecked("incus", ["version"], { timeoutMs: 15_000 });
  }

  async ensureProject(): Promise<void> {
    const existing = await runCommand("incus", ["project", "show", this.config.project]);
    if (existing.exitCode !== 0) {
      await runChecked("incus", ["project", "create", this.config.project]);
    }
    const profile = await runChecked("incus", [
      "--project", "default", "profile", "show", "default",
    ]);
    await runChecked("incus", [
      "--project", this.config.project, "profile", "edit", "default",
    ], { input: profile.stdout });
  }

  async provision(jobId: string): Promise<IncusWorkspace> {
    await this.ensureProject();
    const instanceName = `as-${jobId.replaceAll("-", "").slice(0, 16)}`;
    await runChecked("incus", this.args([
      "launch", this.config.image, instanceName,
      "--profile", this.config.profile,
      "--config", `limits.cpu=${this.config.cpu}`,
      "--config", `limits.memory=${this.config.memory}`,
    ]), { timeoutMs: 300_000 });
    await this.waitForExec(instanceName);
    return { instanceName, workingDirectory: "/workspace/repository" };
  }

  async cloneRepository(
    workspace: IncusWorkspace,
    repository: string,
    defaultBranch: string,
    branchName: string,
    token: string,
  ): Promise<void> {
    const tokenPath = "/run/agentslave/github-token";
    await this.exec(workspace.instanceName, ["mkdir", "-p", "/run/agentslave", "/workspace"]);
    await this.push(workspace.instanceName, tokenPath, token);
    await this.exec(workspace.instanceName, ["chmod", "600", tokenPath]);
    try {
      const env = ["GIT_ASKPASS=/usr/local/bin/agentslave-git-askpass", "GIT_TERMINAL_PROMPT=0"];
      await this.exec(workspace.instanceName, [
        "git", "clone", "--branch", defaultBranch, "--single-branch",
        `https://github.com/${repository}.git`, workspace.workingDirectory,
      ], { env, timeoutMs: 300_000 });
      await this.exec(workspace.instanceName, [
        "git", "-C", workspace.workingDirectory, "checkout", "-b", branchName,
      ]);
    } finally {
      await this.exec(workspace.instanceName, ["rm", "-f", tokenPath]).catch(() => undefined);
    }
  }

  async exec(
    instanceName: string,
    command: string[],
    options: { cwd?: string; env?: string[]; input?: string | Buffer; timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    const args = ["exec", instanceName, "--disable-stdin"];
    if (options.input !== undefined) args.splice(2, 1);
    if (options.cwd) args.push("--cwd", options.cwd);
    for (const value of options.env ?? []) args.push("--env", value);
    args.push("--", ...command);
    return runChecked("incus", this.args(args), {
      ...(options.input !== undefined ? { input: options.input } : {}),
      timeoutMs: options.timeoutMs ?? 120_000,
    });
  }

  async execResult(
    instanceName: string,
    command: string[],
    options: { cwd?: string; env?: string[]; input?: string | Buffer; timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    const args = ["exec", instanceName, "--disable-stdin"];
    if (options.input !== undefined) args.splice(2, 1);
    if (options.cwd) args.push("--cwd", options.cwd);
    for (const value of options.env ?? []) args.push("--env", value);
    args.push("--", ...command);
    return runCommand("incus", this.args(args), {
      ...(options.input !== undefined ? { input: options.input } : {}),
      timeoutMs: options.timeoutMs ?? 120_000,
    });
  }

  async commitAndPush(
    workspace: IncusWorkspace,
    branchName: string,
    token: string,
    message: string,
  ): Promise<void> {
    const tokenPath = "/run/agentslave/github-token";
    await this.push(workspace.instanceName, tokenPath, token);
    await this.exec(workspace.instanceName, ["chmod", "600", tokenPath]);
    try {
      await this.exec(workspace.instanceName, ["git", "add", "-A"], {
        cwd: workspace.workingDirectory,
      });
      await this.exec(workspace.instanceName, [
        "git", "-c", "user.name=AgentSlave", "-c", "user.email=agentslave@localhost",
        "commit", "-m", message,
      ], { cwd: workspace.workingDirectory });
      await this.exec(workspace.instanceName, ["git", "push", "-u", "origin", branchName], {
        cwd: workspace.workingDirectory,
        env: ["GIT_ASKPASS=/usr/local/bin/agentslave-git-askpass", "GIT_TERMINAL_PROMPT=0"],
        timeoutMs: 300_000,
      });
    } finally {
      await this.exec(workspace.instanceName, ["rm", "-f", tokenPath]).catch(() => undefined);
    }
  }

  async push(instanceName: string, destination: string, bytes: string | Buffer): Promise<void> {
    await runChecked("incus", this.args(["file", "push", "-", `${instanceName}${destination}`]), {
      input: bytes,
      timeoutMs: 120_000,
    });
  }

  async destroy(instanceName: string): Promise<void> {
    await runChecked("incus", this.args(["delete", instanceName, "--force"]), {
      timeoutMs: 120_000,
    });
  }

  shouldAutoDelete(): boolean {
    return this.config.autoDelete;
  }

  private args(args: string[]): string[] {
    return ["--project", this.config.project, ...args];
  }

  private async waitForExec(instanceName: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 180_000) {
      const result = await runCommand("incus", this.args([
        "exec", instanceName, "--disable-stdin", "--", "true",
      ]), { timeoutMs: 10_000 });
      if (result.exitCode === 0) return;
      await delay(1_000);
    }
    throw new Error(`Incus instance ${instanceName} did not become ready`);
  }

}
