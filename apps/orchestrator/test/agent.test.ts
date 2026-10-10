import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentRunner, parseJsonLines, type WorkspaceExecutor } from "../src/agent.js";

test("parses OpenCode JSON events while retaining plain output", () => {
  assert.deepEqual(parseJsonLines('{"type":"step","text":"working"}\nplain line\n'), [
    { type: "step", text: "working" },
    { type: "text", text: "plain line" },
  ]);
});

test("runs Grok through OpenCode with the current credential database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentslave-agent-"));
  const authPath = join(directory, "opencode.db");
  await writeFile(authPath, "sqlite-credential-store");
  const commands: string[][] = [];
  const inputs: Array<string | Buffer | undefined> = [];
  const executor: WorkspaceExecutor = {
    async execResult(_instance, command, options = {}) {
      commands.push(command);
      inputs.push(options.input);
      if (command[0] === "opencode") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: '{"type":"message","text":"Fixed the stale counter and ran npm test."}\n',
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const runner = new AgentRunner({
    provider: "opencode",
    model: "xai/grok-4.7",
    authPath,
    timeoutMs: 60_000,
  });

  const result = await runner.run(executor, {
    instanceName: "as-test",
    workingDirectory: "/workspace/repository",
  }, "Fix the counter", ["/workspace/.agentslave/attachments/evidence-1.png"]);

  const opencode = commands.find((command) => command[0] === "opencode");
  assert.ok(opencode?.includes("xai/grok-4.7"));
  assert.deepEqual(
    opencode?.slice(opencode.indexOf("--file"), opencode.indexOf("--file") + 2),
    ["--file", "/workspace/.agentslave/attachments/evidence-1.png"],
  );
  assert.equal(opencode?.includes("--dir"), false);
  assert.equal(result.finalResponse, "Fixed the stale counter and ran npm test.");
  assert.equal(String(inputs.find((input) => input instanceof Buffer)), "sqlite-credential-store");
  assert.deepEqual(commands.at(-1), ["rm", "-f", "/root/.local/share/opencode/opencode.db"]);
});

test("runs Codex with ChatGPT auth and persists refreshed credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentslave-codex-"));
  const authPath = join(directory, "auth.json");
  await writeFile(authPath, "original-auth");
  const commands: string[][] = [];
  const inputs: Array<string | Buffer | undefined> = [];
  const executor: WorkspaceExecutor = {
    async execResult(_instance, command, options = {}) {
      commands.push(command);
      inputs.push(options.input);
      if (command[0] === "codex") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: [
            '{"type":"thread.started","thread_id":"thread-1"}',
            '{"type":"item.completed","item":{"type":"agent_message","text":"Fixed it and ran tests."}}',
            '{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":30}}',
          ].join("\n"),
        };
      }
      if (command[0] === "cat") {
        return { exitCode: 0, stdout: "refreshed-auth", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const runner = new AgentRunner({
    provider: "codex",
    authPath,
    timeoutMs: 60_000,
  });

  const result = await runner.run(executor, {
    instanceName: "as-test",
    workingDirectory: "/workspace/repository",
  }, "Fix the counter", ["/workspace/.agentslave/attachments/evidence-1.png"]);

  const codex = commands.find((command) => command[0] === "codex");
  assert.deepEqual(codex?.slice(0, 7), [
    "codex", "exec", "--json", "--ephemeral", "--sandbox", "danger-full-access", "--ignore-user-config",
  ]);
  assert.deepEqual(
    codex?.slice(codex.indexOf("--image"), codex.indexOf("--image") + 2),
    ["--image", "/workspace/.agentslave/attachments/evidence-1.png"],
  );
  assert.equal(result.finalResponse, "Fixed it and ran tests.");
  assert.equal(result.totalTokens, 150);
  assert.equal(String(inputs.find((input) => input instanceof Buffer)), "original-auth");
  assert.equal(await readFile(authPath, "utf8"), "refreshed-auth");
  assert.deepEqual(commands.at(-1), ["rm", "-f", "/root/.codex/auth.json"]);
});
