function isAccessNotEnabled(error) {
  return error.status === 403 && (
    error.apiErrors?.some((entry) => entry.message?.includes("access.api.error.not_enabled")) ||
    error.message?.includes("access.api.error.not_enabled")
  );
}

function onboardingRequired(accountId) {
  const error = new Error(
    `账号 ${accountId} 尚未启用 Cloudflare Zero Trust / Access。\n` +
    "请打开 https://one.dash.cloudflare.com/ ，选择这个账号，完成首次设置并选择 Free 套餐。\n" +
    "完成后重新运行 npm run deploy；ACCESS_TEAM_DOMAIN 可以留空以读取已有组织。"
  );
  error.code = "ACCESS_ONBOARDING_REQUIRED";
  return error;
}

export async function ensureAccessOrganization({ cloudflare, accountId, teamDomain, checkOnly = false, log = console.log }) {
  const path = `/accounts/${accountId}/access/organizations`;
  let organization;
  let disabled = false;
  try {
    organization = await cloudflare(path);
  } catch (error) {
    disabled = isAccessNotEnabled(error);
    // Ordinary permission errors must not trigger a creation request.
    if (error.status !== 404 && !disabled) throw error;
  }
  if (!organization?.auth_domain) {
    if (checkOnly) {
      if (disabled) throw onboardingRequired(accountId);
      throw new Error("这个账号尚未创建 Zero Trust 组织。运行 npm run deploy 将尝试创建。");
    }
    const team = teamDomain || `walker-${accountId.slice(0, 10)}.cloudflareaccess.com`;
    try {
      organization = await cloudflare(path, "POST", { name: "Walker Mailroom", auth_domain: team });
    } catch (error) {
      if (isAccessNotEnabled(error)) throw onboardingRequired(accountId);
      throw error;
    }
    if (!organization?.auth_domain) throw new Error("Cloudflare 没有返回 Zero Trust 组织域名，已停止部署。");
    log(`已创建 Zero Trust 组织：${organization.auth_domain}`);
  }
  return organization;
}
