import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVerificationCommands } from "../src/database.js";

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
