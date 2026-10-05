CREATE TABLE IF NOT EXISTS slack_repository_bindings (
  team_id text PRIMARY KEY,
  repository text NOT NULL REFERENCES repositories(full_name),
  configured_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
