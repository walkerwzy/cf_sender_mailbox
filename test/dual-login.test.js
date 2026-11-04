import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/worker.js";
import { issueSession, verifySession } from "../src/session.js";

const origin = "https://mail.wzy.one";
const now = Date.parse("2026-11-04T10:00:00Z") / 1000;
const options = { now };
const env = {
  LOGIN_MODE: "dual", LOGIN_PASSWORD: "test-prefix", SESSION_SECRET: "test-signing-secret-at-least-32-characters",
  ALLOWED_EMAILS: "admin@wzy.one,hi@wzy.one", ACCESS_TEAM_DOMAIN: "walker.cloudflareaccess.com", ACCESS_AUD: "audience", RESEND_API_KEY: "test-resend-key",
  LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) }, SEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
  ASSETS: { fetch: async (request) => new Response(new URL(request.url).pathname, { headers: { "Content-Type": "text/html" } }) },
};
function login(data = { email: "hi@wzy.one", password: "test-prefix1104" }, headers = {}) {
  return new Request(`${origin}/api/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.1", ...headers }, body: JSON.stringify(data) });
}

test("public login assets and options contain no secrets while mail APIs remain protected", async () => {
  for (const path of ["/login", "/login.js", "/styles.css", "/favicon.svg"]) assert.equal((await handleRequest(new Request(origin + path), env, {}, options)).status, 200);
  const config = await handleRequest(new Request(origin + "/api/login-options"), env, {}, options);
  assert.deepEqual(await config.json(), { emails: ["admin@wzy.one", "hi@wzy.one"], dateSuffix: "1104", accessUrl: "/auth/access" });
  const root = await handleRequest(new Request(origin), env, {}, options);
  assert.equal(root.status, 303);
  assert.equal(root.headers.get("Location"), "/login");
  for (const path of ["/api/session", "/api/send"]) assert.equal((await handleRequest(new Request(origin + path), env, {}, options)).status, 401);
  assert.equal((await handleRequest(new Request(origin + "/auth/access"), env, {}, options)).status, 401);
});

test("serves the clean login URL without triggering Static Assets' .html redirect loop", async () => {
  const assets = { fetch: async (request) => {
    if (new URL(request.url).pathname === "/login.html") return new Response(null, { status: 307, headers: { Location: "/login" } });
    return new Response("Login page", { headers: { "Content-Type": "text/html" } });
  } };
  const response = await handleRequest(new Request(origin + "/login"), { ...env, ASSETS: assets }, {}, options);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Login page");
});

test("password login signs the selected allowed identity and sending ignores client sender overrides", async () => {
  const response = await handleRequest(login(), env, {}, options);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("Set-Cookie").split(";")[0];
  const identity = await verifySession(new Request(origin, { headers: { Cookie: cookie } }), env, options);
  assert.deepEqual(identity, { email: "hi@wzy.one", method: "password" });
  const session = await handleRequest(new Request(origin + "/api/session", { headers: { Cookie: cookie } }), env, {}, options);
  assert.equal((await session.json()).from, "walker <hi@wzy.one>");
  let sender;
  const sent = await handleRequest(new Request(origin + "/api/send", { method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": "f12e0ef2-c8b3-4ba5-9cd7-13e096efa42f" }, body: JSON.stringify({ to: "recipient@example.com", subject: "Hello", body: "hello", format: "text", from: "attacker@example.com" }) }), env, {}, { ...options, sendMail: async (mail) => { sender = mail.from; return { id: "mock-id" }; } });
  assert.equal(sent.status, 200);
  assert.equal(sender, "walker <hi@wzy.one>");
});

test("rejects wrong passwords, adjacent dates, and unapproved identities without setting a cookie", async () => {
  for (const data of [{ email: "hi@wzy.one", password: "bad" }, { email: "hi@wzy.one", password: "test-prefix1103" }, { email: "someone@wzy.one", password: "test-prefix1104" }]) {
    const response = await handleRequest(login(data), env, {}, options);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.deepEqual(await response.json(), { error: "邮箱或密码不正确。" });
  }
});

test("rejects cross-origin login/logout and enforces attempt limits before password verification", async () => {
  assert.equal((await handleRequest(login(undefined, { Origin: "https://other.example" }), env, {}, options)).status, 403);
  assert.equal((await handleRequest(login(undefined, { "Sec-Fetch-Site": "cross-site" }), env, {}, options)).status, 403);
  assert.equal((await handleRequest(new Request(origin + "/api/logout", { method: "POST", headers: { Origin: "https://other.example" } }), env)).status, 403);
  let key;
  const response = await handleRequest(login(), { ...env, LOGIN_RATE_LIMITER: { limit: async (input) => { key = input.key; return { success: false }; } } }, {}, options);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(key, "password:192.0.2.1");
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal((await handleRequest(login(), { ...env, LOGIN_RATE_LIMITER: undefined }, {}, options)).status, 503);
});

test("limits login request bodies and requires POST for password login and logout", async () => {
  assert.equal((await handleRequest(login({ email: "hi@wzy.one", password: "a".repeat(5000) }), env, {}, options)).status, 413);
  for (const path of ["/api/login", "/api/logout"]) assert.equal((await handleRequest(new Request(origin + path), env, {}, options)).status, 405);
});

test("logout clears the cookie and selects the correct logout destination for each login method", async () => {
  for (const method of ["password", "access"]) {
    const cookie = (await issueSession("admin@wzy.one", method, origin, env)).split(";")[0];
    const response = await handleRequest(new Request(origin + "/api/logout", { method: "POST", headers: { Origin: origin, Cookie: cookie } }), env);
    assert.match(response.headers.get("Set-Cookie"), /Max-Age=0/);
    assert.deepEqual(await response.json(), { redirect: method === "password" ? "/login" : "/cdn-cgi/access/logout" });
  }
});
