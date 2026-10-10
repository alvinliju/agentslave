import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { CommandResult } from "./process.js";

export type AgentConfig = {
  provider: "codex" | "opencode";
  model?: string;
  authPath?: string;
  timeoutMs: number;
};

export type AgentWorkspace = {
  instanceName: string;
  workingDirectory: string;
};

export type WorkspaceExecutor = {
  execResult(
    instanceName: string,
    command: string[],
    options?: { cwd?: string; env?: string[]; input?: string | Buffer; timeoutMs?: number },
  ): Promise<CommandResult>;
};

export type AgentRun = {
  runId: string;
  finalResponse: string;
  steps: number;
  totalTokens: number;
  transcript: unknown[];
};

export class AgentRunner {
  constructor(private readonly config: AgentConfig) {}

  async run(
    executor: WorkspaceExecutor,
    workspace: AgentWorkspace,
    prompt: string,
    files: string[] = [],
  ): Promise<AgentRun> {
    if (!this.config.authPath) {
      throw new Error(`${this.config.provider === "codex" ? "CODEX" : "OPENCODE"}_AUTH_PATH is not configured`);
    }
    const auth = await readFile(this.config.authPath);
    const authDirectory = this.config.provider === "codex"
      ? "/root/.codex"
      : "/root/.local/share/opencode";
    const credentialFile = this.config.provider === "codex"
      ? `${authDirectory}/auth.json`
      : `${authDirectory}/${this.config.authPath.endsWith(".db") ? "opencode.db" : "auth.json"}`;
    await checked(executor, workspace, ["mkdir", "-p", authDirectory]);
    await checked(executor, workspace, ["tee", credentialFile], auth);
    await checked(executor, workspace, ["chmod", "600", credentialFile]);

    try {
      const command = this.config.provider === "codex"
        ? [
            "codex", "exec",
            "--json",
            "--ephemeral",
            "--sandbox", "danger-full-access",
            "--ignore-user-config",
          ]
        : [
            "opencode", "run",
            "--standalone",
            "--format", "json",
            "--auto",
          ];
      if (this.config.model) command.push("--model", this.config.model);
      for (const file of files) {
        command.push(this.config.provider === "codex" ? "--image" : "--file", file);
      }
      command.push(prompt);
      const result = await executor.execResult(workspace.instanceName, command, {
        cwd: workspace.workingDirectory,
        env: this.config.provider === "codex"
          ? ["HOME=/root", "CODEX_HOME=/root/.codex"]
          : ["OPENCODE_DISABLE_AUTOUPDATE=true", "HOME=/root"],
        timeoutMs: this.config.timeoutMs,
      });
      if (result.exitCode !== 0) {
        const name = this.config.provider === "codex" ? "Codex" : "OpenCode";
        throw new Error(`${name} failed with ${result.exitCode}: ${(result.stderr || result.stdout).slice(0, 2_000)}`);
      }
      const transcript = parseJsonLines(result.stdout);
      return {
        runId: randomUUID(),
        finalResponse: finalText(transcript, result.stdout),
        steps: transcript.length,
        totalTokens: tokenCount(transcript),
        transcript,
      };
    } finally {
      if (this.config.provider === "codex") {
        const refreshed = await executor.execResult(workspace.instanceName, ["cat", credentialFile], {
          timeoutMs: 30_000,
        }).catch(() => null);
        if (refreshed?.exitCode === 0 && refreshed.stdout.trim()) {
          await writeFile(this.config.authPath, refreshed.stdout, { mode: 0o600 });
        }
      }
      await executor.execResult(workspace.instanceName, ["rm", "-f", credentialFile])
        .catch(() => undefined);
    }
  }
}

async function checked(
  executor: WorkspaceExecutor,
  workspace: AgentWorkspace,
  command: string[],
  input?: Buffer,
): Promise<void> {
  const result = await executor.execResult(workspace.instanceName, command, {
    cwd: workspace.workingDirectory,
    ...(input ? { input } : {}),
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} failed with ${result.exitCode}: ${(result.stderr || result.stdout).slice(0, 1_000)}`);
  }
}

export function parseJsonLines(output: string): unknown[] {
  return output.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    try {
      return [JSON.parse(trimmed) as unknown];
    } catch {
      return [{ type: "text", text: trimmed }];
    }
  });
}

function finalText(events: unknown[], fallback: string): string {
  const texts = events.flatMap((event) => collectStrings(event, new Set(["text", "content", "summary"])))
    .map((value) => value.trim())
    .filter(Boolean);
  const fallbackText = fallback.trim().slice(-4_000);
  return texts.at(-1) ?? (fallbackText || "The coding agent completed without a summary.");
}

function tokenCount(events: unknown[]): number {
  return events.reduce<number>((total, event) => total + collectNumbers(
    event, new Set(["total_tokens", "totalTokens", "tokens", "input_tokens", "output_tokens"]),
  ), 0);
}

function collectStrings(value: unknown, keys: Set<string>): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => collectStrings(entry, keys));
  if (!value || typeof value !== "object") return [];
  const output: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && typeof child === "string") output.push(child);
    else output.push(...collectStrings(child, keys));
  }
  return output;
}

function collectNumbers(value: unknown, keys: Set<string>): number {
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + collectNumbers(entry, keys), 0);
  if (!value || typeof value !== "object") return 0;
  return Object.entries(value).reduce((sum, [key, child]) => {
    if (keys.has(key) && typeof child === "number") return sum + child;
    return sum + collectNumbers(child, keys);
  }, 0);
}
