import pg, { type PoolClient, type QueryResultRow } from "pg";
import type { Artifact, Intake, Job, JobEvent, JobStatus, RepositoryRegistration } from "./types.js";

const transitions: Record<JobStatus, ReadonlySet<JobStatus>> = {
  RECEIVED: new Set(["NEEDS_CONTEXT", "READY", "FAILED", "CANCELLED"]),
  NEEDS_CONTEXT: new Set(["READY", "FAILED", "CANCELLED"]),
  READY: new Set(["PREPARING", "FAILED", "CANCELLED"]),
  PREPARING: new Set(["RUNNING", "FAILED", "CANCELLED"]),
  RUNNING: new Set(["VERIFYING", "FAILED", "CANCELLED"]),
  VERIFYING: new Set(["PR_READY", "FAILED", "CANCELLED"]),
  PR_READY: new Set(["MERGED", "FAILED", "CANCELLED"]),
  MERGED: new Set([]),
  FAILED: new Set(["READY", "CANCELLED"]),
  CANCELLED: new Set([]),
};

type JobPatch = Partial<Pick<Job,
  "repository" | "agentRunId" | "workspaceInstance" | "branchName" |
  "pullRequestUrl" | "failureReason"
>>;

export class Database {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async health(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async createJob(intake: Intake): Promise<Job> {
    return this.transaction((client) => insertJob(client, intake));
  }

  async createSlackJobDeduplicated(intake: Intake): Promise<{ job: Job; created: boolean }> {
    return this.transaction(async (client) => {
      if (intake.repository) {
        const normalized = normalizeReportText(intake.details);
        const lockKey = `${intake.repository}\0${normalized}`;
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
        const duplicate = await client.query(
          `SELECT * FROM jobs
           WHERE repository = $1
             AND lower(regexp_replace(btrim(details), '[[:space:]]+', ' ', 'g')) = $2
             AND status IN ('RECEIVED','NEEDS_CONTEXT','READY','PREPARING','RUNNING','VERIFYING','PR_READY','MERGED')
           ORDER BY created_at ASC
           LIMIT 1`,
          [intake.repository, normalized],
        );
        if (duplicate.rows[0]) {
          const job = mapJob(duplicate.rows[0]);
          await insertEvent(client, job.id, "slack.duplicate_suppressed", {
            channel: intake.slackChannel ?? null,
            threadTs: intake.slackThreadTs ?? null,
          });
          await insertAudit(client, job.id, "intake:slack", "job.duplicate_suppressed", {
            channel: intake.slackChannel ?? null,
            threadTs: intake.slackThreadTs ?? null,
          });
          return { job, created: false };
        }
      }
      return { job: await insertJob(client, intake), created: true };
    });
  }

  async getJob(id: string): Promise<Job | null> {
    const result = await this.pool.query("SELECT * FROM jobs WHERE id = $1", [id]);
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async findJobBySlackThread(channel: string, threadTs: string): Promise<Job | null> {
    const result = await this.pool.query(
      "SELECT * FROM jobs WHERE slack_channel = $1 AND slack_thread_ts = $2",
      [channel, threadTs],
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async findJobByBranch(branchName: string): Promise<Job | null> {
    const result = await this.pool.query("SELECT * FROM jobs WHERE branch_name = $1", [branchName]);
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async listJobs(limit = 50): Promise<Job[]> {
    const result = await this.pool.query(
      "SELECT * FROM jobs ORDER BY created_at DESC LIMIT $1",
      [Math.min(Math.max(limit, 1), 200)],
    );
    return result.rows.map(mapJob);
  }

  async listEvents(jobId: string): Promise<JobEvent[]> {
    const result = await this.pool.query(
      "SELECT * FROM job_events WHERE job_id = $1 ORDER BY id ASC",
      [jobId],
    );
    return result.rows.map(mapEvent);
  }

  async listArtifacts(jobId: string): Promise<Artifact[]> {
    const result = await this.pool.query(
      "SELECT * FROM artifacts WHERE job_id = $1 ORDER BY created_at ASC, id ASC",
      [jobId],
    );
    return result.rows.map(mapArtifact);
  }

  async appendEvent(jobId: string, kind: string, payload: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      "INSERT INTO job_events (job_id, kind, payload) VALUES ($1, $2, $3)",
      [jobId, kind, payload],
    );
  }

  async updateIntake(jobId: string, details: string, repository: string | null): Promise<Job> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE jobs SET details = $2, repository = COALESCE($3, repository), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [jobId, details, repository],
      );
      const job = mapJob(requireRow(result.rows));
      await insertEvent(client, job.id, "intake.updated", { repository });
      return job;
    });
  }

