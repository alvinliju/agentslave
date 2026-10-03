# AgentSlave

AgentSlave is a small Slack-to-pull-request orchestration service. It turns a
threaded bug report into a tracked job, prepares a local workspace, dispatches
an OpenHands conversation, records every transition in PostgreSQL, stores
attachments in a content-addressed object store, runs the coding agent inside
an Incus system container, and opens a draft GitHub pull request for human
review.

This first draft uses one lightweight Incus container per run. It does not use
Docker. The default image is a reusable `agentslave-openhands` image containing
the OpenHands Agent Server and ordinary developer tools.

## Repository layout

```text
apps/orchestrator/        Slack, GitHub, OpenHands, worker and status API
packages/object-store/    Aeomatic-derived SHA-256 immutable object store
upstream/OpenHands/       Shallow clone of Agent Canvas (ignored by this repo)
upstream/software-agent-sdk/  Shallow clone of the OpenHands SDK (ignored)
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
`incus --project agentslave exec <instance> -- bash`. Failed instances are kept
by default so the workspace and agent logs remain inspectable.

Slack is optional during local development. You can enqueue a sample job with:

```bash
curl -X POST http://127.0.0.1:7310/api/jobs \
  -H 'content-type: application/json' \
  -d '{"title":"Cart count is stale","repository":"owner/repo","details":"Removing the final item leaves a count of 1"}'
```

Register a repository before dispatching work:

```bash
curl -X POST http://127.0.0.1:7310/api/repositories \
  -H 'content-type: application/json' \
  -d '{"fullName":"owner/repo","installationId":123456,"defaultBranch":"main"}'
```

## OpenHands

The orchestrator uses the current OpenHands Agent Server REST contract rather
than importing the Python SDK into the TypeScript process. Each Incus instance
runs its own server and exposes it only on the Incus bridge address. The cloned
SDK under `upstream/software-agent-sdk` contains the upstream server and examples.

The agent is instructed to edit and test the prepared working directory but not
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
