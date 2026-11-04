import test from "node:test";
import assert from "node:assert/strict";
import { checkWorkerDeployment, checkAnonymousAccess } from "../scripts/deployment-check.mjs";

const domain = "mail.wzy.one";
const teamDomain = "walker.cloudflareaccess.com";
const emails = ["admin@wzy.one", "hi@wzy.one"];
const options = { accountId: "account", domain, customDomain: true, teamDomain, audience: "audience", emails, log: () => {} };

function deployedWorker() {
  return {
    settings: { bindings: [
      { name: "MAIL_FROM_NAME", type: "plain_text", text: "walker" },
      { name: "ACCESS_TEAM_DOMAIN", type: "plain_text", text: teamDomain },
      { name: "ACCESS_AUD", type: "plain_text", text: "audience" },
      { name: "ALLOWED_EMAILS", type: "plain_text", text: "hi@wzy.one,admin@wzy.one" },
      { name: "ASSETS", type: "assets" },
      { name: "SEND_RATE_LIMITER", type: "ratelimit", simple: { limit: 5, period: 60 } },
      { name: "OUTBOX_RATE_LIMITER", type: "ratelimit", simple: { limit: 30, period: 60 } },
    ] },
    secrets: [{ name: "RESEND_API_KEY", type: "secret_text" }],
    subdomain: { enabled: false, previews_enabled: false },
    domains: [{ hostname: domain, service: "sendmail-cf", environment: "production" }],
  };
}

function api(worker, calls = []) {
  return async (path, method) => {
    assert.equal(method, undefined, "Deployment checking must never write to Cloudflare");
    assert.ok(path.startsWith("/accounts/account/workers/"), "Manual bindings need no zone-route API calls");
    calls.push(path);
    if (path.endsWith("/settings")) return worker.settings;
    if (path.endsWith("/secrets")) return worker.secrets;
    if (path.endsWith("/subdomain")) return worker.subdomain;
    if (path.endsWith("/domains")) return worker.domains;
    assert.fail(`Unexpected API: ${path}`);
  };
}

test("checks a partially uploaded Worker after manual domain binding using read-only account APIs", async () => {
  const calls = [];
  await checkWorkerDeployment({ ...options, cloudflare: api(deployedWorker(), calls) });
  assert.equal(calls.length, 4);
});

test("checks an explicitly configured outbox key and read rate limiter", async () => {
  const worker = deployedWorker();
  await assert.rejects(checkWorkerDeployment({ ...options, readApiKeyConfigured: true, cloudflare: api(worker) }), /RESEND_READ_API_KEY/);
  worker.secrets.push({ name: "RESEND_READ_API_KEY", type: "secret_text" });
  await checkWorkerDeployment({ ...options, readApiKeyConfigured: true, cloudflare: api(worker) });
  worker.settings.bindings.find((binding) => binding.name === "OUTBOX_RATE_LIMITER").simple.limit = 100;
  await assert.rejects(checkWorkerDeployment({ ...options, readApiKeyConfigured: true, cloudflare: api(worker) }), /OUTBOX_RATE_LIMITER/);
});

test("reports every incomplete upload item without treating an uploaded script as a successful deployment", async () => {
  const worker = deployedWorker();
  worker.settings.bindings = [];
  worker.secrets = [];
  worker.subdomain = { enabled: true, previews_enabled: true };
  worker.domains = [];
  await assert.rejects(checkWorkerDeployment({ ...options, cloudflare: api(worker) }), (error) => {
    for (const name of ["ACCESS_AUD", "RESEND_API_KEY", "ASSETS", "SEND_RATE_LIMITER", "workers.dev", "Preview URLs", domain]) assert.ok(error.message.includes(name));
    return true;
  });
});

test("rejects a stale Access audience and a domain bound to the wrong Worker or environment", async () => {
  for (const change of [
    (worker) => { worker.settings.bindings.find((binding) => binding.name === "ACCESS_AUD").text = "old-audience"; },
    (worker) => { worker.domains[0].service = "other-worker"; },
    (worker) => { worker.domains[0].environment = "staging"; },
  ]) {
    const worker = deployedWorker();
    change(worker);
    await assert.rejects(checkWorkerDeployment({ ...options, cloudflare: api(worker) }), /ACCESS_AUD|其他 Worker 或环境/);
  }
});