  async transition(
    id: string,
    to: JobStatus,
    kind: string,
    payload: Record<string, unknown> = {},
    patch: JobPatch = {},
  ): Promise<Job> {
    return this.transaction(async (client) => {
      const locked = await client.query("SELECT * FROM jobs WHERE id = $1 FOR UPDATE", [id]);
      const current = mapJob(requireRow(locked.rows));
      if (!transitions[current.status].has(to)) {
        throw new Error(`Invalid job transition ${current.status} -> ${to}`);
      }
      const update = buildJobUpdate(to, patch);
      const result = await client.query(
        `UPDATE jobs SET ${update.assignments.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, ...update.values],
      );
      const job = mapJob(requireRow(result.rows));
      await insertEvent(client, id, kind, { from: current.status, to, ...payload });
      await insertAudit(client, id, "orchestrator", "job.transitioned", {
        from: current.status, to, kind,
      });
      return job;
    });
  }

  async claimNextReady(): Promise<Job | null> {
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT * FROM jobs WHERE status = 'READY'
         ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!selected.rows[0]) return null;
      const current = mapJob(selected.rows[0]);
      const result = await client.query(
        `UPDATE jobs SET status = 'PREPARING', locked_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [current.id],
      );
      await insertEvent(client, current.id, "worker.claimed", {
        from: "READY", to: "PREPARING",
      });
      return mapJob(requireRow(result.rows));
    });
  }

  async registerRepository(repository: RepositoryRegistration): Promise<RepositoryRegistration> {
    const result = await this.pool.query(
      `INSERT INTO repositories (full_name, installation_id, default_branch, verification_commands)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (full_name) DO UPDATE SET
         installation_id = EXCLUDED.installation_id,
         default_branch = EXCLUDED.default_branch,
         verification_commands = EXCLUDED.verification_commands,
         enabled = true,
         updated_at = now()
       RETURNING *`,
      [repository.fullName, repository.installationId, repository.defaultBranch,
        JSON.stringify(repository.verificationCommands)],
    );
    return mapRepository(requireRow(result.rows));
  }

  async getRepository(fullName: string): Promise<RepositoryRegistration | null> {
    const result = await this.pool.query(
      "SELECT * FROM repositories WHERE full_name = $1 AND enabled = true",
      [fullName],
    );
    return result.rows[0] ? mapRepository(result.rows[0]) : null;
  }

