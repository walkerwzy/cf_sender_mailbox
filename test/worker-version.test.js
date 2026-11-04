import test from "node:test";
import assert from "node:assert/strict";
import { deployWorkerVersion } from "../scripts/worker-version.mjs";

const versionId = "f12e0ef2-c8b3-4ba5-9cd7-13e096efa42f";
const config = { configPath: "worker.json", secretPath: "secrets.json", env: { CLOUDFLARE_API_TOKEN: "test-token" } };

test("rolls out exactly the uploaded version without running domain or route deployment", async () => {
  const calls = [];
  const result = await deployWorkerVersion({ ...config, command: async (args, env) => {
    calls.push(args);
    assert.deepEqual(env, config.env);
    return args[1] === "upload" ? `Uploaded sendmail-cf\nWorker Version ID: ${versionId}\n` : "Deployment complete";
  } });
  assert.equal(result, versionId);
  assert.deepEqual(calls, [
    ["versions", "upload", "--config", config.configPath, "--secrets-file", config.secretPath, "--keep-vars"],
    ["versions", "deploy", "--config", config.configPath, "--version-id", versionId, "--percentage", "100", "--yes"],
  ]);
});

test("never deploys an unspecified latest version when the upload ID is missing", async () => {
  let calls = 0;
  await assert.rejects(deployWorkerVersion({ ...config, command: async () => { calls++; return "Uploaded Worker"; } }), /尚未切换流量/);
  assert.equal(calls, 1);
});
