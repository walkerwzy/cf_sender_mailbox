import test from "node:test";
import assert from "node:assert/strict";
import { beijingDay, issueSession, passwordMatches, SESSION_COOKIE, verifySession } from "../src/session.js";

const origin = "https://mail.wzy.one";
const now = Date.parse("2026-11-04T10:00:00Z") / 1000;
const env = { LOGIN_MODE: "dual", LOGIN_PASSWORD: "test-password-prefix", SESSION_SECRET: "test-session-secret-at-least-32-characters", ALLOWED_EMAILS: "admin@wzy.one,hi@wzy.one" };
const request = (cookie, url = origin) => new Request(url, { headers: { Cookie: cookie.split(";")[0] } });

test("uses zero-padded Beijing MMDD at UTC date boundaries and year rollover", () => {
  assert.equal(beijingDay(Date.parse("2026-01-01T15:59:59Z") / 1000).suffix, "0101");
  assert.equal(beijingDay(Date.parse("2026-01-01T16:00:00Z") / 1000).suffix, "0102");
  assert.equal(beijingDay(Date.parse("2026-12-31T16:00:00Z") / 1000).date, "2027-01-01");
});

test("matches the exact prefix plus today's date and refuses adjacent days or prefix changes", async () => {
  assert.equal(await passwordMatches(env.LOGIN_PASSWORD + "1104", env, now), true);
  for (const value of [env.LOGIN_PASSWORD, env.LOGIN_PASSWORD + "1103", env.LOGIN_PASSWORD + "1105", " " + env.LOGIN_PASSWORD + "1104", null, "a".repeat(513)]) {
    assert.equal(await passwordMatches(value, env, now), false);
  }
});

test("issues host-only HttpOnly cookies for both identities and verifies their signatures", async () => {
  for (const email of ["admin@wzy.one", "hi@wzy.one"]) {
    const cookie = await issueSession(email, "password", origin, env, now);
    assert.match(cookie, /Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=/);
    assert.ok(!cookie.includes("Domain="));
    assert.deepEqual(await verifySession(request(cookie), env, { now }), { email, method: "password" });
  }
});

test("password sessions expire at Beijing midnight while Access sessions last 24 hours", async () => {
  const beforeMidnight = Date.parse("2026-11-04T15:59:58Z") / 1000;
  const password = await issueSession("admin@wzy.one", "password", origin, env, beforeMidnight);
  const access = await issueSession("admin@wzy.one", "access", origin, env, beforeMidnight);
  assert.match(password, /Max-Age=2$/);
  await assert.rejects(verifySession(request(password), env, { now: beforeMidnight + 2 }), { status: 401 });
  assert.deepEqual(await verifySession(request(access), env, { now: beforeMidnight + 2 }), { email: "admin@wzy.one", method: "access" });
  await assert.rejects(verifySession(request(access), env, { now: beforeMidnight + 86400 }), { status: 401 });
});

test("Access sessions never outlive the JWT used to log in", async () => {
  const cookie = await issueSession("admin@wzy.one", "access", origin, env, now, now + 60);
  assert.match(cookie, /Max-Age=60$/);
  await assert.rejects(verifySession(request(cookie), env, { now: now + 60 }), { status: 401 });
});

test("rejects modified email or login method, duplicate cookies, removed users, and cross-host reuse", async () => {
  const cookie = await issueSession("admin@wzy.one", "password", origin, env, now);
  const token = cookie.split(";")[0].slice(SESSION_COOKIE.length + 1);
  const [encoded, signature] = token.split(".");
  const payload = JSON.parse(Buffer.from(encoded, "base64url"));
  for (const changed of [{ ...payload, email: "hi@wzy.one" }, { ...payload, method: "access", exp: now + 86400 }]) {
    const forged = `${SESSION_COOKIE}=${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`;
    await assert.rejects(verifySession(request(forged), env, { now }), { status: 401 });
  }
  await assert.rejects(verifySession(new Request(origin, { headers: { Cookie: `${cookie.split(";")[0]}; ${cookie.split(";")[0]}` } }), env, { now }), { status: 401 });
  await assert.rejects(verifySession(request(cookie), { ...env, ALLOWED_EMAILS: "hi@wzy.one" }, { now }), { status: 401 });
  await assert.rejects(verifySession(request(cookie, "https://other.example"), env, { now }), { status: 401 });
  await assert.rejects(issueSession("other@wzy.one", "password", origin, env, now), { status: 403 });
});

test("rotating the password invalidates password sessions and keeps existing Access sessions", async () => {
  const password = await issueSession("admin@wzy.one", "password", origin, env, now);
  const access = await issueSession("admin@wzy.one", "access", origin, env, now);
  const rotated = { ...env, LOGIN_PASSWORD: "changed-password" };
  await assert.rejects(verifySession(request(password), rotated, { now }), { status: 401 });
  assert.equal((await verifySession(request(access), rotated, { now })).method, "access");
  await assert.rejects(verifySession(request(access), { ...env, SESSION_SECRET: "different-session-secret-at-least-32" }, { now }), { status: 401 });
});

test("requires complete server configuration and rejects missing, malformed, or future sessions", async () => {
  await assert.rejects(passwordMatches("anything", { ...env, SESSION_SECRET: "" }, now), { status: 503 });
  for (const value of ["", `${SESSION_COOKIE}=garbage`, `${SESSION_COOKIE}=a.b.c`]) {
    await assert.rejects(verifySession(new Request(origin, { headers: { Cookie: value } }), env, { now }), { status: 401 });
  }
  const future = await issueSession("admin@wzy.one", "access", origin, env, now + 120);
  await assert.rejects(verifySession(request(future), env, { now }), { status: 401 });
});
