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
  exitCode: number;
  exitDetail: string | null;
  finalResponse: string;
  steps: number;
  totalTokens: number;
  transcript: unknown[];
  timedOut: boolean;
};

const authDirectory = "/root/.local/share/opencode";

export class AgentRunner {
  constructor(private readonly config: AgentConfig) {}

  async run(
    executor: WorkspaceExecutor,
    workspace: AgentWorkspace,
    prompt: string,
    files: string[] = [],
    timeoutMs = this.config.timeoutMs,
  ): Promise<AgentRun> {
    if (!this.config.authPath) throw new Error("OPENCODE_AUTH_PATH is not configured");
    const auth = await readFile(this.config.authPath);
    const credentialFile = `${authDirectory}/${this.config.authPath.endsWith(".db") ? "opencode.db" : "auth.json"}`;
    await checked(executor, workspace, ["mkdir", "-p", authDirectory]);
    await checked(executor, workspace, ["tee", credentialFile], auth);
    await checked(executor, workspace, ["chmod", "600", credentialFile]);

    try {
      const command = [
        "opencode", "run",
        "--standalone",
        "--format", "json",
        "--auto",
        "--model", this.config.model,
      ];
      for (const file of files) command.push("--file", file);
      command.push(prompt);
      const result = await executor.execResult(workspace.instanceName, command, {
        cwd: workspace.workingDirectory,
        env: ["OPENCODE_DISABLE_AUTOUPDATE=true", "HOME=/root"],
        timeoutMs,
      });
      const transcript = parseJsonLines(result.stdout);
      return {
        runId: randomUUID(),
        exitCode: result.exitCode,
        exitDetail: result.exitCode === 0 ? null : commandFailureDetail(result),
        finalResponse: finalText(transcript, result.stdout),
        steps: transcript.length,
        totalTokens: tokenCount(transcript),
        transcript,
        timedOut: result.timedOut,
      };
    } finally {
      await executor.execResult(workspace.instanceName, ["rm", "-f", credentialFile])
        .catch(() => undefined);
    }
  }
}

export function commandFailureDetail(result: CommandResult, limit = 2_000): string {
  if (result.timedOut) return "Agent attempt exceeded its time budget.";
  const structuredError = parseJsonLines(result.stdout).reverse()
    .map(extractErrorMessage)
    .find((message): message is string => Boolean(message));
  if (structuredError) return structuredError;
  const output = result.stderr.trim() || result.stdout.trim() || "no output";
  return output.length <= limit ? output : output.slice(-limit);
}

export function isRecoverableImageInputError(detail: string | null): boolean {
  return Boolean(detail && /invalid_image/i.test(detail) && /(minimum of \d+ pixels|\d+x\d+)/i.test(detail));
}

export function reportedBlocker(finalResponse: string): string | null {
  const results = [...finalResponse.matchAll(/^RESULT:\s*(READY_FOR_REVIEW|BLOCKED)\s*$/gim)];
  if (results.at(-1)?.[1]?.toUpperCase() !== "BLOCKED") return null;
  const blocker = finalResponse.match(/^BLOCKER:\s*(.+)$/im)?.[1]?.trim();
  if (blocker && blocker.toLowerCase() !== "none") return blocker;
  return finalResponse.match(/^SUMMARY:\s*(.+)$/im)?.[1]?.trim() || "The agent did not produce a reviewable change.";
}

function extractErrorMessage(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const value = event as { type?: unknown; error?: { message?: unknown } };
  return value.type === "error" && typeof value.error?.message === "string"
    ? value.error.message
    : null;
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
