import type { Job } from "./types.js";

export function buildFixPrompt(job: Job): string {
  return `You are fixing one reported bug in an isolated development workspace.

Bug: ${job.title}

Reporter details:
${job.details}

Required workflow:
1. Inspect the repository and its contributor instructions.
2. Reproduce or identify a deterministic failing case before changing code.
3. Make the smallest durable fix.
4. Add or update focused tests when the repository supports them.
5. Run the relevant verification commands.
6. Leave all changes in the working tree and provide a concise final summary.

Do not commit, push, open a pull request, access production, or rewrite unrelated code. The orchestrator owns Git and GitHub operations.`;
}
