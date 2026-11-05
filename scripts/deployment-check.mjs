function normalizedEmails(value) {
  return [...new Set(value.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean))].sort();
}

// Inspect the deployed Worker, including uploads whose later domain binding failed.
// All API calls are reads; a manually bound domain needs no zone-route permissions.
export async function checkWorkerDeployment({ cloudflare, accountId, domain, customDomain, teamDomain, audience, emails, loginMode = "access", readApiKeyConfigured = false, attachmentBucket, workerName = "sendmail-cf", log = console.log }) {
  const base = `/accounts/${accountId}/workers`;
  const script = `${base}/scripts/${encodeURIComponent(workerName)}`;
  let settings;
  try {
    settings = await cloudflare(`${script}/settings`);
  } catch (error) {
    if (error.status === 404) throw new Error(`Worker ${workerName} 尚未部署，请运行 npm run deploy。`);
    throw error;
  }
  if (!Array.isArray(settings?.bindings)) throw new Error("Worker 线上绑定配置格式异常。");
  const [secrets, subdomain, domains] = await Promise.all([
    cloudflare(`${script}/secrets`),
    cloudflare(`${script}/subdomain`),
    customDomain ? cloudflare(`${base}/domains`) : Promise.resolve([]),
  ]);
  if (!Array.isArray(secrets) || !Array.isArray(domains)) throw new Error("Worker 线上 Secret 或域名列表格式异常。");
  const bindings = settings.bindings;
  const problems = [];
  const mode = bindings.find((binding) => binding.name === "LOGIN_MODE");
  if ((loginMode === "dual" || mode) && (mode?.type !== "plain_text" || mode.text !== loginMode)) problems.push("Worker 变量 LOGIN_MODE 与登录方式不一致");
  const expected = { MAIL_FROM_NAME: "walker", ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: audience };
  for (const [name, text] of Object.entries(expected)) {
    if (!bindings.some((binding) => binding.type === "plain_text" && binding.name === name && binding.text === text)) {
      problems.push(`Worker 变量 ${name} 缺少或与 Access 配置不一致`);
    }
  }
  const allowed = bindings.find((binding) => binding.type === "plain_text" && binding.name === "ALLOWED_EMAILS");
  if (typeof allowed?.text !== "string" || JSON.stringify(normalizedEmails(allowed.text)) !== JSON.stringify(normalizedEmails(emails.join(",")))) {
    problems.push("Worker 变量 ALLOWED_EMAILS 与允许登录的邮箱不一致");
  }
  if (!secrets.some((secret) => secret.name === "RESEND_API_KEY" && secret.type === "secret_text")) problems.push("Worker 缺少 RESEND_API_KEY Secret");
  if (readApiKeyConfigured && !secrets.some((secret) => secret.name === "RESEND_READ_API_KEY" && secret.type === "secret_text")) problems.push("Worker 缺少 RESEND_READ_API_KEY Secret");
  if (attachmentBucket) {
    for (const [name, text] of Object.entries({ R2_ACCOUNT_ID: accountId, R2_BUCKET_NAME: attachmentBucket })) {
      if (!bindings.some((binding) => binding.name === name && binding.type === "plain_text" && binding.text === text)) problems.push(`Worker 变量 ${name} 与附件配置不一致`);
    }
    for (const name of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
      if (!secrets.some((secret) => secret.name === name && secret.type === "secret_text")) problems.push(`Worker 缺少 ${name} Secret`);
    }
    if (!bindings.some((binding) => binding.name === "ATTACHMENTS_BUCKET" && binding.type === "r2_bucket" && binding.bucket_name === attachmentBucket)) problems.push("Worker 缺少正确的 ATTACHMENTS_BUCKET R2 绑定");
    if (!bindings.some((binding) => binding.name === "UPLOAD_RATE_LIMITER" && binding.type === "ratelimit" && binding.simple?.limit === 10 && binding.simple?.period === 60)) problems.push("Worker 的 UPLOAD_RATE_LIMITER 应为每分钟 10 次");
  }
  if (loginMode === "dual") {
    for (const name of ["LOGIN_PASSWORD", "SESSION_SECRET"]) {
      if (!secrets.some((secret) => secret.name === name && secret.type === "secret_text")) problems.push(`Worker 缺少 ${name} Secret`);
    }
    if (!bindings.some((binding) => binding.name === "LOGIN_RATE_LIMITER" && binding.type === "ratelimit" && binding.simple?.limit === 10 && binding.simple?.period === 60)) problems.push("Worker 的 LOGIN_RATE_LIMITER 应为每分钟 10 次");
  }
  if (!bindings.some((binding) => binding.name === "ASSETS" && binding.type === "assets")) problems.push("Worker 缺少静态资源 ASSETS 绑定");
  if (!bindings.some((binding) => binding.name === "SEND_RATE_LIMITER" && binding.type === "ratelimit" && binding.simple?.limit === 5 && binding.simple?.period === 60)) {
    problems.push("Worker 的 SEND_RATE_LIMITER 应为每分钟 5 次");
  }
  if (!bindings.some((binding) => binding.name === "OUTBOX_RATE_LIMITER" && binding.type === "ratelimit" && binding.simple?.limit === 30 && binding.simple?.period === 60)) problems.push("Worker 的 OUTBOX_RATE_LIMITER 应为每分钟 30 次");
  if (subdomain?.enabled !== !customDomain) problems.push(customDomain ? "请关闭此 Worker 的 workers.dev 地址" : "请启用此 Worker 的 workers.dev 地址");
  if (subdomain?.previews_enabled !== false) problems.push("请关闭此 Worker 的 Preview URLs（预览地址）");
  if (customDomain) {
    const binding = domains.find((entry) => entry.hostname === domain);
    if (!binding) problems.push(`${domain} 尚未绑定 Worker ${workerName}`);
    else if (binding.service !== workerName || binding.environment !== "production") problems.push(`${domain} 绑定到了其他 Worker 或环境`);
    else if (binding.enabled === false) problems.push(`${domain} 的自有域名绑定已停用`);
  }
  if (problems.length) {
    throw new Error(`线上部署尚未完成：\n${problems.map((problem) => `- ${problem}`).join("\n")}\n可在 Cloudflare 后台补齐，或补全 Token 权限后运行 npm run deploy。`);
  }
  log("Worker 线上变量、Secret、静态资源、限流和访问地址检查通过。");
}

