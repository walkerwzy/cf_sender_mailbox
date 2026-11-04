import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("Workers runtime supports both login methods, local sessions, sending, outbox and refusing upstream redirects", { timeout: 15000 }, async () => {
  const binary = fileURLToPath(new URL("../node_modules/.bin/workerd", import.meta.url));
  const config = fileURLToPath(new URL("./runtime/workerd.capnp", import.meta.url));
  const result = await promisify(execFile)(binary, ["test", config, "mailroom-runtime:*"]);
  assert.equal((result.stderr.match(/\[ PASS \]/g) || []).length, 7, "All seven Workers runtime tests must run");
});
