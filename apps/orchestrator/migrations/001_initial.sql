CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS repositories (
  full_name text PRIMARY KEY,
  installation_id bigint NOT NULL,
  default_branch text NOT NULL DEFAULT 'main',
  verification_commands jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  details text NOT NULL,
  repository text,
  status text NOT NULL,
  source text NOT NULL,
  slack_channel text,
  slack_thread_ts text,
  openhands_conversation_id text,
  workspace_instance text,
  branch_name text,
  pull_request_url text,
  failure_reason text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_status_check CHECK (status IN ('RECEIVED','NEEDS_CONTEXT','READY','PREPARING','RUNNING','VERIFYING','PR_READY','MERGED','FAILED','CANCELLED')),
  CONSTRAINT jobs_source_check CHECK (source IN ('slack','api'))
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_slack_thread_unique
  ON jobs(slack_channel, slack_thread_ts)
  WHERE slack_channel IS NOT NULL AND slack_thread_ts IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_worker_queue ON jobs(status, created_at);

CREATE TABLE IF NOT EXISTS job_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_events_job_time ON job_events(job_id, created_at, id);

CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind text NOT NULL,
  sha256 text NOT NULL,
  storage_backend text NOT NULL,
  storage_location text NOT NULL,
  byte_size bigint NOT NULL,
  content_type text NOT NULL,
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, kind, sha256)
);

CREATE TABLE IF NOT EXISTS policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  repository_pattern text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  actor text NOT NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
