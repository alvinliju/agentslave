import type { Job } from "./types.js";

export function buildFixPrompt(
  job: Job,
  evidenceFiles: string[] = [],
  verificationCommands: string[][] = [],
): string {
  return `You are fixing one reported bug in an isolated development workspace.

Bug: ${job.title}

Reporter details:
${job.details}

Evidence:
Inspect every attached screenshot before deciding what is broken. Treat the visual evidence and the reporter's text as one bug report.

## AgentSlave evidence skill

AgentSlave has already retrieved the reported artifacts from object storage and staged them locally. Their manifest is at \`/workspace/.agentslave/evidence.json\`. The only approved visual evidence is attached to this run: ${evidenceFiles.length > 0 ? evidenceFiles.join(", ") : "none"}.

Use attached screenshots to understand the report. Do not use visual/image-reading tools on downloaded, generated, cached, or temporary image files (including favicons, icons, and anything under /tmp). Tiny icon files can be rejected by the model provider. For those files, use metadata-only inspection such as \`file\`, \`identify\`, or Python/PIL size and format checks. Do not fetch the object store directly; ask AgentSlave through your final BLOCKER if additional evidence is required.

Required workflow:
1. Inspect the repository and its contributor instructions. Do not spend more than 2 minutes or 6 exploration commands before moving to a deterministic reproduction.
2. State a concrete acceptance condition, then reproduce or identify a deterministic failing case before changing code.
3. Make the smallest durable fix.
4. Add or update focused tests when the repository supports them.
5. Run the relevant verification commands.
6. Leave all changes in the working tree.
7. Always end with this exact result block, even if a tool, test, or dependency failed:

AgentSlave will independently require these verification commands before it can create a PR:
${verificationCommands.length > 0 ? verificationCommands.map((command) => `- \`${command.join(" ")}\``).join("\n") : "- No commands configured (the orchestrator will refuse to create a PR)."}

RESULT: READY_FOR_REVIEW | BLOCKED
SUMMARY: <what changed, or why no safe change was possible>
SPEC: <the acceptance condition that must pass>
BASELINE: <the failing reproduction or test before the fix>
VERIFICATION: <commands run and their outcomes>
BLOCKER: <none, or the precise reason a PR should not be created>

Use READY_FOR_REVIEW only when the working tree contains the intended fix and its relevant verification passed. Use BLOCKED when no safe reviewable change exists. A failed optional investigation command is not a blocker if the implementation and required verification succeeded.

Do not commit, push, open a pull request, access production, or rewrite unrelated code. The orchestrator owns Git and GitHub operations.`;
}

export function buildImageInputRecoveryPrompt(job: Job, evidenceFiles: string[], verificationCommands: string[][] = []): string {
  return `${buildFixPrompt(job, evidenceFiles, verificationCommands)}

Recovery instruction: a previous attempt stopped because a temporary tiny image was sent to the model provider. Continue from the existing working tree. Do not inspect any non-attached image with a visual/image-reading tool. Use metadata-only commands for favicon files, then implement and verify the smallest safe fix.`;
}

export function buildRepairPrompt(
  job: Job,
  evidenceFiles: string[],
  failedCommand: string[],
  failureOutput: string,
  attempt: number,
  verificationCommands: string[][] = [],
): string {
  return `${buildFixPrompt(job, evidenceFiles, verificationCommands)}

This is repair attempt ${attempt}. The original bug report and acceptance condition still apply. A previous implementation exists in the working tree, but independent verification failed.

Failed command:
\`${failedCommand.join(" ")}\`

Failure output:
\`\`\`
${failureOutput.slice(-4_000)}
\`\`\`

Do not restart broad research. Diagnose this failure, make the smallest correction, and run the failed command plus any focused acceptance test before returning READY_FOR_REVIEW.`;
}
