import type { Job } from "./types.js";

export type SupervisorDecision =
  | { state: "READY"; repository: string }
  | { state: "NEEDS_CONTEXT"; question: string };

export function supervise(job: Pick<Job, "title" | "details" | "repository">): SupervisorDecision {
  const repository = job.repository ?? extractRepository(`${job.title}\n${job.details}`);
  if (!repository) {
    return {
      state: "NEEDS_CONTEXT",
      question: "Which GitHub repository should I investigate? Reply with `owner/repository`.",
    };
  }
  if ((job.title.trim().length + job.details.trim().length) < 24) {
    return {
      state: "NEEDS_CONTEXT",
      question: "What happened, what did you expect, and how can I reproduce it?",
    };
  }
  return { state: "READY", repository };
}

export function extractRepository(text: string): string | null {
  const candidates = text.match(/\b[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\b/g) ?? [];
  return candidates.find((candidate) => !candidate.includes("http")) ?? null;
}

export function cleanSlackText(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").replace(/\s+/g, " ").trim();
}
