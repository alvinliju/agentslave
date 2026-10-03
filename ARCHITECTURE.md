# Architecture

## Flow

```text
Slack thread / HTTP intake
        |
        v
Postgres job + append-only event
        |
        v
Deterministic intake supervisor
        |
        +---- missing repo/context ---> NEEDS_CONTEXT -> Slack question
        |
        v
READY -> worker lease -> Incus instance -> GitHub App checkout
        |                                -> OpenHands Agent Server
        |
        v
local diff -> verification commands -> commit -> push -> draft PR
        |
        v
PR_READY -> human review
```

Slack text and database rows hold structured metadata. Screenshots, recordings,
agent transcripts and large payloads live in the SHA-256 object store; the
database stores their digest, location, type and relationship to a job.

## Job states

- `RECEIVED`: accepted from Slack or the HTTP API.
- `NEEDS_CONTEXT`: the supervisor needs a repository or usable description.
- `READY`: safe to claim by a worker.
- `PREPARING`: GitHub App checkout and job branch creation.
- `RUNNING`: OpenHands is operating in the local workspace.
- `VERIFYING`: the agent finished and deterministic checks are running.
- `PR_READY`: a draft pull request was opened.
- `MERGED`: GitHub reported that a human merged the pull request.
- `FAILED`: the run stopped and the event log contains the reason.
- `CANCELLED`: a human cancelled the run.

The `jobs` row is the current projection. `job_events` is the append-only audit
history. State transitions update both in one database transaction.

## Replaceable boundaries

- `OpenHandsClient`: current Agent Server HTTP adapter; later agents can share
  the same `CodingAgent` interface.
- `GitHubAppClient`: owns installation tokens, checkout, push and draft PRs.
- `ContentStore`: local Aeomatic-compatible CAS today; the same calls can target
  an HTTP CAS later.
- `WorkspaceManager`: one Incus instance per job; another container or microVM
  provider can replace it without changing job state.
- `Supervisor`: deterministic intake rules today; a cheap model can be added
  behind the same output schema.

## Deliberate first-draft trade-offs

There is container isolation, but no egress control, prompt-injection filtering
or multi-tenant authorization yet. GitHub installation credentials are copied
into an instance only for a single Git operation and immediately removed. The
GitHub App cannot merge.
