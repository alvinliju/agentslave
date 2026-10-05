import type { Job } from "./types.js";

export function buildFixPrompt(job: Job): string {
  return `You are fixing one reported bug in an isolated development workspace.

Bug: ${job.title}

Reporter details:
${job.details}

Evidence:
Inspect every attached screenshot before deciding what is broken. Treat the visual evidence and the reporter's text as one bug report.

Required workflow:
1. Inspect the repository and its contributor instructions.
2. Reproduce or identify a deterministic failing case before changing code.
3. Make the smallest durable fix.
4. Add or update focused tests when the repository supports them.
5. Run the relevant verification commands.
6. Leave all changes in the working tree.
7. Always end with this exact result block, even if a tool, test, or dependency failed:

RESULT: READY_FOR_REVIEW | BLOCKED
SUMMARY: <what changed, or why no safe change was possible>
VERIFICATION: <commands run and their outcomes>
BLOCKER: <none, or the precise reason a PR should not be created>

Use READY_FOR_REVIEW only when the working tree contains the intended fix and its relevant verification passed. Use BLOCKED when no safe reviewable change exists. A failed optional investigation command is not a blocker if the implementation and required verification succeeded.

Do not commit, push, open a pull request, access production, or rewrite unrelated code. The orchestrator owns Git and GitHub operations.`;
}