export async function checkAnonymousAccess({ domain, teamDomain, loginMode = "access", fetcher = fetch, log = console.log }) {
  const paths = loginMode === "dual" ? ["/", "/login", "/api/session", "/auth/access"] : ["/", "/api/session"];
  await Promise.all(paths.map(async (path) => {
    let response;
    try {
      response = await fetcher(`https://${domain}${path}`, { redirect: "manual", signal: AbortSignal.timeout(20000) });
    } catch (error) {
      throw new Error(`无法连接页面 ${domain}${path}：${error.cause?.code || error.name}。请检查域名 DNS、TLS 和当前命令行的网络权限。`);
    }
    let location;
    try { location = new URL(response.headers.get("location") || "", `https://${domain}`); } catch { /* Report invalid redirects below. */ }
    if (loginMode === "dual") {
      if (path === "/" && [302, 303, 307, 308].includes(response.status) && location?.origin === `https://${domain}` && location.pathname === "/login") { await response.body?.cancel(); return; }
      if (path === "/login" && response.status === 200 && response.headers.get("content-type")?.includes("text/html")) { await response.body?.cancel(); return; }
      if (path === "/api/session" && response.status === 401 && response.headers.get("content-type")?.includes("application/json")) { await response.body?.cancel(); return; }
      if (path !== "/auth/access") {
        await response.body?.cancel();
        throw new Error(`${path} 的双登录检查失败（HTTP ${response.status}），请运行 npm run deploy:worker 同步 Worker 和 Access 登录范围。`);
      }
    }
    await response.body?.cancel();
    if ([302, 303, 307, 308].includes(response.status) && location?.origin === `https://${teamDomain}` && location.pathname.startsWith("/cdn-cgi/access/login/")) return;
    if (response.status === 401) throw new Error(`${path} 被 Worker 拒绝，但没有跳转到 Access 登录。请确认 Access 应用覆盖 ${domain} 的所有路径。`);
    throw new Error(`${path} 的匿名登录检查失败（HTTP ${response.status}），请确认域名已生效且 Access 应用覆盖全部路径。`);
  }));
  log(loginMode === "dual" ? "密码登录页面、匿名接口拒绝访问及 Access 验证码入口检查通过。" : "页面和 /api/session 的匿名请求均跳转到 Cloudflare Access 登录。");
}
