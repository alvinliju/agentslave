import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContentStore } from "../src/index.js";

test("stores immutable JSON by digest and reads it", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentslave-cas-"));
  try {
    const store = new ContentStore({ root });
    const payload = { source: "slack", bug: "cart count is stale" };
    const first = await store.putJson(payload);
    const second = await store.putJson(payload);
    assert.deepEqual(first, second);
    assert.match(first.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse((await store.readBytes(first.sha256)).toString()), payload);
    assert.equal((await readFile(join(root, first.storageLocation))).byteLength, first.byteSize);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stores screenshot bytes with a content-derived extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentslave-cas-"));
  try {
    const store = new ContentStore({ root });
    const stored = await store.putBytes(Buffer.from("fake png"), "image/png");
    assert.match(stored.storageLocation, /\.png$/);
    assert.deepEqual(await store.readBytes(stored.sha256, ".png"), Buffer.from("fake png"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
