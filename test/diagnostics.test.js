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

test("does not reuse a route failure from an earlier Wrangler invocation", () => {
  assert.equal(diagnoseDeployment("Wrangler 执行失败", `${routeLog}\n⛅️ wrangler\nMissing entrypoint`).code, "UNKNOWN");
});

test("distinguishes onboarding, provider authorization, and DNS verification", () => {
  assert.equal(diagnoseDeployment("账号尚未启用 Cloudflare Zero Trust / Access。").code, "ACCESS_ONBOARDING");
  assert.equal(diagnoseDeployment("Resend GET /domains 失败（403）：restricted").code, "RESEND_PERMISSION");
  assert.equal(diagnoseDeployment("wzy.one 的 DNS 已配置，但验证仍在进行中。").code, "DNS_PENDING");
});
