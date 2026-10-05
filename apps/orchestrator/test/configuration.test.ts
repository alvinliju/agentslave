import assert from "node:assert/strict";
import test from "node:test";
import { parseConfigurationCommand, parseGitHubRepository } from "../src/configuration.js";

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
