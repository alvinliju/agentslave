# AgentSlave harness

This file is the human-editable operating contract for AgentSlave. It is read
for every run and supplied to the loop-spec compiler, executor, and repair
loop. Keep it short, concrete, and repository-agnostic; repository-specific
instructions belong in that repository's `AGENTS.md`.

## Contract

- Human intent and deterministic checks define success; a model's self-report
  does not.
- Compile every task into one narrow acceptance spec before implementation.
- Prefer a focused failing test or deterministic reproduction before editing.
- Make the smallest reviewable change and preserve unrelated code.
- A verifier may reject a model result. Feed its exact failure output into one
  bounded repair attempt rather than restarting research.
- Stop when checks pass, the task is blocked with evidence, or the configured
  budget is exhausted. Never claim success without evidence.

## Roles

- The **supervisor** creates a loop spec: objective, reproduction, acceptance
  conditions, focused tests, and an implementation boundary.
- The **executor** changes code only to satisfy that spec.
- The **verifier** is deterministic: repository checks, tests, typechecks, and
  builds. Its result controls PR creation.
- The **critic** is the repair prompt built from the failed verifier output.

## Economy

- Use the supervisor/frontier model for ambiguity and quality decisions.
- Use the configured executor model for bounded implementation work.
- Do not spend model turns waiting, repeating unchanged research, or narrating
  tool output.
