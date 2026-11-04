function recordContent(value) {
  return String(value).replace(/^"|"$/g, "").replace(/\.$/, "");
}

// Only configure Resend's sending records, never inbox/receiving MX records.
export async function ensureSendingDomains({ domains, resend, cloudflare, accountId, checkOnly = false, log = console.log, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const listing = await resend("/domains");
  if (!Array.isArray(listing.data)) throw new Error("Resend 域名列表格式异常。");
  if (listing.has_more) throw new Error("Resend 域名超过一页，请先整理域名列表或手动验证所需域名。");
  for (const name of domains) {
    let domain = listing.data.find((entry) => entry.name === name);
    if (!domain) {
      if (checkOnly) throw new Error(`Resend 尚未添加发件域名：${name}`);
      domain = await resend("/domains", "POST", { name });
      log(`已添加 Resend 发件域名：${name}`);
    }
    let detail = await resend(`/domains/${domain.id}`);
    if (detail.status === "verified") { log(`Resend 发件域名已验证：${name}`); continue; }
    if (checkOnly) throw new Error(`Resend 发件域名尚未验证：${name}`);

    const zones = await cloudflare(`/zones?name=${encodeURIComponent(name)}&account.id=${accountId}`);
    const zone = zones.find((entry) => entry.name === name);
    if (!zone) throw new Error(`当前 Cloudflare 账号下找不到 ${name} 的 DNS Zone。`);
    const records = detail.records?.filter((record) => ["DKIM", "SPF"].includes(record.record));
    if (!records?.length || records.some((record) => !["TXT", "MX"].includes(record.type))) throw new Error(`Resend 没有返回有效的发送 DNS 记录：${name}`);
    // Validate all changes before writing any DNS records.
    const missing = [];
    for (const record of records) {
      let hostname = record.name.replace(/\.$/, "").toLowerCase();
      if (hostname !== name && !hostname.endsWith(`.${name}`)) {
        if (!/^(?:send|[a-z0-9_-]+\._domainkey)$/.test(hostname)) throw new Error(`DNS 记录不属于发件域名：${hostname}`);
        hostname = `${hostname}.${name}`;
      }
      if (hostname === name || !hostname.endsWith(`.${name}`)) throw new Error(`拒绝修改根域名或其他域名的 DNS：${hostname}`);
      const existing = await cloudflare(`/zones/${zone.id}/dns_records?type=${record.type}&name=${encodeURIComponent(hostname)}`);
      const matching = existing.some((entry) => recordContent(entry.content) === recordContent(record.value) && (record.type !== "MX" || entry.priority === (record.priority ?? 10)));
      if (matching) continue;
      if (existing.length) throw new Error(`${hostname} 已有不同的 ${record.type} 记录，请先处理冲突；脚本不会覆盖它。`);
      const change = { type: record.type, name: hostname, content: recordContent(record.value), ttl: 1, comment: "Resend sending domain · Walker Mailroom" };
      if (record.type === "MX") change.priority = record.priority ?? 10;
      missing.push(change);
    }
    for (const record of missing) {
      await cloudflare(`/zones/${zone.id}/dns_records`, "POST", record);
      log(`已添加发送 DNS：${record.type} ${record.name}`);
    }
    await resend(`/domains/${domain.id}/verify`, "POST");
    for (let attempt = 0; attempt < 6; attempt++) {
      detail = await resend(`/domains/${domain.id}`);
      if (detail.status === "verified") break;
      log(`等待 ${name} 的 DNS 验证（${attempt + 1}/6）…`);
      await pause(10000);
    }
    if (detail.status !== "verified") throw new Error(`${name} 的 DNS 已配置，但验证仍在进行中。稍后重新运行 npm run deploy 即可继续。`);
    log(`Resend 发件域名已验证：${name}`);
  }
}
