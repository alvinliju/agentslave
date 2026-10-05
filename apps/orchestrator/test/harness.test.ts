import assert from "node:assert/strict";
import test from "node:test";
import { fallbackLoopSpec, parseLoopSpec } from "../src/harness.js";

const job = { title: "Repair missing icons", details: "icons are absent" } as never;

test("parses a supervisor loop spec into a bounded implementation contract", () => {
  const spec = parseLoopSpec(`LOOP_SPEC:
\`\`\`json
{"objective":"Render product icons","reproduction":"Visit the product grid","acceptance":["Each product has an icon"],"focusedTests":["Add a product-grid test"],"boundary":"Do not alter product data"}
\`\`\``, job);
  assert.equal(spec.objective, "Render product icons");
  assert.deepEqual(spec.acceptance, ["Each product has an icon"]);
  assert.deepEqual(spec.focusedTests, ["Add a product-grid test"]);
});

test("falls back to a conservative loop spec for malformed supervisor output", () => {
  assert.deepEqual(parseLoopSpec("I would inspect the app first.", job), fallbackLoopSpec(job));
});
