import assert from "node:assert/strict";
import test from "node:test";
import { parseConfigurationCommand, parseGitHubRepository, parseVerificationCommand } from "../src/configuration.js";
import { buildFixPrompt, buildRepairPrompt } from "../src/prompt.js";

test("parses a configure command with a GitHub URL", () => {
  assert.deepEqual(
    parseConfigurationCommand("configure https://github.com/acme/storefront.git"),
    { matched: true, repository: "acme/storefront" },
  );
});

test("distinguishes normal bug reports from configuration", () => {
  assert.deepEqual(
    parseConfigurationCommand("The configure button is broken"),
    { matched: false, repository: null },
  );
});

test("rejects non-GitHub repository URLs", () => {
  assert.equal(parseGitHubRepository("https://example.com/acme/storefront"), null);
});

test("parses a verification command as argv rather than a shell string", () => {
  assert.deepEqual(
    parseVerificationCommand('verify npm test --workspace="@aeomatic/admin"'),
    { matched: true, command: ["npm", "test", "--workspace=@aeomatic/admin"] },
  );
  assert.deepEqual(parseVerificationCommand("verify"), { matched: true, command: null });
});

test("gives the agent a bounded acceptance-test and repair contract", () => {
  const job = { title: "icons missing", details: "icons do not render" } as never;
  const prompt = buildFixPrompt(job, [], [["npm", "test"]]);
  assert.match(prompt, /acceptance condition/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /6 exploration commands/);
  const repair = buildRepairPrompt(job, [], ["npm", "test"], "expected icon", 2, [["npm", "test"]]);
  assert.match(repair, /repair attempt 2/);
  assert.match(repair, /expected icon/);
});
