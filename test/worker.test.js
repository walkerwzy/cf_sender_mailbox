import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, validateMail } from "../src/worker.js";
import devWorker from "../src/dev-worker.js";

const origin = "https://mail.wzy.one";
const key = "f12e0ef2-c8b3-4ba5-9cd7-13e096efa42f";
const message = { to: "friend@example.com", subject: "Hello", body: "你好，朋友。", format: "text" };
const authenticate = async () => ({ email: "hi@wzy.one" });
const env = { MAIL_FROM_NAME: "walker", RESEND_API_KEY: "test-secret-never-expose", SEND_RATE_LIMITER: { limit: async () => ({ success: true }) }, ASSETS: { fetch: async () => new Response("<html>private</html>") } };
function post(data = message, headers = {}, url = `${origin}/api/send`) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "Idempotency-Key": key, ...headers }, body: JSON.stringify(data) });
}

test("page and API deny anonymous requests and ignore preview flags in production", async () => {
  for (const path of ["/", "/styles.css", "/app.js", "/api/session", "/api/send"]) {
    const response = await handleRequest(new Request(`${origin}${path}`), { ...env, ACCESS_TEAM_DOMAIN: "walker.cloudflareaccess.com", ACCESS_AUD: "app", ALLOWED_EMAILS: "hi@wzy.one", LOCAL_DEV_MODE: "true" });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal((await handleRequest(new Request(origin), env)).status, 503);
});

test("session displays walker and the authenticated email", async () => {
  const response = await handleRequest(new Request(`${origin}/api/session`), env, {}, { authenticate });
  assert.deepEqual(await response.json(), { email: "hi@wzy.one", from: "walker <hi@wzy.one>", preview: false, ready: true, loginMethod: "access" });
});

test("protects authenticated static responses with security headers", async () => {
  const response = await handleRequest(new Request(origin), env, {}, { authenticate });
  assert.equal(await response.text(), "<html>private</html>");
  assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("uses the signed-in email as sender and forwards retries with a stable idempotency key", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { requests.push({ url, init }); return Response.json({ id: "resend-message-id" }); });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await handleRequest(post({ ...message, from: "attacker@other-domain.com" }), env, {}, { authenticate });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: "resend-message-id", preview: false });
  }
  assert.equal(requests[0].url, "https://api.resend.com/emails");
  assert.equal(JSON.parse(requests[0].init.body).from, "walker <hi@wzy.one>");
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${env.RESEND_API_KEY}`);
  assert.equal(requests[0].init.headers["Idempotency-Key"], requests[1].init.headers["Idempotency-Key"]);
});

test("scopes the idempotency key to the authenticated user", async () => {
  const keys = [];
  for (const email of ["admin@wzy.one", "hi@wzy.one"]) await handleRequest(post(), env, {}, { authenticate: async () => ({ email }), sendMail: async (mail, id) => { keys.push(id); return { id: "ok" }; } });
  assert.notEqual(keys[0], keys[1]);
});

test("rejects cross-origin requests, missing idempotency keys, and wrong methods", async () => {
  assert.equal((await handleRequest(post(message, { Origin: "https://attacker.example" }), env, {}, { authenticate })).status, 403);
  assert.equal((await handleRequest(post(message, { "Idempotency-Key": "" }), env, {}, { authenticate })).status, 400);
  const response = await handleRequest(new Request(`${origin}/api/send`), env, {}, { authenticate });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "POST");
});

test("rejects oversized JSON bodies without trusting Content-Length", async () => {
  const response = await handleRequest(post({ ...message, body: "中".repeat(60000) }), env, {}, { authenticate });
  assert.equal(response.status, 413);
});

test("rate-limited requests never reach Resend", async () => {
  let called = false;
  const response = await handleRequest(post(), { ...env, SEND_RATE_LIMITER: { limit: async () => ({ success: false }) } }, {}, { authenticate, sendMail: async () => { called = true; } });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(called, false);
});

test("does not expose upstream error details or API secrets", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: env.RESEND_API_KEY }, { status: 403 }));
  const response = await handleRequest(post(), env, {}, { authenticate });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(env.RESEND_API_KEY));
});

test("reports uncertain delivery after a network timeout", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new DOMException("Timed out", "TimeoutError"); });
  const response = await handleRequest(post(), env, {}, { authenticate });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /保持内容不变/);
});

test("supports HTML, cc, bcc, and a single reply address", () => {
  const mail = validateMail({ ...message, format: "html", body: "<p>Hello</p>", to: "a@example.com，b@example.com", cc: ["c@example.com"], bcc: "d@example.com", replyTo: "reply@example.com" }, "walker <hi@wzy.one>");
  assert.equal(mail.html, "<p>Hello</p>");
  assert.equal(mail.text, undefined);
  assert.equal(mail.reply_to, "reply@example.com");
  assert.equal(mail.to.length, 2);
  assert.deepEqual(mail.cc, ["c@example.com"]);
  assert.deepEqual(mail.bcc, ["d@example.com"]);
});

test("rejects invalid addresses, header injection, too many recipients, and empty content", () => {
  for (const change of [{ to: "not-an-email" }, { subject: "Hello\r\nBcc: other@example.com" }, { to: Array.from({ length: 21 }, (_, index) => `user${index}@example.com`) }, { body: " " }, { subject: " " }, { format: "markdown" }, { replyTo: "a@example.com,b@example.com" }]) {
    assert.throws(() => validateMail({ ...message, ...change }, "walker <hi@wzy.one>"), { status: 400 });
  }
});

test("local preview simulates sending and refuses public hosts", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Preview must never call external APIs"); });
  const url = "http://127.0.0.1:8787/api/send";
  const response = await devWorker.fetch(post(message, { Origin: "http://127.0.0.1:8787" }, url), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.preview, true);
  assert.match(data.id, /^preview-/);
  assert.equal((await devWorker.fetch(new Request(origin), env)).status, 403);
});
