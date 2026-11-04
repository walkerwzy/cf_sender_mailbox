import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("the CLI checks without mutations, then publishes dual-login code before narrowing Access", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mailroom-deploy-mode-"));
  try {
    await cp(new URL("../scripts", import.meta.url), join(root, "scripts"), { recursive: true });
    await cp(new URL("../wrangler.jsonc", import.meta.url), join(root, "wrangler.jsonc"));
    const tracePath = join(root, "trace.jsonl");
    await writeFile(tracePath, "");
    const mockPath = join(root, "mock-api.mjs");
    await writeFile(mockPath, `
import { appendFileSync, readFileSync } from "node:fs";
const root = process.cwd();
const record = (event) => appendFileSync(root + "/trace.jsonl", JSON.stringify(event) + "\\n");
let app = { id: "app-id", aud: "stable-audience", name: "Walker Mailroom · sendmail-cf", domain: "mail.wzy.one", type: "self_hosted", allowed_idps: ["otp-id"] };
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  const path = url.pathname.replace("/client/v4", "");
  const method = init.method || "GET";
  record({ event: "api", host: url.hostname, path, method });
  if (url.hostname === "api.resend.com") return Response.json(path === "/domains" ? { data: [{ id: "domain-id", name: "wzy.one" }] } : { status: "verified" });
  if (url.hostname === "mail.wzy.one") {
    if (path === "/") return new Response(null, { status: 303, headers: { Location: "/login" } });
    if (path === "/login") return new Response("login", { headers: { "Content-Type": "text/html" } });
    if (path === "/api/session") return Response.json({ error: "Please log in" }, { status: 401 });
    if (path === "/auth/access") return new Response(null, { status: 302, headers: { Location: "https://walker.cloudflareaccess.com/cdn-cgi/access/login/mail.wzy.one" } });
    throw new Error("Unexpected page request");
  }
  if (url.hostname !== "api.cloudflare.com") throw new Error("Tests must not use real APIs");
  let result;
  if (path.endsWith("/access/organizations")) result = { auth_domain: "walker.cloudflareaccess.com" };
  else if (path.endsWith("/access/identity_providers")) result = [{ id: "otp-id", type: "onetimepin" }];
  else if (path.endsWith("/access/apps")) result = [app];
  else if (path.endsWith("/access/apps/app-id") && method === "PUT") {
    const events = readFileSync(root + "/trace.jsonl", "utf8").trim().split("\\n").map(JSON.parse);
    if (!events.some((event) => event.event === "worker-live")) throw new Error("Access must not change before the Worker is live");
    app = { ...app, ...JSON.parse(init.body) }; result = app;
  }
  else if (path.endsWith("/policies")) result = [{ name: "Mailroom members", decision: "allow", include: ["admin@wzy.one", "hi@wzy.one"].map((email) => ({ email: { email } })), exclude: [], require: [] }];
  else if (path.endsWith("/settings")) {
    const config = JSON.parse(readFileSync(root + "/.deploy/wrangler-worker.json", "utf8"));
    result = { bindings: [...Object.entries(config.vars).map(([name, text]) => ({ name, text, type: "plain_text" })), { name: "ASSETS", type: "assets" }, ...config.ratelimits.map((binding) => ({ ...binding, type: "ratelimit" }))] };
  }
  else if (path.endsWith("/secrets")) result = ["RESEND_API_KEY", "RESEND_READ_API_KEY", "LOGIN_PASSWORD", "SESSION_SECRET"].map((name) => ({ name, type: "secret_text" }));
  else if (path.endsWith("/subdomain")) result = { enabled: false, previews_enabled: false };
  else if (path.endsWith("/workers/domains")) result = [{ hostname: "mail.wzy.one", service: "sendmail-cf", environment: "production" }];
  else throw new Error("Unexpected Cloudflare API request: " + path);
  return Response.json({ success: true, result });
};
`);
    await writeFile(join(root, "wrangler"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const record = (event) => fs.appendFileSync(process.cwd() + "/trace.jsonl", JSON.stringify(event) + "\\n");
if (args[0] !== "versions") throw new Error("Domain deployment is forbidden in this test");
if (args[1] === "upload") {
  const config = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"));
  const secrets = JSON.parse(fs.readFileSync(args[args.indexOf("--secrets-file") + 1], "utf8"));
  if (config.routes || config.workers_dev !== undefined || config.vars.LOGIN_PASSWORD || config.vars.SESSION_SECRET) throw new Error("Unsafe Worker configuration");
  if (!secrets.LOGIN_PASSWORD || !secrets.SESSION_SECRET || config.vars.LOGIN_MODE !== "dual") throw new Error("Dual-login secrets missing");
  const expectedReadKey = process.env.RESEND_READ_API_KEY || process.env.RESEND_ADMIN_API_KEY || undefined;
  if (secrets.RESEND_READ_API_KEY !== expectedReadKey || secrets.RESEND_ADMIN_API_KEY || config.vars.RESEND_READ_API_KEY) throw new Error("Outbox key priority or secret storage is incorrect");
  record({ event: "worker-upload" });
  console.log("Worker Version ID: f12e0ef2-c8b3-4ba5-9cd7-13e096efa42f");
} else if (args[1] === "deploy") record({ event: "worker-live" });
else throw new Error("Unexpected command");
`, { mode: 0o700 });
    const env = { ...process.env, NODE_OPTIONS: "", PATH: root + delimiter + process.env.PATH, CLOUDFLARE_API_TOKEN: "test-cf-token", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), RESEND_API_KEY: "test-resend-key", RESEND_ADMIN_API_KEY: "test-admin-key", RESEND_READ_API_KEY: "test-read-key", ACCESS_TEAM_DOMAIN: "", APP_DOMAIN: "mail.wzy.one", ALLOWED_EMAILS: "admin@wzy.one,hi@wzy.one", LOGIN_PASSWORD: "test-password-prefix", SESSION_SECRET: "test-session-signing-secret-more-than-32", MAIL_FROM_NAME: "walker" };
    const run = (flag, overrides = {}) => promisify(execFile)(process.execPath, ["--import", mockPath, join(root, "scripts/deploy.mjs"), flag], { cwd: root, env: { ...env, ...overrides } });
    await assert.rejects(run("--check"), (error) => { assert.match(error.stderr, /Access 登录范围需要更新/); return true; });
    const initial = (await readFile(tracePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(initial.every((event) => event.event === "api" && event.method === "GET"));
    await writeFile(tracePath, "");
    const result = await run("--worker-only");
    assert.match(result.stdout, /部署完成/);
    assert.ok(!result.stdout.includes(env.LOGIN_PASSWORD) && !result.stdout.includes(env.SESSION_SECRET));
    const events = (await readFile(tracePath, "utf8")).trim().split("\n").map(JSON.parse);
    const live = events.findIndex((event) => event.event === "worker-live");
    const gate = events.findIndex((event) => event.event === "api" && event.method === "PUT");
    assert.ok(live >= 0 && gate > live);
    assert.ok(events.filter((event) => event.event === "api" && event.method !== "GET").every((event) => event.path.endsWith("/access/apps/app-id") && event.method === "PUT"));
    assert.ok(events.every((event) => !event.path?.startsWith("/zones")));
    await assert.rejects(access(join(root, ".deploy/secrets.json")), { code: "ENOENT" });
    const adminFallback = await run("--worker-only", { RESEND_READ_API_KEY: "" });
    assert.match(adminFallback.stdout, /复用 RESEND_ADMIN_API_KEY/);
    assert.ok(!adminFallback.stdout.includes(env.RESEND_ADMIN_API_KEY));
    await assert.rejects(access(join(root, ".deploy/secrets.json")), { code: "ENOENT" });
    const sendingFallback = await run("--worker-only", { RESEND_READ_API_KEY: "", RESEND_ADMIN_API_KEY: "" });
    assert.match(sendingFallback.stdout, /复用 RESEND_API_KEY/);
    assert.ok(!sendingFallback.stdout.includes(env.RESEND_API_KEY));
  } finally { await rm(root, { recursive: true, force: true }); }
});
