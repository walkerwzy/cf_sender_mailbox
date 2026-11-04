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
  if (/^Cloudflare[^\r\n]*失败（(?:401|403)）/m.test(deploymentLog)) {
    return { code: "CF_PERMISSION", message: "Cloudflare 拒绝当前 Token。请按上方失败的 API 路径检查对应权限、账号和域名范围。" };
  }
  if (/(?:Cloudflare|Resend)[^\r\n]*失败（(?:429|500|502|503|504)）/.test(deploymentLog)) {
    return { code: "PROVIDER_TEMPORARY", message: "API 返回了限流或暂时性服务错误。只读请求已有限重试，请稍后重新运行部署。" };
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
  const names = ["CLOUDFLARE_API_TOKEN", "RESEND_API_KEY", "RESEND_ADMIN_API_KEY", "RESEND_READ_API_KEY", "LOGIN_PASSWORD", "SESSION_SECRET"];
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
