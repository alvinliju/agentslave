import "dotenv/config";
import { resolve } from "node:path";
import { z } from "zod";

const booleanText = z.string().default("true").transform((value) => value.toLowerCase() === "true");
const optionalText = z.string().trim().optional().transform((value) => value || undefined);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(7310),
  DATABASE_URL: z.string().min(1).default("postgresql://postgres:postgres@127.0.0.1:5432/agentslave"),
  OBJECT_STORE_ROOT: z.string().default(resolve(process.cwd(), "data/objects")),
  OBJECT_STORE_BASE_URL: optionalText,
  INCUS_PROJECT: z.string().default("agentslave"),
  INCUS_IMAGE: z.string().default("agentslave-worker"),
  INCUS_BASE_IMAGE: z.string().default("images:ubuntu/24.04/cloud"),
  INCUS_PROFILE: z.string().default("default"),
  INCUS_CPU: z.coerce.number().int().positive().default(4),
  INCUS_MEMORY: z.string().default("8GiB"),
  INCUS_AUTO_DELETE: z.string().default("true").transform((value) => value.toLowerCase() === "true"),
  SLACK_BOT_TOKEN: optionalText,
  SLACK_SIGNING_SECRET: optionalText,
  SLACK_APP_TOKEN: optionalText,
  SLACK_BUG_CHANNELS: z.string().default(""),
  GITHUB_APP_ID: optionalText,
  GITHUB_APP_PRIVATE_KEY: optionalText,
  GITHUB_WEBHOOK_SECRET: optionalText,
  AGENT_MODEL: z.string().default("xai/grok-4.7"),
  OPENCODE_AUTH_PATH: optionalText,
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(45 * 60_000),
  WORKER_ENABLED: booleanText,
  WORKER_POLL_MS: z.coerce.number().int().min(250).default(2000),
});

const parsed = schema.parse(process.env);

export const config = {
  ...parsed,
  objectStoreRoot: resolve(parsed.OBJECT_STORE_ROOT),
  slackBugChannels: new Set(parsed.SLACK_BUG_CHANNELS.split(",").map((value) => value.trim()).filter(Boolean)),
};
