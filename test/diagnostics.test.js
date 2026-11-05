import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseDeployment } from "../scripts/diagnose-deploy.mjs";

const routeLog = "⛅️ wrangler\nUploaded sendmail-cf (5.60 sec)\nGET /zones/5f01ece26acfa2edd254b52253b1b9cc/workers/routes\nForbidden 403\nNo access to the specified resource.";

test("identifies the uploaded Worker and failed domain binding from Wrangler logs", () => {
  const report = diagnoseDeployment("Wrangler 执行失败（退出码 1）。", routeLog);
  assert.equal(report.code, "ROUTE_PERMISSION");
  assert.match(report.message, /Worker 已上传/);
  assert.match(report.message, /Workers Routes → Edit/);
});

test("current network failures take precedence over older Wrangler failures", () => {
  assert.equal(diagnoseDeployment("无法连接 Cloudflare：ENOTFOUND。", routeLog).code, "DNS");
});

test("connection resets in a normal terminal are not labeled as sandbox or permission failures", () => {
  const report = diagnoseDeployment("无法连接 Resend：ECONNRESET。请检查当前命令行的网络权限。");
  assert.equal(report.code, "CONNECTION_RESET");
  assert.match(report.message, /连接被中途断开/);
  assert.ok(!report.message.includes("沙箱权限"));
});

test("distinguishes DNS, explicit sandbox limits, timeouts, refusal, and TLS failures", () => {
  assert.equal(diagnoseDeployment("无法连接 Cloudflare：ENOTFOUND。").code, "DNS");
  assert.equal(diagnoseDeployment("无法连接 Cloudflare：ENOTFOUND。当前进程设置了 CODEX_SANDBOX_NETWORK_DISABLED=1。").code, "SANDBOX_NETWORK");
  assert.equal(diagnoseDeployment("无法连接 Resend：TimeoutError。").code, "CONNECTION_TIMEOUT");
  assert.equal(diagnoseDeployment("无法连接 Resend：ECONNREFUSED。").code, "CONNECTION_REFUSED");
  assert.equal(diagnoseDeployment("无法连接 Resend：CERT_HAS_EXPIRED。").code, "TLS");
});

test("a recovered connection warning does not obscure a later provider authorization failure", () => {
  assert.equal(diagnoseDeployment("Resend GET /domains 连接异常（ECONNRESET），1 秒后重试。\nCloudflare GET /apps 失败（403）：permission").code, "CF_PERMISSION");
  assert.equal(diagnoseDeployment("Resend GET /domains 返回 HTTP 503，1 秒后重试。\nResend GET /domains 失败（503）：Unavailable").code, "PROVIDER_TEMPORARY");
});

test("R2 authorization failures identify the deployment token, account permission and resource scope", () => {
  const accountId = "95ff672e4bfa649f80840175f2de971f";
  for (const [method, suffix, status] of [["GET", "/tmpfile", 403], ["POST", "", 403], ["PUT", "/tmpfile/cors", 401], ["PUT", "/tmpfile/lifecycle", 403]]) {
    const report = diagnoseDeployment(`Cloudflare ${method} /accounts/${accountId}/r2/buckets${suffix} 失败（${status}）：Authentication error`);
    assert.equal(report.code, "R2_PERMISSION");
    assert.match(report.message, /CLOUDFLARE_API_TOKEN/);
    assert.match(report.message, /Account → Workers R2 Storage → Edit/);
    assert.match(report.message, /Account Resources/);
    assert.ok(report.message.includes(accountId));
    assert.match(report.message, /R2_ACCESS_KEY_ID \/ R2_SECRET_ACCESS_KEY/);
  }
});

test("R2 outages and unrelated Cloudflare authorization failures are not attributed to R2 permissions", () => {
  const path = "/accounts/95ff672e4bfa649f80840175f2de971f/r2/buckets/tmpfile";
  assert.equal(diagnoseDeployment(`Cloudflare GET ${path} 失败（503）：Unavailable`).code, "PROVIDER_TEMPORARY");
  assert.equal(diagnoseDeployment("Cloudflare GET /accounts/95ff672e4bfa649f80840175f2de971f/access/apps 失败（403）：Authentication error").code, "CF_PERMISSION");
});

test("early R2 cleanup is a deployment failure before publishing, even with an older Wrangler upload log", () => {
  const report = diagnoseDeployment("登录方式：密码 + 北京时间 MMDD，或邮箱验证码。\nR2 生命周期规则 auto delete after 3 days 可能提前删除附件。请调整该规则或使用专用 Bucket；部署不会覆盖其他规则。", routeLog);
  assert.equal(report.code, "R2_LIFECYCLE");
  assert.match(report.message, /部署未完成/);
  assert.match(report.message, /auto delete after 3 days/);
  assert.match(report.message, /新 Worker 上传和发布前停止/);
  assert.match(report.message, /至少 10 天/);
  assert.match(report.message, /不覆盖 attachment\//);
});

test("does not reuse a route failure from an earlier Wrangler invocation", () => {
  assert.equal(diagnoseDeployment("Wrangler 执行失败", `${routeLog}\n⛅️ wrangler\nMissing entrypoint`).code, "UNKNOWN");
});

test("distinguishes onboarding, provider authorization, and DNS verification", () => {
  assert.equal(diagnoseDeployment("账号尚未启用 Cloudflare Zero Trust / Access。").code, "ACCESS_ONBOARDING");
  assert.equal(diagnoseDeployment("Resend GET /domains 失败（403）：restricted").code, "RESEND_PERMISSION");
  assert.equal(diagnoseDeployment("wzy.one 的 DNS 已配置，但验证仍在进行中。").code, "DNS_PENDING");
});
