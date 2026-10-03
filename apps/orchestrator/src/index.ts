import "dotenv/config";
import { ContentStore } from "@agentslave/object-store";
import pino from "pino";
import { AgentRunner } from "./agent.js";
import { config } from "./config.js";
import { Database } from "./database.js";
import { GitHubAppClient } from "./github.js";
import { createHttpApp } from "./http.js";
import { IncusWorkspaceManager } from "./incus.js";
import { SlackIntake } from "./slack.js";
import { Worker } from "./worker.js";

const logger = pino({ level: config.NODE_ENV === "development" ? "debug" : "info" });
const database = new Database(config.DATABASE_URL);
const contentStore = new ContentStore({
  root: config.objectStoreRoot,
  ...(config.OBJECT_STORE_BASE_URL ? { baseUrl: config.OBJECT_STORE_BASE_URL } : {}),
});
const github = new GitHubAppClient({
  ...(config.GITHUB_APP_ID ? { appId: config.GITHUB_APP_ID } : {}),
  ...(config.GITHUB_APP_PRIVATE_KEY ? { privateKey: config.GITHUB_APP_PRIVATE_KEY } : {}),
});
const workspaces = new IncusWorkspaceManager({
  project: config.INCUS_PROJECT,
  image: config.INCUS_IMAGE,
  profile: config.INCUS_PROFILE,
  cpu: config.INCUS_CPU,
  memory: config.INCUS_MEMORY,
  autoDelete: config.INCUS_AUTO_DELETE,
});
const agent = new AgentRunner({
  model: config.AGENT_MODEL,
  ...(config.OPENCODE_AUTH_PATH ? { authPath: config.OPENCODE_AUTH_PATH } : {}),
  timeoutMs: config.AGENT_TIMEOUT_MS,
});
const slack = new SlackIntake({
  ...(config.SLACK_BOT_TOKEN ? { botToken: config.SLACK_BOT_TOKEN } : {}),
  ...(config.SLACK_APP_TOKEN ? { appToken: config.SLACK_APP_TOKEN } : {}),
  ...(config.SLACK_SIGNING_SECRET ? { signingSecret: config.SLACK_SIGNING_SECRET } : {}),
  bugChannels: config.slackBugChannels,
}, database, contentStore);
const worker = new Worker({
  database, github, workspaces, agent, contentStore,
  pollMs: config.WORKER_POLL_MS,
  logger,
  notify: (job, message) => slack.notify(job, message),
});

const app = createHttpApp({
  database, workspaces, github, slack,
  ...(config.GITHUB_WEBHOOK_SECRET ? { githubWebhookSecret: config.GITHUB_WEBHOOK_SECRET } : {}),
});
const server = app.listen(config.PORT, "127.0.0.1", () => {
  logger.info({ port: config.PORT }, "orchestrator listening");
});

await slack.start();
if (config.WORKER_ENABLED) {
  workspaces.checkAvailable()
    .then(() => worker.run())
    .catch((error: unknown) => logger.error({ error }, "worker disabled because Incus is unavailable"));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  worker.stop();
  await slack.stop().catch((error: unknown) => logger.warn({ error }, "Slack stop failed"));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await database.close();
  process.exit(0);
}
