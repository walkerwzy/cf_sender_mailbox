export const ACCESS_LOGIN_PATH = "/auth/access";

export function planAccessScope({ apps, domain, loginMode, appName, otpId, checkOnly = false }) {
  const accessDomain = loginMode === "dual" ? `${domain}${ACCESS_LOGIN_PATH}` : domain;
  const candidates = apps.filter((entry) => [domain, `${domain}${ACCESS_LOGIN_PATH}`].includes(entry.domain));
  if (candidates.some((entry) => entry.name !== appName)) throw new Error(`${domain} 已有其他 Access 应用，请先核对保护范围。`);
  if (candidates.length > 1) throw new Error(`${domain} 同时存在多个 Access 应用，请先核对保护范围。`);
  const app = candidates[0];
  if (checkOnly && app && app.domain !== accessDomain) throw new Error("Access 登录范围需要更新，请运行 npm run deploy:worker 完成登录方式迁移。");
  const appConfig = { name: appName, domain: accessDomain, type: "self_hosted", session_duration: "24h", allowed_idps: [otpId], auto_redirect_to_identity: true, app_launcher_visible: false };
  return { app, appConfig, accessDomain };
}

// Apply a narrower or broader gate only after the matching Worker is deployed.
export async function applyAccessScope({ cloudflare, base, app, appConfig }) {
  const updated = await cloudflare(`${base}/access/apps/${app.id}`, "PUT", appConfig);
  if (updated?.aud !== app.aud) throw new Error("Access 应用的 audience 发生变化，请重新运行部署同步 Worker 配置。");
  return updated;
}
