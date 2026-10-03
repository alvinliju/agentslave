import type { Database } from "./database.js";
import { supervise } from "./supervisor.js";
import type { Job } from "./types.js";

export type IntakeOutcome = {
  job: Job;
  message: string;
};

export async function evaluateIntake(database: Database, job: Job): Promise<IntakeOutcome> {
  const decision = supervise(job);
  if (decision.state === "NEEDS_CONTEXT") {
    if (job.status === "RECEIVED") {
      const updated = await database.transition(
        job.id, "NEEDS_CONTEXT", "supervisor.needs_context", { question: decision.question },
      );
      return { job: updated, message: decision.question };
    }
    await database.appendEvent(job.id, "supervisor.needs_context", { question: decision.question });
    return { job, message: decision.question };
  }

  const registration = await database.getRepository(decision.repository);
  if (!registration) {
    const message = `I found \`${decision.repository}\`, but it is not registered yet. Add its GitHub App installation before I run it.`;
    const patch = { repository: decision.repository };
    if (job.status === "RECEIVED") {
      const updated = await database.transition(
        job.id, "NEEDS_CONTEXT", "supervisor.repository_unregistered",
        { repository: decision.repository }, patch,
      );
      return { job: updated, message };
    }
    await database.appendEvent(job.id, "supervisor.repository_unregistered", {
      repository: decision.repository,
    });
    return { job, message };
  }

  if (job.status !== "RECEIVED" && job.status !== "NEEDS_CONTEXT" && job.status !== "FAILED") {
    return { job, message: `Run \`${job.id}\` is already ${job.status.toLowerCase()}.` };
  }
  const updated = await database.transition(
    job.id, "READY", "supervisor.ready", { repository: decision.repository },
    { repository: decision.repository, failureReason: null },
  );
  return { job: updated, message: `Queued run \`${updated.id}\` for \`${decision.repository}\`.` };
}
