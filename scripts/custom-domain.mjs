export async function preflightCustomDomain({ cloudflare, accountId, domain }) {
  const pieces = domain.split(".");
  let zone;
  for (let index = 0; index < pieces.length - 1; index++) {
    const name = pieces.slice(index).join(".");
    const zones = await cloudflare(`/zones?name=${encodeURIComponent(name)}&account.id=${accountId}`);
    if (!Array.isArray(zones)) throw new Error("Cloudflare 域名列表格式异常。");
    zone = zones.find((entry) => entry.name === name);
    if (zone) break;
  }
  if (!zone?.id) throw new Error(`当前 Token 无法找到 ${domain} 所属的 DNS Zone。请检查账号范围以及 Zone → Zone → Read 权限。`);
  try {
    // Wrangler also reads zone routes before binding a Custom Domain.
    await cloudflare(`/zones/${zone.id}/workers/routes`);
  } catch (error) {
    if ([401, 403].includes(error.status)) {
      const failure = new Error(
        `Token 无法访问 ${zone.name}（Zone ${zone.id}）的 Workers 路由。\n` +
        "请在 Cloudflare API Tokens 中编辑此 Token，添加 Zone → Workers Routes → Edit，\n" +
        `并确认 Zone Resources 包含 ${zone.name}。然后重新运行 npm run deploy。\n` +
        "入口：https://dash.cloudflare.com/profile/api-tokens"
      );
      failure.code = "CUSTOM_DOMAIN_PERMISSION";
      throw failure;
    }
    throw error;
  }
  return { id: zone.id, name: zone.name };
}
