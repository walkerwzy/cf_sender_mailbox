import test from "node:test";
import assert from "node:assert/strict";
import { verifyAccess } from "../src/access.js";

const now = 1800000000;
const env = { ACCESS_TEAM_DOMAIN: "walker.cloudflareaccess.com", ACCESS_AUD: "mailroom-audience", ALLOWED_EMAILS: "admin@wzy.one,hi@wzy.one" };
const keyPair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...await crypto.subtle.exportKey("jwk", keyPair.publicKey), kid: "key-1", alg: "RS256", use: "sig" };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function token(overrides = {}, headerOverrides = {}) {
  const header = encode({ alg: "RS256", kid: "key-1", ...headerOverrides });
  const body = encode({ iss: `https://${env.ACCESS_TEAM_DOMAIN}`, aud: [env.ACCESS_AUD], email: "admin@wzy.one", exp: now + 3600, iat: now - 30, ...overrides });
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${Buffer.from(signature).toString("base64url")}`;
}

function request(jwt) { return new Request("https://mail.wzy.one/", { headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {} }); }
function options(keys = [jwk]) { return { now, cache: new Map(), fetcher: async () => Response.json({ keys }) }; }

test("verifies a real RSA signature and permits both configured login emails", async () => {
  for (const email of ["admin@wzy.one", "hi@wzy.one"]) {
    assert.deepEqual(await verifyAccess(request(await token({ email })), env, options()), { email });
  }
});

test("rejects missing auth even when an email header is forged", async () => {
  const forged = new Request("https://mail.wzy.one/", { headers: { "Cf-Access-Authenticated-User-Email": "admin@wzy.one" } });
  await assert.rejects(verifyAccess(forged, env, options()), { status: 401 });
});

test("rejects missing Access configuration", async () => {
  await assert.rejects(verifyAccess(request(), {}, options()), { status: 503 });
});

test("rejects bad issuer, audience, expiry, algorithm, and future timestamps", async () => {
  for (const claims of [{ iss: "https://other.cloudflareaccess.com" }, { aud: ["other-app"] }, { exp: now }, { exp: undefined }, { nbf: now + 120 }, { iat: now + 120 }]) {
    await assert.rejects(verifyAccess(request(await token(claims)), env, options()), { status: 401 });
  }
  await assert.rejects(verifyAccess(request(await token({}, { alg: "none" })), env, options()), { status: 401 });
});

test("rejects a valid token belonging to an unauthorized email", async () => {
  await assert.rejects(verifyAccess(request(await token({ email: "someone@wzy.one" })), env, options()), { status: 403 });
});

test("rejects payload tampering even if the forged email is allowed", async () => {
  const parts = (await token()).split(".");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  parts[1] = encode({ ...payload, email: "hi@wzy.one" });
  await assert.rejects(verifyAccess(request(parts.join(".")), env, options()), { status: 401 });
});

test("refreshes cached public keys after key rotation", async () => {
  let calls = 0;
  const cache = new Map([[env.ACCESS_TEAM_DOMAIN, { keys: [{ ...jwk, kid: "old-key" }], expires: now + 300 }]]);
  const result = await verifyAccess(request(await token()), env, { now, cache, fetcher: async () => { calls++; return Response.json({ keys: [jwk] }); } });
  assert.equal(result.email, "admin@wzy.one");
  assert.equal(calls, 1);
});

test("fails closed when Cloudflare public keys are unavailable", async () => {
  await assert.rejects(verifyAccess(request(await token()), env, { ...options(), fetcher: async () => { throw new TypeError("Network unavailable"); } }), { status: 503 });
});
