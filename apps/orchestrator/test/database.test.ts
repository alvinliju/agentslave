import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeReportText,
  normalizeVerificationCommands,
  reportLockKey,
} from "../src/database.js";

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

test("builds an unambiguous PostgreSQL-safe advisory lock key", () => {
  const key = reportLockKey("owner/repository", "Instance already exists");
  assert.equal(key.includes("\0"), false);
  assert.notEqual(
    reportLockKey("owner/repository-a", "b collision"),
    reportLockKey("owner/repository", "a b collision"),
  );
});
