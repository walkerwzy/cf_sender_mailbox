import { readFile, writeFile, mkdir, unlink, chmod } from "node:fs/promises";
import { parseEnv } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSendingDomains } from "./resend-domain.mjs";
import { ensureAccessOrganization } from "./access-organization.mjs";
import { preflightCustomDomain } from "./custom-domain.mjs";
import { checkWorkerDeployment, checkAnonymousAccess } from "./deployment-check.mjs";
import { deployWorkerVersion } from "./worker-version.mjs";
import { planAccessScope, applyAccessScope } from "./access-scope.mjs";
import { getSessionSecret } from "./session-secret.mjs";
import { makeApi } from "./api.mjs";
import { runWrangler } from "./wrangler-command.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const workerOnly = process.argv.includes("--worker-only");
const readOnlySetup = checkOnly || workerOnly;
const appName = "Walker Mailroom · sendmail-cf";
const policyName = "Mailroom members";
let local = {};
try { local = parseEnv(await readFile(resolve(root, ".env.deploy"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
const config = { ...local, ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== "")) };
// Reuse the existing full-access admin key unless a dedicated read key is supplied.
const outboxReadKey = config.RESEND_READ_API_KEY || config.RESEND_ADMIN_API_KEY;
const sensitive = [config.CLOUDFLARE_API_TOKEN, config.RESEND_API_KEY, config.RESEND_ADMIN_API_KEY, config.RESEND_READ_API_KEY, config.LOGIN_PASSWORD, config.SESSION_SECRET].filter(Boolean);
const redact = (text) => sensitive.reduce((result, value) => result.replaceAll(value, "[REDACTED]"), String(text));

function command(args, env = {}) {
  return runWrangler(args, { cwd: root, env, sensitive });
}

async function main() {
  if (checkOnly && workerOnly) throw new Error("--check 和 --worker-only 不能同时使用。");
  const loginMode = config.LOGIN_PASSWORD ? "dual" : "access";
  if (config.LOGIN_PASSWORD?.length > 508) throw new Error("LOGIN_PASSWORD 最多 508 个字符。");
  const emails = [...new Set((config.ALLOWED_EMAILS || "admin@wzy.one,hi@wzy.one").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length || emails.some((email) => !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email))) throw new Error("ALLOWED_EMAILS 必须包含有效的登录邮箱。");
  const missing = ["CLOUDFLARE_API_TOKEN", "RESEND_API_KEY"].filter((key) => !config[key]);
  if (missing.length) throw new Error(`请在 .env.deploy 中填写 ${missing.join("、")}。参考 .env.deploy.example；不要把密钥贴到对话里。`);
  if (config.MAIL_FROM_NAME && config.MAIL_FROM_NAME !== "walker") throw new Error("发件人名字固定为 walker，请使用 MAIL_FROM_NAME=walker。");
  if (config.APP_DOMAIN && (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(config.APP_DOMAIN) || config.APP_DOMAIN.endsWith(".workers.dev"))) {
    throw new Error("APP_DOMAIN 应为自有域名（例如 mail.wzy.one）；使用 workers.dev 时请留空。");
  }
  if (config.ACCESS_TEAM_DOMAIN && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(config.ACCESS_TEAM_DOMAIN)) throw new Error("ACCESS_TEAM_DOMAIN 格式应为 your-team.cloudflareaccess.com。");
  if (config.CLOUDFLARE_ACCOUNT_ID && !/^[a-f0-9]{32}$/i.test(config.CLOUDFLARE_ACCOUNT_ID)) throw new Error("CLOUDFLARE_ACCOUNT_ID 应为 32 位账号 ID。");
  await mkdir(resolve(root, ".deploy"), { recursive: true, mode: 0o700 });
  await chmod(resolve(root, ".deploy"), 0o700);
  const apiOptions = { warn: (message) => console.warn(redact(message)) };
  const cloudflare = makeApi("https://api.cloudflare.com/client/v4", { Authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}` }, "Cloudflare", apiOptions);
  const resend = makeApi("https://api.resend.com", { Authorization: `Bearer ${config.RESEND_ADMIN_API_KEY || config.RESEND_API_KEY}` }, "Resend", apiOptions);

  let accountId = config.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    const accounts = await cloudflare("/accounts?per_page=50");
    if (accounts.length !== 1) throw new Error(`Token 可访问 ${accounts.length} 个账号，请在 .env.deploy 中填写 CLOUDFLARE_ACCOUNT_ID。`);
    accountId = accounts[0].id;
  }
  console.log(`Cloudflare 账号：${accountId}`);
  const base = `/accounts/${accountId}`;
  // Detect route permission failures before changing Access, DNS, or the Worker.
  const customZone = config.APP_DOMAIN && !readOnlySetup ? await preflightCustomDomain({ cloudflare, accountId, domain: config.APP_DOMAIN }) : undefined;
  if (customZone) console.log(`域名路由访问检查通过：${customZone.name}`);
  const organization = await ensureAccessOrganization({ cloudflare, accountId, teamDomain: config.ACCESS_TEAM_DOMAIN, checkOnly: readOnlySetup });
  const teamDomain = organization.auth_domain.replace(/^https:\/\//, "").replace(/\/$/, "");
  if (config.ACCESS_TEAM_DOMAIN && teamDomain !== config.ACCESS_TEAM_DOMAIN) throw new Error(`已有 Zero Trust 组织为 ${teamDomain}，与 ACCESS_TEAM_DOMAIN 不同。请使用已有组织。`);
  console.log(`登录组织：${teamDomain}`);

  await ensureSendingDomains({ domains: [...new Set(emails.map((email) => email.split("@")[1]))], resend, cloudflare, accountId, checkOnly: readOnlySetup });

  let domain = config.APP_DOMAIN;
  if (!domain) {
    const subdomain = await cloudflare(`${base}/workers/subdomain`);
    if (!subdomain?.subdomain) throw new Error("账号尚未注册 workers.dev 子域名。请在 .env.deploy 设置 APP_DOMAIN 使用自有域名。");
    domain = `sendmail-cf.${subdomain.subdomain}.workers.dev`;
  }
  const providers = await cloudflare(`${base}/access/identity_providers`);
  let otp = providers.find((provider) => provider.type === "onetimepin");
  if (!otp) {
    if (readOnlySetup) throw new Error("尚未配置邮箱验证码登录。运行 npm run deploy 将自动配置。");
    otp = await cloudflare(`${base}/access/identity_providers`, "POST", { name: "Email one-time PIN", type: "onetimepin", config: {} });
  }

  const apps = await cloudflare(`${base}/access/apps?per_page=100`);
  let { app, appConfig, accessDomain } = planAccessScope({ apps, domain, loginMode, appName, otpId: otp.id, checkOnly });
  let pendingAppConfig;
  if (!app) {
    if (readOnlySetup) throw new Error("Access 应用尚未创建。运行 npm run deploy 将自动创建。");
    app = await cloudflare(`${base}/access/apps`, "POST", appConfig);
  } else if (checkOnly && (app.type !== "self_hosted" || app.allowed_idps?.length !== 1 || app.allowed_idps[0] !== otp.id)) {
    throw new Error("Access 应用没有限定为邮箱验证码登录，请运行 npm run deploy 更新。");
  }
  else if (!checkOnly && (!workerOnly || app.domain !== accessDomain || app.type !== "self_hosted" || app.allowed_idps?.length !== 1 || app.allowed_idps[0] !== otp.id)) pendingAppConfig = appConfig;
  if (!app?.aud) throw new Error("Cloudflare 没有返回 Access audience，已停止部署。");
  const policies = await cloudflare(`${base}/access/apps/${app.id}/policies`);
  if (policies.some((policy) => policy.name !== policyName)) throw new Error("这个 Access 应用存在其他策略。为避免改动现有授权，请先核对策略。");
  let policy = policies.find((entry) => entry.name === policyName);
  if (!readOnlySetup) {
    policy = await cloudflare(`${base}/access/apps/${app.id}/policies${policy ? `/${policy.id}` : ""}`, policy ? "PUT" : "POST", {
      name: policyName, decision: "allow", precedence: 1, include: emails.map((email) => ({ email: { email } })), exclude: [], require: [],
    });
  } else {
    const actual = (policy?.include || []).map((rule) => rule.email?.email).filter(Boolean).sort();
    if (!policy || policy.decision !== "allow" || JSON.stringify(actual) !== JSON.stringify([...emails].sort()) || policy.include.length !== emails.length || policy.exclude?.length || policy.require?.length) {
      throw new Error("Access 策略与允许登录的邮箱配置不同，请运行 npm run deploy 更新。");
    }
  }
  console.log(`允许登录：${emails.join("、")}`);
  console.log(`页面地址：https://${domain}`);
  console.log(loginMode === "dual" ? "登录方式：密码 + 北京时间 MMDD，或邮箱验证码。" : "登录方式：邮箱验证码。");
  console.log(`发件箱读取凭证：${config.RESEND_READ_API_KEY ? "RESEND_READ_API_KEY" : config.RESEND_ADMIN_API_KEY ? "复用 RESEND_ADMIN_API_KEY" : "复用 RESEND_API_KEY"}。`);
  const onlineCheck = { cloudflare, accountId, domain, customDomain: Boolean(config.APP_DOMAIN), teamDomain, audience: app.aud, emails, loginMode, readApiKeyConfigured: Boolean(outboxReadKey) };
  if (checkOnly) {
    await checkWorkerDeployment(onlineCheck);
    await checkAnonymousAccess({ domain, teamDomain, loginMode });
    console.log("在线配置与匿名登录检查通过；未修改任何线上配置，未发送邮件。请登录页面后确认发件服务就绪，再实际发送验证。");
    return;
  }

  const wrangler = JSON.parse(await readFile(resolve(root, "wrangler.jsonc"), "utf8"));
  wrangler.account_id = accountId;
  wrangler.main = "../src/worker.js";
  wrangler.assets.directory = "../public";
  wrangler.vars = { MAIL_FROM_NAME: "walker", ALLOWED_EMAILS: emails.join(","), ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: app.aud, LOGIN_MODE: loginMode };
  if (config.APP_DOMAIN && !workerOnly) { wrangler.workers_dev = false; wrangler.routes = [{ pattern: domain, custom_domain: true, zone_id: customZone.id }]; }
  if (workerOnly) {
    delete wrangler.routes;
    delete wrangler.route;
    delete wrangler.workers_dev;
    delete wrangler.preview_urls;
  }
  // Keep the local preview entrypoint entirely out of production configuration.
  delete wrangler.$schema;
  const configPath = resolve(root, workerOnly ? ".deploy/wrangler-worker.json" : ".deploy/wrangler.json");
  const secretPath = resolve(root, ".deploy/secrets.json");
  const workerSecrets = { RESEND_API_KEY: config.RESEND_API_KEY };
  if (outboxReadKey) workerSecrets.RESEND_READ_API_KEY = outboxReadKey;
  if (loginMode === "dual") {
    workerSecrets.LOGIN_PASSWORD = config.LOGIN_PASSWORD;
    workerSecrets.SESSION_SECRET = await getSessionSecret(resolve(root, ".deploy"), config.SESSION_SECRET);
    sensitive.push(workerSecrets.SESSION_SECRET);
  }
  await writeFile(configPath, `${JSON.stringify(wrangler, null, 2)}\n`, { mode: 0o600 });
  await writeFile(secretPath, JSON.stringify(workerSecrets), { mode: 0o600 });
  await chmod(secretPath, 0o600);
  let versionId;
  const wranglerEnv = { CLOUDFLARE_API_TOKEN: config.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: accountId };
  try {
    if (workerOnly) {
      versionId = await deployWorkerVersion({ command, configPath, secretPath, env: wranglerEnv });
      console.log(`Worker 新版本已发布：${versionId}。现有域名绑定保持不变，正在检查线上配置。`);
    } else {
      await command(["deploy", "--config", configPath, "--secrets-file", secretPath, "--no-experimental-autoconfig"], wranglerEnv);
    }
  } finally { await unlink(secretPath).catch(() => {}); }

  if (pendingAppConfig) {
    app = await applyAccessScope({ cloudflare, base, app, appConfig: pendingAppConfig });
    console.log(`Access 登录范围已同步：${accessDomain}`);
  }
  await checkWorkerDeployment(onlineCheck);
  await checkAnonymousAccess({ domain, teamDomain, loginMode });
  await writeFile(resolve(root, ".deploy/state.json"), `${JSON.stringify({ accountId, teamDomain, appId: app.id, domain, ...(versionId ? { versionId } : {}), deployedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  console.log(`部署完成：https://${domain}\n${loginMode === "dual" ? "可选择密码或邮箱验证码登录。" : "请使用允许的邮箱接收验证码并登录。"}发件人为 walker <登录邮箱>。`);
}

main().catch((error) => { console.error(redact(error.message)); process.exitCode = 1; });
