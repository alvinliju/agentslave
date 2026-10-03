import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CommandResult } from "./process.js";

export type AgentConfig = {
  model: string;
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

const authDirectory = "/root/.local/share/opencode";
const authFile = `${authDirectory}/auth.json`;

export class AgentRunner {
  constructor(private readonly config: AgentConfig) {}

  async run(
    executor: WorkspaceExecutor,
    workspace: AgentWorkspace,
    prompt: string,
  ): Promise<AgentRun> {
    if (!this.config.authPath) throw new Error("OPENCODE_AUTH_PATH is not configured");
    const auth = await readFile(this.config.authPath);
    await checked(executor, workspace, ["mkdir", "-p", authDirectory]);
    await checked(executor, workspace, ["tee", authFile], auth);
    await checked(executor, workspace, ["chmod", "600", authFile]);

    try {
      const result = await executor.execResult(workspace.instanceName, [
        "opencode", "run",
        "--standalone",
        "--format", "json",
        "--auto",
        "--model", this.config.model,
        "--dir", workspace.workingDirectory,
        prompt,
      ], {
        cwd: workspace.workingDirectory,
        env: ["OPENCODE_DISABLE_AUTOUPDATE=true", "HOME=/root"],
        timeoutMs: this.config.timeoutMs,
      });
      if (result.exitCode !== 0) {
        throw new Error(`OpenCode failed with ${result.exitCode}: ${(result.stderr || result.stdout).slice(0, 2_000)}`);
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
      await executor.execResult(workspace.instanceName, ["rm", "-f", authFile])
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
  return texts.at(-1) ?? (fallbackText || "OpenCode completed without a summary.");
}

function tokenCount(events: unknown[]): number {
  return events.reduce<number>((total, event) => total + collectNumbers(
    event, new Set(["total_tokens", "totalTokens", "tokens"]),
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
