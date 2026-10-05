import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Job } from "./types.js";

export type Harness = {
  instructions: string;
  version: string;
};

export type LoopSpec = {
  objective: string;
  reproduction: string;
  acceptance: string[];
  focusedTests: string[];
  boundary: string;
};

export async function loadHarness(path: string): Promise<Harness> {
  const instructions = (await readFile(path, "utf8")).trim();
  if (!instructions) throw new Error(`Harness file is empty: ${path}`);
  return {
    instructions,
    version: createHash("sha256").update(instructions).digest("hex").slice(0, 12),
  };
}

export function fallbackLoopSpec(job: Job): LoopSpec {
  return {
    objective: job.title,
    reproduction: "Identify a deterministic reproduction from the report and repository.",
    acceptance: ["The reported behavior is fixed without unrelated changes."],
    focusedTests: ["Add or update the narrowest relevant automated test when supported."],
    boundary: "Keep the change limited to the reported problem.",
  };
}

export function parseLoopSpec(response: string, job: Job): LoopSpec {
  const match = response.match(/LOOP_SPEC:\s*```json\s*([\s\S]*?)```/i)
    ?? response.match(/LOOP_SPEC:\s*(\{[\s\S]*\})/i);
  const raw = match?.[1];
  if (!raw) return fallbackLoopSpec(job);
  try {
    const value = JSON.parse(raw) as Partial<LoopSpec>;
    if (typeof value.objective !== "string" || !value.objective.trim()) return fallbackLoopSpec(job);
    return {
      objective: value.objective.trim(),
      reproduction: stringValue(value.reproduction, fallbackLoopSpec(job).reproduction),
      acceptance: stringList(value.acceptance, fallbackLoopSpec(job).acceptance),
      focusedTests: stringList(value.focusedTests, fallbackLoopSpec(job).focusedTests),
      boundary: stringValue(value.boundary, fallbackLoopSpec(job).boundary),
    };
  } catch {
    return fallbackLoopSpec(job);
  }
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const values = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim());
  return values.length > 0 ? values.slice(0, 8) : fallback;
}
