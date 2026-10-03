import assert from "node:assert/strict";
import test from "node:test";
import { cleanSlackText, extractRepository, supervise } from "../src/supervisor.js";

test("extracts an owner/repository from a Slack report", () => {
  assert.equal(
    extractRepository("Please investigate checkout in acme/storefront after the release"),
    "acme/storefront",
  );
});

test("asks for the repository when intake is incomplete", () => {
  assert.deepEqual(supervise({
    title: "Checkout is broken",
    details: "The cart resets after I press Back on the payment page.",
    repository: null,
  }), {
    state: "NEEDS_CONTEXT",
    question: "Which GitHub repository should I investigate? Reply with `owner/repository`.",
  });
});

test("marks a sufficiently detailed report ready", () => {
  assert.deepEqual(supervise({
    title: "Checkout is broken",
    details: "The cart resets after I press Back on the payment page.",
    repository: "acme/storefront",
  }), { state: "READY", repository: "acme/storefront" });
});

test("removes Slack mentions and normalizes whitespace", () => {
  assert.equal(cleanSlackText("<@U123>   cart is\n broken"), "cart is broken");
});
