import test from "node:test";
import assert from "node:assert/strict";
import { r2Config, ensureAttachmentBucket, applyR2Config } from "../scripts/r2-setup.mjs";

const config = { R2_BUCKET_NAME: "mailroom-test", R2_ACCESS_KEY_ID: "test-key-id", R2_SECRET_ACCESS_KEY: "b".repeat(64) };
const options = { accountId: "a".repeat(32), bucketName: config.R2_BUCKET_NAME, origin: "https://mail.wzy.one", log: () => {} };
function fixture(changes = {}) {
  const state = { exists: true, managed: { enabled: false }, custom: { domains: [] }, cors: { rules: [] }, lifecycle: { rules: [] }, ...changes };
  const calls = [];
  const cloudflare = async (path, method = "GET", body) => {
    calls.push({ path, method, body });
    if (path.endsWith("/buckets") && method === "POST") { state.exists = true; return { name: body.name }; }
    if (path.endsWith("/domains/managed")) return state.managed;
    if (path.endsWith("/domains/custom")) return state.custom;
    for (const type of ["cors", "lifecycle"]) {
      if (path.endsWith(`/${type}`)) {
        if (method === "PUT") { state[type] = body; return null; }
        if (state[type] === null) throw Object.assign(new Error("No policy"), { status: 404 });
        return state[type];
      }
    }
    if (!state.exists) throw Object.assign(new Error("Missing bucket"), { status: 404 });
    return { name: config.R2_BUCKET_NAME };
  };
  return { state, calls, cloudflare };
}

test("attachments are optional, partial configuration fails early, and R2 keys are Worker secrets", () => {
  assert.equal(r2Config({}), null);
  assert.throws(() => r2Config({ R2_BUCKET_NAME: "mailroom-test" }), /R2_ACCESS_KEY_ID.*R2_SECRET_ACCESS_KEY/);
  assert.throws(() => r2Config({ ...config, R2_BUCKET_NAME: "BAD/bucket" }), /R2_BUCKET_NAME/);
  const wrangler = { vars: {} }, secrets = {};
  applyR2Config(wrangler, secrets, config, options.accountId);
  assert.deepEqual(wrangler.r2_buckets, [{ binding: "ATTACHMENTS_BUCKET", bucket_name: "mailroom-test" }]);
  assert.equal(wrangler.vars.R2_ACCOUNT_ID, options.accountId);
  assert.equal(wrangler.vars.R2_BUCKET_NAME, config.R2_BUCKET_NAME);
  assert.ok(!JSON.stringify(wrangler).includes(config.R2_SECRET_ACCESS_KEY));
  assert.deepEqual(secrets, { R2_ACCESS_KEY_ID: config.R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY: config.R2_SECRET_ACCESS_KEY });
});

test("setup creates a private bucket, handles absent policies, and subsequent checks perform reads only", async () => {
  const mock = fixture({ exists: false, cors: null, lifecycle: null });
  await ensureAttachmentBucket({ ...options, cloudflare: mock.cloudflare });
  assert.ok(mock.calls.some((call) => call.method === "POST"));
  assert.deepEqual(mock.state.cors.rules[0].allowed.origins, [options.origin]);
  assert.deepEqual(mock.state.cors.rules[0].allowed.methods, ["PUT"]);
  assert.deepEqual(mock.state.cors.rules[0].allowed.headers, ["content-type", "content-disposition", "if-none-match"]);
  assert.equal(mock.state.lifecycle.rules[0].conditions.prefix, "attachment/");
  assert.equal(mock.state.lifecycle.rules[0].deleteObjectsTransition.condition.maxAge, 10 * 86400);
  mock.calls.length = 0;
  await ensureAttachmentBucket({ ...options, cloudflare: mock.cloudflare, checkOnly: true });
  assert.ok(mock.calls.every((call) => call.method === "GET"));
});

test("setup preserves unrelated CORS and lifecycle rules, and read-only checks never repair missing settings", async () => {
  const unrelated = { id: "other-app", enabled: true, conditions: { prefix: "other/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } } };
  const legacy = { id: "mailroom-attachments-expire", enabled: true, conditions: { prefix: "mailroom-attachments/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 10 * 86400 } } };
  const similarlyNamed = { id: "other-attachments", enabled: true, conditions: { prefix: "attachments/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } } };
  const otherCors = { allowed: { origins: ["https://other.example"], methods: ["GET"] } };
  const mock = fixture({ cors: { rules: [otherCors] }, lifecycle: { rules: [unrelated, legacy, similarlyNamed] } });
  await assert.rejects(ensureAttachmentBucket({ ...options, cloudflare: mock.cloudflare, checkOnly: true }), /尚未就绪/);
  assert.ok(mock.calls.every((call) => call.method === "GET"));
  await ensureAttachmentBucket({ ...options, cloudflare: mock.cloudflare });
  assert.deepEqual(mock.state.cors.rules[0], otherCors);
  assert.deepEqual(mock.state.lifecycle.rules.slice(0, 3), [unrelated, legacy, similarlyNamed]);
  assert.equal(mock.state.lifecycle.rules[3].conditions.prefix, "attachment/");
  const missing = fixture({ exists: false });
  await assert.rejects(ensureAttachmentBucket({ ...options, cloudflare: missing.cloudflare, checkOnly: true }), /尚未创建/);
  assert.equal(missing.calls.length, 1);
});

test("existing public buckets are reused without touching r2.dev or custom domains", async () => {
  for (const changes of [
    { managed: { enabled: true } },
    { custom: { domains: [{ enabled: true, domain: "files.example" }] } },
    { managed: { enabled: true }, custom: { domains: [{ enabled: true, domain: "files.example" }] } },
  ]) {
    const mock = fixture(changes);
    const domains = structuredClone({ managed: mock.state.managed, custom: mock.state.custom });
    await ensureAttachmentBucket({ ...options, cloudflare: mock.cloudflare });
    assert.deepEqual({ managed: mock.state.managed, custom: mock.state.custom }, domains);
    assert.ok(mock.calls.every((call) => !call.path.includes("/domains/") && call.method !== "POST"));
    assert.equal(mock.state.lifecycle.rules[0].conditions.prefix, "attachment/");
    mock.calls.length = 0;
    await ensureAttachmentBucket({ ...options, cloudflare: mock.cloudflare, checkOnly: true });
    assert.ok(mock.calls.every((call) => call.method === "GET"));
  }
});

test("existing early deletion rules for attachment/ are rejected without policy mutations", async () => {
  for (const changes of [
    { lifecycle: { rules: [{ id: "expire-all", enabled: true, conditions: { prefix: "" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } } }] } },
    { lifecycle: { rules: [{ id: "expire-parent", enabled: true, conditions: { prefix: "attachment" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } } }] } },
    { lifecycle: { rules: [{ id: "expire-subset", enabled: true, conditions: { prefix: "attachment/abc/" }, deleteObjectsTransition: { condition: { type: "Date", date: "2026-11-05" } } }] } },
  ]) {
    const mock = fixture(changes);
    await assert.rejects(ensureAttachmentBucket({ ...options, cloudflare: mock.cloudflare }), /提前删除/);
    assert.ok(mock.calls.every((call) => call.method === "GET"));
  }
});
