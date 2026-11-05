import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { networkReport } from "./network.mjs";

export function diagnoseDeployment(deploymentLog, wranglerLog = "") {
  const failure = [...deploymentLog.matchAll(/^无法连接[^\r\n：:]*[：:]\s*([A-Za-z0-9_]+)/gm)].at(-1);
  if (failure) return networkReport(failure[1], /CODEX_SANDBOX_NETWORK_DISABLED=1/.test(failure[0] + deploymentLog.slice(failure.index)));
  if (/Token 无法访问[\s\S]*Workers 路由/.test(deploymentLog)) {
    return { code: "ROUTE_PERMISSION", message: "上传前检查失败：请给当前 CF Token 添加 Zone → Workers Routes → Edit，并将 Zone Resources 范围设为 wzy.one。" };
  }
  // Ignore failures from earlier Wrangler invocations in its append-only log.
  const marker = wranglerLog.lastIndexOf("⛅️ wrangler");
  const latestAttempt = marker < 0 ? wranglerLog : wranglerLog.slice(marker);
  if (/Wrangler 执行失败/.test(deploymentLog)) {
    const routeFailure = /\/zones\/([a-f0-9]{32})\/workers\/routes[\s\S]{0,12000}(?:No access to the specified resource|Forbidden 403)/i.exec(latestAttempt);
    if (routeFailure) {
      const uploaded = /Uploaded sendmail-cf/.test(deploymentLog + latestAttempt);
      return { code: "ROUTE_PERMISSION", message: `${uploaded ? "Worker 已上传，域名绑定失败。" : "域名路由访问失败。"}请给当前 CF Token 添加 Zone → Workers Routes → Edit，范围包含 wzy.one（Zone ${routeFailure[1]}）。` };
    }
  }
  if (/ACCESS_ONBOARDING_REQUIRED|尚未启用 Cloudflare Zero Trust|access.api.error.not_enabled/.test(deploymentLog)) {
    return { code: "ACCESS_ONBOARDING", message: "请进入 https://one.dash.cloudflare.com/ ，选择账号完成 Zero Trust 首次设置，然后重新部署。" };
  }
  if (/^Resend[^\r\n]*失败（(?:401|403)）/m.test(deploymentLog)) {
    return { code: "RESEND_PERMISSION", message: "Resend Key 无效或无法管理域名。请检查 RESEND_API_KEY；域名配置使用的 RESEND_ADMIN_API_KEY 需要 Full access。" };
  }
  const r2Failure = [...deploymentLog.matchAll(/^Cloudflare [A-Z]+ \/accounts\/([a-f0-9]{32})\/r2\/buckets(?:\/[^\s]*)? 失败（(?:401|403)）/gmi)].at(-1);
  if (r2Failure) {
    return { code: "R2_PERMISSION", message: `R2 管理 API 拒绝了部署凭证 CLOUDFLARE_API_TOKEN。个人 Token 的 UI 入口为右上角头像 → My Profile → API Tokens；账号 Token 为左侧 Manage Account → Account API Tokens。请按此部署 Token 的归属找到它，检查 Account → Workers R2 Storage → Edit，Account Resources 范围需包含账号 ${r2Failure[1]}。找不到旧 Token 时可按 README 权限表创建命名为 sendmail-cf-deploy 的个人部署 Token，并更新本地配置。同时确认 Bucket 属于该账号、Token 未过期且当前环境变量没有覆盖 .env.deploy 中的新 Token。R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY 用于 S3 文件读写，不能代替这项管理权限；Token 验证为 active 也不能证明它有 R2 权限。` };
  }
  if (/^Cloudflare[^\r\n]*失败（(?:401|403)）/m.test(deploymentLog)) {
    return { code: "CF_PERMISSION", message: "Cloudflare 拒绝当前 Token。请按上方失败的 API 路径检查对应权限、账号和域名范围。" };
  }
  if (/(?:Cloudflare|Resend)[^\r\n]*失败（(?:429|500|502|503|504)）/.test(deploymentLog)) {
    return { code: "PROVIDER_TEMPORARY", message: "API 返回了限流或暂时性服务错误。只读请求已有限重试，请稍后重新运行部署。" };
  }
  const lifecycleFailure = /^R2 生命周期规则 (.+?) 可能提前删除附件。/m.exec(deploymentLog);
  if (lifecycleFailure) {
    return { code: "R2_LIFECYCLE", message: `部署未完成：R2 规则「${lifecycleFailure[1]}」可能提前删除 attachment/ 下的文件，检查已在新 Worker 上传和发布前停止。请在 Bucket 的 Settings → Object lifecycle rules 中，将这条规则的保留时间设为至少 10 天，或将它限定到不覆盖 attachment/ 的其他前缀，再重新部署。邮件中的签名下载链接有效 7 天；新增 10 天清理规则无法覆盖更早的删除规则。` };
  }
  if (/验证仍在进行中/.test(deploymentLog)) {
    return { code: "DNS_PENDING", message: "发送 DNS 已配置，等待传播完成后重新运行 npm run deploy 即可。" };
  }
  return { code: "UNKNOWN", message: "失败详情已保存到 .deploy/deploy.log；Wrangler 详情位于 .deploy/wrangler.log。" };
}

async function readOptional(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

async function main() {
  const env = parseEnv(await readOptional(".env.deploy"));
  const names = ["CLOUDFLARE_API_TOKEN", "RESEND_API_KEY", "RESEND_ADMIN_API_KEY", "RESEND_READ_API_KEY", "LOGIN_PASSWORD", "SESSION_SECRET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  const secrets = [...names.flatMap((name) => [env[name], process.env[name]]), await readOptional(".deploy/session-secret")].filter(Boolean);
  const deploymentLog = await readOptional(".deploy/deploy.log");
  const wranglerLog = await readOptional(".deploy/wrangler.log");
  const report = diagnoseDeployment(deploymentLog || "Wrangler 执行失败", wranglerLog);
  const safe = secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), report.message);
  console.log(`自动诊断 [${report.code}]：${safe}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("无法读取部署日志。"); process.exitCode = 1; });
}
