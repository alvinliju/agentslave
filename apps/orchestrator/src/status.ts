import "dotenv/config";
import { config } from "./config.js";
import { Database } from "./database.js";

const database = new Database(config.DATABASE_URL);
try {
  const jobs = await database.listJobs(20);
  if (jobs.length === 0) {
    console.log("No jobs.");
  } else {
    console.table(jobs.map((job) => ({
      id: job.id.slice(0, 8), status: job.status, repository: job.repository ?? "—",
      title: job.title.slice(0, 52), updated: job.updatedAt.toISOString(),
      instance: job.workspaceInstance ?? "—", pr: job.pullRequestUrl ?? "—",
    })));
  }
} finally {
  await database.close();
}
