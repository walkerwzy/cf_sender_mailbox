import test from "node:test";
import assert from "node:assert/strict";
import { makeApi } from "../scripts/api.mjs";
import { networkCode } from "../scripts/network.mjs";

const reset = () => Object.assign(new TypeError("private upstream details"), { cause: { code: "ECONNRESET" } });
const base = "https://api.resend.com";
function options(fetcher, delays = [], warnings = []) {
  return { fetcher, sandboxDisabled: false, pause: async (ms) => { delays.push(ms); }, warn: (message) => { warnings.push(message); } };
}

test("retries interrupted read-only requests and succeeds with bounded backoff", async () => {
  let calls = 0;
  const delays = [];
  const warnings = [];
  const api = makeApi(base, { Authorization: "Bearer test-secret" }, "Resend", options(async (url, init) => {
    assert.equal(url, base + "/domains");
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    if (++calls < 3) throw reset();
    return Response.json({ data: [] });
  }, delays, warnings));
  assert.deepEqual(await api("/domains"), { data: [] });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(warnings.length, 2);
});

test("exhausted reads identify connection resets without claiming network permission failures", async () => {
  let calls = 0;
  const api = makeApi(base, { Authorization: "Bearer test-secret" }, "Resend", options(async () => { calls++; throw reset(); }));
  await assert.rejects(api("/domains?private=query"), (error) => {
    assert.equal(error.code, "ECONNRESET");
    assert.equal(error.attempts, 3);
    assert.match(error.message, /连接被中途断开/);
    for (const value of ["private=query", "test-secret", "private upstream details", "检查当前命令行的网络权限"]) assert.ok(!error.message.includes(value));
    return true;
  });
  assert.equal(calls, 3);
});

test("never automatically repeats creation, update, or deletion after a lost response", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    let calls = 0;
    const api = makeApi(base, {}, "Resend", options(async () => { calls++; throw reset(); }));
    await assert.rejects(api("/domains", method, { name: "example.com" }), (error) => {
      assert.equal(error.attempts, 1);
      assert.match(error.message, /写入未自动重试/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("retries throttled or unavailable reads, caps Retry-After, and retains final HTTP status", async () => {
  let calls = 0;
  const delays = [];
  const api = makeApi(base, {}, "Resend", options(async () => ++calls === 1 ? Response.json({}, { status: 429, headers: { "Retry-After": "600" } }) : Response.json({ data: [] }), delays));
  assert.deepEqual(await api("/domains"), { data: [] });
  assert.deepEqual(delays, [5000]);
  for (const method of ["GET", "POST"]) {
    let attempts = 0;
    const unavailable = makeApi(base, {}, "Resend", options(async () => { attempts++; return new Response("Unavailable", { status: 503 }); }));
    await assert.rejects(unavailable("/domains", method), { status: 503 });
    assert.equal(attempts, method === "GET" ? 3 : 1);
  }
});

test("does not retry authorization errors or permanent DNS and certificate failures", async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    const api = makeApi(base, {}, "Resend", options(async () => { calls++; return Response.json({ message: "Unauthorized" }, { status }); }));
    await assert.rejects(api("/domains"), { status });
    assert.equal(calls, 1);
  }
  for (const code of ["ENOTFOUND", "CERT_HAS_EXPIRED"]) {
    let calls = 0;
    const api = makeApi(base, {}, "Resend", options(async () => { calls++; throw Object.assign(new Error("request failed"), { cause: { code } }); }));
    await assert.rejects(api("/domains"), { code, attempts: 1 });
    assert.equal(calls, 1);
  }
});

test("retries resets during JSON body transfer while malformed successful JSON is not replayed", async () => {
  let calls = 0;
  const api = makeApi(base, {}, "Resend", options(async () => ++calls === 1 ? { status: 200, ok: true, json: async () => { throw reset(); } } : Response.json({ data: [] })));
  assert.deepEqual(await api("/domains"), { data: [] });
  assert.equal(calls, 2);
  calls = 0;
  const invalid = makeApi(base, {}, "Resend", options(async () => { calls++; return new Response("not json"); }));
  await assert.rejects(invalid("/domains"), /无效的响应/);
  assert.equal(calls, 1);
});

test("extracts nested Node transport errors and DOM timeout names", () => {
  assert.equal(networkCode(new TypeError("fetch failed", { cause: new AggregateError([{ code: "ECONNRESET" }]) })), "ECONNRESET");
  assert.equal(networkCode(new DOMException("Timed out", "TimeoutError")), "TimeoutError");
});
