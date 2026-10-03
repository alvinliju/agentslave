import "dotenv/config";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { runChecked, runCommand } from "./process.js";

const projectArgs = ["--project", config.INCUS_PROJECT];
const builder = `agentslave-image-${randomBytes(4).toString("hex")}`;

const service = `[Unit]
Description=OpenHands Agent Server for AgentSlave
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=DO_NOT_TRACK=1
Environment=OH_TELEMETRY_EXPORTER=none
Environment=OH_TELEMETRY_CONSENT=denied
Environment=OH_SECRET_KEY=agentslave-development-image
ExecStart=/root/.local/bin/agent-server --host 0.0.0.0 --port ${config.INCUS_AGENT_PORT}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

const askpass = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *) cat /run/agentslave/github-token ;;
esac
`;

await ensureProject();
const aliases = await runChecked("incus", [...projectArgs, "image", "alias", "list", "--format", "csv"]);
if (aliases.stdout.split("\n").some((line) => line.split(",")[0] === config.INCUS_IMAGE)) {
  throw new Error(`Incus image alias ${config.INCUS_IMAGE} already exists; refusing to replace it`);
}

console.log(`Launching ${builder} from ${config.INCUS_BASE_IMAGE}`);
await runChecked("incus", [...projectArgs, "launch", config.INCUS_BASE_IMAGE, builder], {
  timeoutMs: 300_000,
});

try {
  await waitForExec();
  await exec(["cloud-init", "status", "--wait"], 300_000);
  await exec(["apt-get", "update"], 300_000);
  await exec([
    "apt-get", "install", "-y", "ca-certificates", "curl", "git", "pipx",
    "python3", "python3-venv", "ripgrep", "tmux",
  ], 600_000);
  await exec(["pipx", "install", "openhands-agent-server"], 900_000);
  await push("/usr/local/bin/agentslave-git-askpass", askpass);
  await exec(["chmod", "755", "/usr/local/bin/agentslave-git-askpass"]);
  await push("/etc/systemd/system/agentslave-openhands.service", service);
  await exec(["systemctl", "daemon-reload"]);
  await exec(["systemctl", "enable", "agentslave-openhands.service"]);
  await runChecked("incus", [...projectArgs, "stop", builder], { timeoutMs: 120_000 });
  await runChecked("incus", [
    ...projectArgs, "publish", builder, "--alias", config.INCUS_IMAGE,
    "--property", "description=AgentSlave OpenHands worker image",
  ], { timeoutMs: 900_000 });
  await runChecked("incus", [...projectArgs, "delete", builder], { timeoutMs: 120_000 });
  console.log(`Published Incus image alias ${config.INCUS_IMAGE}`);
} catch (error) {
  console.error(`Image build failed; ${builder} was left in place for inspection.`);
  throw error;
}

async function ensureProject(): Promise<void> {
  const existing = await runCommand("incus", ["project", "show", config.INCUS_PROJECT]);
  if (existing.exitCode === 0) return;
  await runChecked("incus", ["project", "create", config.INCUS_PROJECT]);
}

async function waitForExec(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await runCommand("incus", [
      ...projectArgs, "exec", builder, "--disable-stdin", "--", "true",
    ], { timeoutMs: 5_000 });
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${builder} did not become ready`);
}

async function exec(command: string[], timeoutMs = 120_000): Promise<void> {
  await runChecked("incus", [
    ...projectArgs, "exec", builder, "--disable-stdin", "--", ...command,
  ], { timeoutMs });
}

async function push(destination: string, content: string): Promise<void> {
  await runChecked("incus", [
    ...projectArgs, "file", "push", "-", `${builder}${destination}`,
  ], { input: content, timeoutMs: 120_000 });
}
