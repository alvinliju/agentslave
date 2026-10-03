import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Database } from "./database.js";
import type { IncusWorkspaceManager } from "./incus.js";
import { evaluateIntake } from "./intake.js";
import type { GitHubAppClient } from "./github.js";
import type { SlackIntake } from "./slack.js";
import type { Job } from "./types.js";

const createJobSchema = z.object({
  title: z.string().trim().min(3).max(200),
  details: z.string().trim().min(3).max(50_000),
  repository: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
});

const repositorySchema = z.object({
  fullName: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/),
  installationId: z.number().int().positive(),
  defaultBranch: z.string().trim().min(1).default("main"),
  verificationCommands: z.array(z.array(z.string().min(1)).min(1)).default([]),
});

export function createHttpApp(dependencies: {
  database: Database;
  workspaces: IncusWorkspaceManager;
  github: GitHubAppClient;
  slack: SlackIntake;
  githubWebhookSecret?: string;
}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.post("/github/events", express.raw({ type: "application/json", limit: "2mb" }), async (request, response) => {
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
    if (dependencies.githubWebhookSecret && !validGitHubSignature(
      body,
      request.header("x-hub-signature-256"),
      dependencies.githubWebhookSecret,
    )) {
      return response.status(401).json({ error: "invalid_signature" });
    }
    const eventName = request.header("x-github-event") ?? "unknown";
    const payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    const branch = githubBranch(payload, eventName);
    if (!branch) return response.status(202).json({ accepted: true, matched: false });
    const job = await dependencies.database.findJobByBranch(branch);
    if (!job) return response.status(202).json({ accepted: true, matched: false });
    await dependencies.database.appendEvent(job.id, `github.${eventName}`, compactGitHubEvent(payload, eventName));
    if (eventName === "pull_request" && pullRequestMerged(payload) && job.status === "PR_READY") {
      const merged = await dependencies.database.transition(
        job.id, "MERGED", "github.pull_request_merged", {},
      );
      await dependencies.slack.notify(merged, `Pull request merged for \`${merged.id}\`.`);
    }
    return response.status(202).json({ accepted: true, matched: true, jobId: job.id });
  });
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", async (_request, response) => {
    const [database, incus] = await Promise.allSettled([
      dependencies.database.health(), dependencies.workspaces.checkAvailable(),
    ]);
    const state = database.status === "fulfilled" && incus.status === "fulfilled"
      ? "ready" : database.status === "fulfilled" ? "degraded" : "unavailable";
    response.status(database.status === "fulfilled" ? 200 : 503).json({
      contractVersion: 1,
      state,
      asOf: new Date().toISOString(),
      dependencies: {
        postgres: database.status === "fulfilled" ? "ready" : "failed",
        incus: incus.status === "fulfilled" ? "ready" : "failed",
        github: dependencies.github.configured() ? "configured" : "missing_config",
        slack: dependencies.slack.configured() ? "configured" : "disabled",
      },
    });
  });

  app.get("/api/jobs", async (request, response) => {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(request.query.limit);
    const jobs = await dependencies.database.listJobs(limit);
    response.json({ contractVersion: 1, asOf: new Date().toISOString(), data: jobs.map(jsonJob) });
  });

  app.get("/api/jobs/:id", async (request, response) => {
    const job = await dependencies.database.getJob(request.params.id ?? "");
    if (!job) return response.status(404).json({ error: "job_not_found" });
    return response.json({ contractVersion: 1, data: jsonJob(job) });
  });

  app.get("/api/jobs/:id/events", async (request, response) => {
    const job = await dependencies.database.getJob(request.params.id ?? "");
    if (!job) return response.status(404).json({ error: "job_not_found" });
    const events = await dependencies.database.listEvents(job.id);
    return response.json({ contractVersion: 1, data: events.map((event) => ({
      ...event, createdAt: event.createdAt.toISOString(),
    })) });
  });

  app.post("/api/jobs", async (request, response) => {
    const input = createJobSchema.parse(request.body);
    const job = await dependencies.database.createJob({
      title: input.title, details: input.details,
      repository: input.repository ?? null, source: "api",
    });
    const outcome = await evaluateIntake(dependencies.database, job);
    response.status(201).json({ contractVersion: 1, data: jsonJob(outcome.job), message: outcome.message });
  });

  app.post("/api/repositories", async (request, response) => {
    const input = repositorySchema.parse(request.body);
    const repository = await dependencies.database.registerRepository(input);
    response.status(201).json({ contractVersion: 1, data: repository });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "invalid_request", issues: error.issues });
      return;
    }
    const message = error instanceof Error ? error.message : "unknown error";
    response.status(500).json({ error: "internal_error", message });
  });
  return app;
}

function validGitHubSignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function githubBranch(payload: Record<string, unknown>, eventName: string): string | null {
  if (eventName === "pull_request") {
    return nestedString(payload, "pull_request", "head", "ref");
  }
  if (eventName === "check_run") {
    return nestedString(payload, "check_run", "check_suite", "head_branch");
  }
  if (eventName === "check_suite") {
    return nestedString(payload, "check_suite", "head_branch");
  }
  return null;
}

function compactGitHubEvent(payload: Record<string, unknown>, eventName: string): Record<string, unknown> {
  return {
    action: typeof payload.action === "string" ? payload.action : null,
    eventName,
    checkName: nestedString(payload, "check_run", "name"),
    checkStatus: nestedString(payload, "check_run", "status"),
    conclusion: nestedString(payload, "check_run", "conclusion"),
    pullRequestUrl: nestedString(payload, "pull_request", "html_url"),
    merged: pullRequestMerged(payload),
  };
}

function pullRequestMerged(payload: Record<string, unknown>): boolean {
  return nestedValue(payload, "pull_request", "merged") === true;
}

function nestedString(value: unknown, ...path: string[]): string | null {
  const found = nestedValue(value, ...path);
  return typeof found === "string" ? found : null;
}

function nestedValue(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function jsonJob(job: Job): Record<string, unknown> {
  return { ...job, createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString() };
}
