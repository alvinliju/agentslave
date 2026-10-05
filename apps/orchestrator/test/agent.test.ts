import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentRunner,
  commandFailureDetail,
  isRecoverableImageInputError,
  parseJsonLines,
  reportedBlocker,
  type WorkspaceExecutor,
} from "../src/agent.js";

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
  assert.equal(result.exitCode, 0);
  assert.equal(result.exitDetail, null);
  assert.equal(String(inputs.find((input) => input instanceof Buffer)), "sqlite-credential-store");
  assert.deepEqual(commands.at(-1), ["rm", "-f", "/root/.local/share/opencode/opencode.db"]);
});

test("returns a non-zero OpenCode outcome so the worker can verify produced changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentslave-agent-"));
  const authPath = join(directory, "opencode.db");
  await writeFile(authPath, "sqlite-credential-store");
  const executor: WorkspaceExecutor = {
    async execResult(_instance, command) {
      if (command[0] === "opencode") {
        return {
          exitCode: 1,
          stderr: "InterruptError: All fibers interrupted without error",
          stdout: '{"type":"message","text":"RESULT: READY_FOR_REVIEW"}\n',
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const runner = new AgentRunner({ model: "xai/grok-4.7", authPath, timeoutMs: 60_000 });

  const result = await runner.run(executor, {
    instanceName: "as-test",
    workingDirectory: "/workspace/repository",
  }, "Fix the counter");

  assert.equal(result.exitCode, 1);
  assert.equal(result.exitDetail, "InterruptError: All fibers interrupted without error");
  assert.equal(result.finalResponse, "RESULT: READY_FOR_REVIEW");
});

test("reports the tail of long command failures", () => {
  const detail = commandFailureDetail({ exitCode: 1, stderr: "", stdout: `start-${"x".repeat(50)}-actual error` }, 20);
  assert.equal(detail, "xxxxxxx-actual error");
});

test("extracts provider errors from OpenCode JSON events", () => {
  const detail = commandFailureDetail({
    exitCode: 1,
    stderr: "",
    stdout: '{"type":"step_start"}\n{"type":"error","error":{"message":"invalid_image: image is too small"}}\n',
  });
  assert.equal(detail, "invalid_image: image is too small");
  assert.equal(isRecoverableImageInputError("invalid_image: Image has 256 total pixels (16x16), which is below the minimum of 512 pixels."), true);
  assert.equal(isRecoverableImageInputError("permission denied"), false);
});

test("extracts an explicit blocker and otherwise permits verification", () => {
  assert.equal(reportedBlocker(`RESULT: BLOCKED
SUMMARY: Could not reproduce
VERIFICATION: npm test passed
BLOCKER: Missing production fixture`), "Missing production fixture");
  assert.equal(reportedBlocker(`RESULT: READY_FOR_REVIEW
SUMMARY: Fixed it
VERIFICATION: npm test passed
BLOCKER: none`), null);
  assert.equal(reportedBlocker("OpenCode stopped after editing files."), null);
});

test("reports a time-budget exhaustion distinctly from a provider failure", () => {
  assert.equal(commandFailureDetail({
    exitCode: 1, stderr: "", stdout: "", timedOut: true,
  }), "Agent attempt exceeded its time budget.");
});
