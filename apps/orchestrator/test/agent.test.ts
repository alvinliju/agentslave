import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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

test("runs Grok through OpenCode and removes the copied credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentslave-agent-"));
  const authPath = join(directory, "auth.json");
  await writeFile(authPath, '{"xai":{"type":"oauth"}}');
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
    model: "xai/grok-4.7",
    authPath,
    timeoutMs: 60_000,
  });

  const result = await runner.run(executor, {
    instanceName: "as-test",
    workingDirectory: "/workspace/repository",
  }, "Fix the counter");

  const opencode = commands.find((command) => command[0] === "opencode");
  assert.ok(opencode?.includes("xai/grok-4.7"));
  assert.equal(result.finalResponse, "Fixed the stale counter and ran npm test.");
  assert.equal(String(inputs.find((input) => input instanceof Buffer)), '{"xai":{"type":"oauth"}}');
  assert.deepEqual(commands.at(-1), ["rm", "-f", "/root/.local/share/opencode/auth.json"]);
});