  async bindSlackRepository(teamId: string, repository: string, configuredBy?: string): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO slack_repository_bindings (team_id, repository, configured_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (team_id) DO UPDATE SET
           repository = EXCLUDED.repository,
           configured_by = EXCLUDED.configured_by,
           updated_at = now()`,
        [teamId, repository, configuredBy ?? null],
      );
      await insertAudit(client, null, `slack:${configuredBy ?? "unknown"}`, "slack.repository_configured", {
        teamId, repository,
      });
    });
  }

  async getSlackRepository(teamId: string): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT binding.repository
       FROM slack_repository_bindings binding
       JOIN repositories repository ON repository.full_name = binding.repository
       WHERE binding.team_id = $1 AND repository.enabled = true`,
      [teamId],
    );
    return result.rows[0] ? String(result.rows[0].repository) : null;
  }

  async addArtifact(input: {
    jobId: string; kind: string; sha256: string; storageBackend: string;
    storageLocation: string; byteSize: number; contentType: string; sourceUrl?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO artifacts
        (job_id, kind, sha256, storage_backend, storage_location, byte_size, content_type, source_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (job_id, kind, sha256) DO NOTHING`,
      [input.jobId, input.kind, input.sha256, input.storageBackend, input.storageLocation,
        input.byteSize, input.contentType, input.sourceUrl ?? null],
    );
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function buildJobUpdate(to: JobStatus, patch: JobPatch): { assignments: string[]; values: unknown[] } {
  const assignments = ["status = $2"];
  const values: unknown[] = [to];
  const columns: Array<[keyof JobPatch, string]> = [
    ["repository", "repository"],
    ["agentRunId", "agent_run_id"],
    ["workspaceInstance", "workspace_instance"],
    ["branchName", "branch_name"],
    ["pullRequestUrl", "pull_request_url"],
    ["failureReason", "failure_reason"],
  ];
  for (const [key, column] of columns) {
    if (!(key in patch)) continue;
    values.push(patch[key]);
    assignments.push(`${column} = $${values.length + 1}`);
  }
  return { assignments, values };
}

async function insertEvent(
  client: PoolClient,
  jobId: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    "INSERT INTO job_events (job_id, kind, payload) VALUES ($1, $2, $3)",
    [jobId, kind, payload],
  );
}

async function insertJob(client: PoolClient, intake: Intake): Promise<Job> {
  const result = await client.query(
    `INSERT INTO jobs
      (title, details, repository, status, source, slack_channel, slack_thread_ts)
     VALUES ($1, $2, $3, 'RECEIVED', $4, $5, $6)
     RETURNING *`,
    [intake.title, intake.details, intake.repository, intake.source,
      intake.slackChannel ?? null, intake.slackThreadTs ?? null],
  );
  const job = mapJob(requireRow(result.rows));
  await insertEvent(client, job.id, "job.received", { source: intake.source });
  await insertAudit(client, job.id, `intake:${intake.source}`, "job.created", {
    repository: intake.repository,
  });
  return job;
}

async function insertAudit(
  client: PoolClient,
  jobId: string | null,
  actor: string,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  await client.query(
    "INSERT INTO audit_log (job_id, actor, action, details) VALUES ($1, $2, $3, $4)",
    [jobId, actor, action, details],
  );
}

function mapJob(row: QueryResultRow): Job {
  return {
    id: String(row.id), title: String(row.title), details: String(row.details),
    repository: nullableString(row.repository), status: row.status as JobStatus,
    source: row.source as "slack" | "api", slackChannel: nullableString(row.slack_channel),
    slackThreadTs: nullableString(row.slack_thread_ts),
    agentRunId: nullableString(row.agent_run_id),
    workspaceInstance: nullableString(row.workspace_instance), branchName: nullableString(row.branch_name),
    pullRequestUrl: nullableString(row.pull_request_url), failureReason: nullableString(row.failure_reason),
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  };
}

function mapEvent(row: QueryResultRow): JobEvent {
  return { id: Number(row.id), jobId: String(row.job_id), kind: String(row.kind),
    payload: row.payload as Record<string, unknown>, createdAt: new Date(row.created_at) };
}

function mapArtifact(row: QueryResultRow): Artifact {
  return {
    id: String(row.id), jobId: String(row.job_id), kind: String(row.kind),
    sha256: String(row.sha256), storageBackend: String(row.storage_backend),
    storageLocation: String(row.storage_location), byteSize: Number(row.byte_size),
    contentType: String(row.content_type), sourceUrl: nullableString(row.source_url),
    createdAt: new Date(row.created_at),
  };
}

function mapRepository(row: QueryResultRow): RepositoryRegistration {
  return { fullName: String(row.full_name), installationId: Number(row.installation_id),
    defaultBranch: String(row.default_branch),
    verificationCommands: normalizeVerificationCommands(row.verification_commands) };
}

export function normalizeVerificationCommands(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (command): command is string[] => Array.isArray(command) && command.every((part) => typeof part === "string"),
  );
}

export function normalizeReportText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function requireRow(rows: QueryResultRow[]): QueryResultRow {
  const row = rows[0];
  if (!row) throw new Error("Expected database row");
  return row;
}
