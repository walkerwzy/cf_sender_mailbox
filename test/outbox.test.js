import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/worker.js";
import { ownsMail } from "../src/outbox.js";
import devWorker from "../src/dev-worker.js";

const origin = "https://mail.wzy.one";
const id = "f12e0ef2-c8b3-4ba5-9cd7-13e096efa42f";
const otherId = "bcd23456-c8b3-4ba5-9cd7-13e096efa42f";
const env = { MAIL_FROM_NAME: "walker", RESEND_API_KEY: "sending-secret", RESEND_READ_API_KEY: "reading-secret", OUTBOX_RATE_LIMITER: { limit: async () => ({ success: true }) } };
const options = { authenticate: async () => ({ email: "hi@wzy.one" }), now: 1800000000 };
const mail = { id, from: "walker <hi@wzy.one>", to: ["friend@example.com"], subject: "Hello", created_at: "2026-11-04T10:00:00.000Z", last_event: "delivered", text: "Hello", html: "<p>Hello</p>", cc: ["copy@example.com"], bcc: ["private@example.com"], reply_to: ["hi@wzy.one"] };
const call = (path = "/api/outbox", config = env, auth = options) => handleRequest(new Request(`${origin}${path}`), config, {}, auth);

test("both outbox endpoints reject anonymous requests before contacting Resend", async (t) => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("Anonymous requests must not contact Resend"); });
  const configured = { ...env, ACCESS_TEAM_DOMAIN: "walker.cloudflareaccess.com", ACCESS_AUD: "app", ALLOWED_EMAILS: "hi@wzy.one" };
  for (const path of ["/api/outbox", `/api/outbox/${id}`]) {
    const response = await call(path, configured, {});
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
});

test("list uses a read key, excludes other senders and never returns mail bodies or BCC", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    requests++;
    assert.equal(input, "https://api.resend.com/emails?limit=100");
    assert.equal(init.headers.Authorization, `Bearer ${env.RESEND_READ_API_KEY}`);
    assert.equal(init.redirect, "manual");
    return Response.json({ data: [mail, { ...mail, id: otherId, from: "walker <admin@wzy.one>", subject: "private" }], has_more: false });
  });
  const response = await call();
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.deepEqual(page.data, [{ id, from: mail.from, to: mail.to, subject: mail.subject, created_at: mail.created_at, last_event: mail.last_event }]);
  assert.equal(page.has_more, false);
  assert.equal(page.next_cursor, null);
  assert.equal(requests, 1);
});

test("mailbox ownership accepts bare or named senders and rejects misleading display names", () => {
  for (const from of ["HI@WZY.ONE", "Different Name <hi@wzy.one>"]) assert.equal(ownsMail({ from }, "hi@wzy.one"), true);
  for (const from of ["hi@wzy.one <other@example.com>", "walker <hi@wzy.one> <other@example.com>", "walker <hi@wzy.one>\nBcc:other@example.com", null]) assert.equal(ownsMail({ from }, "hi@wzy.one"), false);
});

test("pagination advances past a page belonging entirely to another sender using a hidden cursor", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    requests.push(input);
    return Response.json(requests.length === 1 ? { data: [{ ...mail, id: otherId, from: "admin@wzy.one" }], has_more: true } : { data: [mail], has_more: false });
  });
  const first = await (await call()).json();
  assert.deepEqual(first.data, []);
  assert.equal(first.has_more, true);
  assert.ok(first.next_cursor && !first.next_cursor.includes(otherId));
  const second = await (await call(`/api/outbox?cursor=${first.next_cursor}`)).json();
  assert.equal(second.data[0].id, id);
  assert.equal(requests[1], `https://api.resend.com/emails?limit=100&after=${otherId}`);
});

test("cursor tampering, cross-user reuse, host changes, key rotation and expiry fail before provider fetch", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ data: [mail], has_more: true }); });
  const { next_cursor: cursor } = await (await call()).json();
  const path = `/api/outbox?cursor=${cursor}`;
  const changed = (cursor[0] === "A" ? "B" : "A") + cursor.slice(1);
  const responses = [
    await call(`/api/outbox?cursor=${changed}`),
    await call(path, env, { ...options, authenticate: async () => ({ email: "admin@wzy.one" }) }),
    await handleRequest(new Request(`https://other.example${path}`), env, {}, options),
    await call(path, { ...env, RESEND_READ_API_KEY: "rotated-secret" }),
    await call(path, env, { ...options, now: options.now + 3600 }),
  ];
  assert.ok(responses.every((response) => response.status === 400));
  assert.equal(requests, 1);
});

