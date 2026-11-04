import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionSecret } from "../scripts/session-secret.mjs";

test("keeps the same private signing secret across deployments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mailroom-session-"));
  try {
    const first = await getSessionSecret(directory);
    assert.ok(first.length >= 32);
    assert.equal(await getSessionSecret(directory), first);
    assert.equal((await stat(join(directory, "session-secret"))).mode & 0o777, 0o600);
    await assert.rejects(getSessionSecret(directory, "too-short"), /至少需要 32/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
