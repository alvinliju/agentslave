# AgentSlave

AgentSlave is a small Slack-to-pull-request orchestration service. It turns a
threaded bug report into a tracked job, prepares an isolated workspace, runs a
subscription-backed coding agent, records every transition in PostgreSQL, stores
attachments in a content-addressed object store, runs the coding agent inside
an Incus system container, and opens a draft GitHub pull request for human
review.

This first draft uses one lightweight Incus container per run. It does not use
Docker. The default image is a reusable `agentslave-worker-v3` image containing
Codex, OpenCode, and ordinary developer tools. Codex is the default executor;
OpenCode remains available as an explicitly configured fallback.

## Repository layout

```text
apps/orchestrator/        Slack, GitHub, agent runner, worker and status API
packages/object-store/    Aeomatic-derived SHA-256 immutable object store
```

## First run

1. Create a PostgreSQL database named `agentslave`.
2. Copy `.env.example` to `.env` and fill in the integrations you want to use.
3. Run `npm install`.
4. Install and initialize Incus on a Linux host, then run `npm run incus:image`.
5. Run `npm run migrate`.
6. Run `npm run dev`.

The service exposes `GET /health`, `GET /api/jobs`,
`GET /api/jobs/:id`, and `GET /api/jobs/:id/events` on port 7310. Run
`npm run status` for a terminal view of recent jobs.

For the container-side view, run `incus --project agentslave list` and
`incus --project agentslave exec <instance> -- bash`. Instances are deleted as
soon as their run finishes. The NixOS service also runs an independent reaper
every minute and force-deletes any AgentSlave instance older than one hour,
including workspaces orphaned by a worker crash.

Slack is optional during local development. You can enqueue a sample job with:

```bash
curl -X POST http://127.0.0.1:7310/api/jobs \
  -H 'content-type: application/json' \
  -d '{"title":"Cart count is stale","repository":"owner/repo","details":"Removing the final item leaves a count of 1"}'
```

After installing the Slack and GitHub Apps, bind the workspace once with either:

```text
/agentslave configure https://github.com/owner/repository
@AgentSlave configure https://github.com/owner/repository
```

AgentSlave verifies the GitHub App installation, discovers its installation ID
and default branch, and uses that repository for later reports in the workspace.
The Slack manifest is checked in at `slack/manifest.yaml`.

Register a repository before dispatching work:

```bash
curl -X POST http://127.0.0.1:7310/api/repositories \
  -H 'content-type: application/json' \
  -d '{"fullName":"owner/repo","installationId":123456,"defaultBranch":"main"}'
```

## NixOS service

The flake exports both an immutable application package and a reusable NixOS
module. A host can pin the repository as a flake input, import
`agentslave.nixosModules.default`, and enable the complete service boundary:

```nix
services.agentslave = {
  enable = true;
  incus = {
    enable = true;
    cpu = 2;
    memory = "2GiB";
    autoDelete = true;
    maxAgeSeconds = 3600;
  };
};
```

The module declares the `agentslave` PostgreSQL role/database, migration unit,
state directories, Incus bridge and storage pool, reusable OpenCode image
builder, and the long-running orchestrator. Runtime credentials stay outside
the Nix store in `/var/lib/agentslave-secrets/agentslave.env`.

## Model access

The default provider is Codex using the ChatGPT authentication cache at
`/var/lib/agentslave/.codex/auth.json`. AgentSlave copies that protected cache
into the isolated workspace for `codex exec`, persists any token refresh back to
the service account, and removes the container copy after the run. Set
`AGENT_PROVIDER=opencode`, `AGENT_MODEL=xai/grok-4.7`, and
`OPENCODE_AUTH_PATH=/var/lib/agentslave-secrets/opencode.db` to use the optional
xAI/OpenCode fallback.

Codex and OpenCode are pinned executables inside the worker image, not vendored
source or orchestration dependencies. AgentSlave still owns workspace creation,
verification, Git credentials, commits, draft pull requests, audit events, and
Slack updates. The small `AgentRunner` boundary keeps a later move from
`codex exec` to Codex app-server local to the executor implementation.

The coding agent is instructed to edit and test the prepared working directory but not
to commit, push, or open a PR. AgentSlave owns those steps through the GitHub
App after it sees a non-empty diff.

## Current limits

- Incus must be available on the worker host; macOS can run only the client, so
  the daemon must live on a configured Linux machine.
- One worker process is expected for the first draft.
- The supervisor is deterministic and only checks whether a repository and
  useful bug description exist.
- GitHub webhook check tracking is represented in the schema but not yet used
  to gate PR creation.
- Slack file downloads are retained as content-addressed artifacts.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the state machine and extension
points.