test("detail checks ownership and returns only the current sender's content", async (t) => {
  t.mock.method(globalThis, "fetch", async (input) => {
    assert.equal(input, `https://api.resend.com/emails/${id}`);
    return Response.json({ ...mail, internal_secret: "must-not-return" });
  });
  const response = await call(`/api/outbox/${id}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), mail);
  const denied = await call(`/api/outbox/${id}`, env, { ...options, authenticate: async () => ({ email: "admin@wzy.one" }) });
  assert.equal(denied.status, 404);
  assert.ok(!(await denied.text()).includes(mail.subject));
});

test("invalid mail IDs, queries, methods and rate limits cannot reach Resend", async (t) => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("Invalid requests must not contact Resend"); });
  for (const path of ["/api/outbox?after=" + id, "/api/outbox?cursor=bad", "/api/outbox?cursor=x&cursor=y", "/api/outbox/%2e%2e%2fx", "/api/outbox/not-a-uuid", "/api/outbox/" + id + "/extra"]) {
    assert.ok([400, 404].includes((await call(path)).status), path);
  }
  const wrongMethod = await handleRequest(new Request(`${origin}/api/outbox`, { method: "POST" }), env, {}, options);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("Allow"), "GET");
  const limited = await call("/api/outbox", { ...env, OUTBOX_RATE_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  assert.equal((await call("/api/outbox", { ...env, OUTBOX_RATE_LIMITER: undefined })).status, 503);
});

test("reading falls back to the existing API key when no read secret was supplied", async (t) => {
  t.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${env.RESEND_API_KEY}`);
    return Response.json({ data: [], has_more: false });
  });
  assert.equal((await call("/api/outbox", { ...env, RESEND_READ_API_KEY: undefined })).status, 200);
});

test("upstream errors and redirects never leak secrets or follow another origin", async (t) => {
  for (const [upstreamStatus, expected] of [[401, 502], [403, 502], [429, 429], [500, 502], [307, 502], [404, 404]]) {
    t.mock.method(globalThis, "fetch", async (input, init) => {
      assert.equal(new URL(input).hostname, "api.resend.com");
      assert.equal(init.redirect, "manual");
      return Response.json({ message: env.RESEND_READ_API_KEY }, { status: upstreamStatus, headers: { Location: "https://attacker.example/" } });
    });
    const response = await call();
    assert.equal(response.status, expected);
    assert.ok(!(await response.text()).includes(env.RESEND_READ_API_KEY));
  }
});

test("network failures and malformed upstream pages return safe errors", async (t) => {
  for (const payload of [null, { data: [], has_more: true }, { data: [mail], has_more: "yes" }, { data: [{ ...mail, id: "invalid" }], has_more: false }]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(payload));
    assert.equal((await call()).status, 502);
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error(env.RESEND_READ_API_KEY); });
  const response = await call();
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(env.RESEND_READ_API_KEY));
});

test("local preview shows sample messages and simulated sends without external requests", async (t) => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("Preview must not contact Resend"); });
  const local = "http://127.0.0.1:8787";
  const before = await (await devWorker.fetch(new Request(`${local}/api/outbox`), env)).json();
  assert.ok(before.data.length >= 2);
  const response = await devWorker.fetch(new Request(`${local}/api/send`, { method: "POST", headers: { Origin: local, "Content-Type": "application/json", "Idempotency-Key": id }, body: JSON.stringify({ to: "preview@example.com", subject: "Preview outbox", body: "Local content only", format: "text" }) }), { ...env, SEND_RATE_LIMITER: { limit: async () => ({ success: true }) } });
  assert.equal(response.status, 200);
  const page = await (await devWorker.fetch(new Request(`${local}/api/outbox`), env)).json();
  const detail = await (await devWorker.fetch(new Request(`${local}/api/outbox/${page.data[0].id}`), env)).json();
  assert.equal(detail.subject, "Preview outbox");
  assert.equal(detail.text, "Local content only");
});
