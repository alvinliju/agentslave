import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReportText, normalizeVerificationCommands } from "../src/database.js";

test("normalizes malformed verification commands to an empty list", () => {
  assert.deepEqual(normalizeVerificationCommands({}), []);
  assert.deepEqual(normalizeVerificationCommands(null), []);
});

test("keeps only verification commands composed of strings", () => {
  assert.deepEqual(
    normalizeVerificationCommands([["npm", "test"], ["npm", 42], "npm test"]),
    [["npm", "test"]],
  );
});

test("normalizes equivalent Slack reports for duplicate detection", () => {
  assert.equal(
    normalizeReportText("  AgentSlave FAILED\n\nInstance already exists  "),
    normalizeReportText("agentslave failed instance already exists"),
  );
});

test("keeps materially different reports distinct", () => {
  assert.notEqual(
    normalizeReportText("checkout button does not work"),
    normalizeReportText("billing button does not work"),
  );
});
