import test from "node:test";
import assert from "node:assert/strict";
import { ensureAccessOrganization } from "../scripts/access-organization.mjs";

const accountId = "95ff672e4bfa649f80840175f2de971f";
const silent = () => {};
function disabledError() {
  return Object.assign(new Error("Access unavailable"), { status: 403, apiErrors: [{ message: "access.api.error.not_enabled: Access is not enabled." }] });
}

test("reuses an existing Zero Trust organization", async () => {
  const organization = { auth_domain: "existing.cloudflareaccess.com" };
  const calls = [];
  assert.equal(await ensureAccessOrganization({ accountId, log: silent, cloudflare: async (path, method) => { calls.push(method || "GET"); return organization; } }), organization);
  assert.deepEqual(calls, ["GET"]);
});

test("attempts API creation after the specific Access-not-enabled 403", async () => {
  const calls = [];
  const result = await ensureAccessOrganization({ accountId, log: silent, cloudflare: async (path, method, body) => {
    calls.push(method || "GET");
    if (!method) throw disabledError();
    assert.equal(body.auth_domain, "walker-95ff672e4b.cloudflareaccess.com");
    return { auth_domain: body.auth_domain };
  } });
  assert.equal(result.auth_domain, "walker-95ff672e4b.cloudflareaccess.com");
  assert.deepEqual(calls, ["GET", "POST"]);
});

test("points to Zero Trust onboarding if API creation is also blocked", async () => {
  const calls = [];
  await assert.rejects(ensureAccessOrganization({ accountId, log: silent, cloudflare: async (path, method) => { calls.push(method || "GET"); throw disabledError(); } }), (error) => {
    assert.equal(error.code, "ACCESS_ONBOARDING_REQUIRED");
    assert.match(error.message, /https:\/\/one\.dash\.cloudflare\.com\//);
    assert.match(error.message, /Free/);
    return true;
  });
  assert.deepEqual(calls, ["GET", "POST"]);
});

test("ordinary 403 permission failures do not trigger organization creation", async () => {
  const permissionError = Object.assign(new Error("Authentication error"), { status: 403, apiErrors: [{ message: "Authentication error" }] });
  const calls = [];
  await assert.rejects(ensureAccessOrganization({ accountId, log: silent, cloudflare: async (path, method) => { calls.push(method || "GET"); throw permissionError; } }), (error) => error === permissionError);
  assert.deepEqual(calls, ["GET"]);
});

test("read-only checking does not attempt creation when Access is disabled", async () => {
  const calls = [];
  await assert.rejects(ensureAccessOrganization({ accountId, checkOnly: true, log: silent, cloudflare: async (path, method) => { calls.push(method || "GET"); throw disabledError(); } }), { code: "ACCESS_ONBOARDING_REQUIRED" });
  assert.deepEqual(calls, ["GET"]);
});