test("requires the enabled workers.dev address when no custom domain is configured", async () => {
  const worker = deployedWorker();
  const calls = [];
  await assert.rejects(checkWorkerDeployment({ ...options, customDomain: false, cloudflare: api(worker) }), /启用.*workers.dev/);
  worker.subdomain.enabled = true;
  await checkWorkerDeployment({ ...options, customDomain: false, cloudflare: api(worker, calls) });
  assert.ok(!calls.some((path) => path.endsWith("/domains")));
});

test("checks both the page and API redirect to this team's HTTPS Access login", async () => {
  const requests = [];
  await checkAnonymousAccess({ domain, teamDomain, log: () => {}, fetcher: async (url, init) => {
    requests.push(url);
    assert.equal(init.redirect, "manual");
    assert.equal(init.method, undefined);
    return new Response(null, { status: 302, headers: { Location: `https://${teamDomain}/cdn-cgi/access/login/${domain}` } });
  } });
  assert.deepEqual(requests.sort(), [`https://${domain}/`, `https://${domain}/api/session`].sort());
});

test("does not pass an exposed page, a bare JWT denial, or an unrelated redirect as working Access login", async () => {
  for (const [status, location] of [
    [200, undefined],
    [401, undefined],
    [302, "https://other.cloudflareaccess.com/cdn-cgi/access/login/mail.wzy.one"],
    [302, `http://${teamDomain}/cdn-cgi/access/login/mail.wzy.one`],
    [302, `https://${teamDomain}/unrelated`],
  ]) {
    await assert.rejects(checkAnonymousAccess({ domain, teamDomain, log: () => {}, fetcher: async (url) => {
      const isPage = new URL(url).pathname === "/";
      return new Response(null, { status: isPage ? status : 302, headers: { ...(isPage ? location ? { Location: location } : {} : { Location: `https://${teamDomain}/cdn-cgi/access/login/mail.wzy.one` }) } });
    } }), /匿名登录检查失败|没有跳转到 Access 登录/);
  }
});

test("dual login checking requires both private secrets and a separate login rate limiter", async () => {
  const worker = deployedWorker();
  await assert.rejects(checkWorkerDeployment({ ...options, loginMode: "dual", cloudflare: api(worker) }), /LOGIN_MODE[\s\S]*LOGIN_PASSWORD[\s\S]*SESSION_SECRET[\s\S]*LOGIN_RATE_LIMITER/);
  worker.settings.bindings.push({ name: "LOGIN_MODE", type: "plain_text", text: "dual" }, { name: "LOGIN_RATE_LIMITER", type: "ratelimit", simple: { limit: 10, period: 60 } });
  worker.secrets.push({ name: "LOGIN_PASSWORD", type: "secret_text" }, { name: "SESSION_SECRET", type: "secret_text" });
  await checkWorkerDeployment({ ...options, loginMode: "dual", cloudflare: api(worker) });
});

test("checks the public login page, protected session API, and the isolated OTP bridge", async () => {
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/") return new Response(null, { status: 303, headers: { Location: "/login" } });
    if (path === "/login") return new Response("login", { headers: { "Content-Type": "text/html" } });
    if (path === "/api/session") return Response.json({ error: "Please log in" }, { status: 401 });
    return new Response(null, { status: 302, headers: { Location: `https://${teamDomain}/cdn-cgi/access/login/${domain}` } });
  };
  await checkAnonymousAccess({ domain, teamDomain, loginMode: "dual", fetcher, log: () => {} });
  await assert.rejects(checkAnonymousAccess({ domain, teamDomain, loginMode: "dual", log: () => {}, fetcher: async (url) => new URL(url).pathname === "/api/session" ? Response.json({ email: "leaked" }) : fetcher(url) }), /双登录检查失败/);
});
