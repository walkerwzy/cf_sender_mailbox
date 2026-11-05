const PREFIX = "attachment/";
const RULE_ID = "sendmail-attachment-expire";
const RETENTION = 10 * 86400;
const HEADERS = ["content-type", "content-disposition", "if-none-match"];

export function r2Config(config) {
  const names = ["R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  if (!names.some((name) => config[name])) return null;
  const missing = names.filter((name) => !config[name]);
  if (missing.length) throw new Error(`启用附件需要在 .env.deploy 填写 ${missing.join("、")}。`);
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.R2_BUCKET_NAME)) throw new Error("R2_BUCKET_NAME 应为 3 至 63 位小写字母、数字或连字符，首尾不能为连字符。");
  if (config.R2_SECRET_ACCESS_KEY.length < 32) throw new Error("R2_SECRET_ACCESS_KEY 格式无效，请使用 R2 S3 Token 的 Secret Access Key。");
  return { bucketName: config.R2_BUCKET_NAME };
}

export async function ensureAttachmentBucket({ cloudflare, accountId, bucketName, origin, checkOnly = false, log = console.log }) {
  const base = `/accounts/${accountId}/r2/buckets`;
  const bucket = `${base}/${encodeURIComponent(bucketName)}`;
  try { await cloudflare(bucket); }
  catch (error) {
    if (error.status !== 404) throw error;
    if (checkOnly) throw new Error("附件 R2 Bucket 尚未创建，请运行 npm run deploy:worker。");
    await cloudflare(base, "POST", { name: bucketName });
  }
  const readRules = async (path) => {
    try { return await cloudflare(path); }
    catch (error) { if (error.status === 404) return { rules: [] }; throw error; }
  };
  const [cors, lifecycle] = await Promise.all([
    readRules(`${bucket}/cors`), readRules(`${bucket}/lifecycle`),
  ]);
  if (!Array.isArray(cors?.rules) || !Array.isArray(lifecycle?.rules)) throw new Error("R2 CORS 或生命周期配置格式异常。");
  // A broader or narrower early-deletion rule would invalidate emailed links.
  const overlap = (prefix) => PREFIX.startsWith(prefix) || prefix.startsWith(PREFIX);
  for (const rule of lifecycle.rules) {
    if (rule.id === RULE_ID || !rule.enabled || !rule.deleteObjectsTransition || !overlap(rule.conditions?.prefix || "")) continue;
    const condition = rule.deleteObjectsTransition.condition;
    if (condition?.type !== "Age" || !(condition.maxAge >= RETENTION)) throw new Error(`R2 生命周期规则 ${rule.id} 可能提前删除附件。请调整该规则或使用专用 Bucket；部署不会覆盖其他规则。`);
  }
  const corsReady = cors.rules.some((rule) => rule.allowed?.origins?.includes(origin) && rule.allowed?.methods?.includes("PUT") && HEADERS.every((header) => rule.allowed?.headers?.some((item) => item === "*" || item.toLowerCase() === header)));
  const wanted = { id: RULE_ID, enabled: true, conditions: { prefix: PREFIX }, deleteObjectsTransition: { condition: { type: "Age", maxAge: RETENTION } } };
  const existing = lifecycle.rules.find((rule) => rule.id === RULE_ID);
  if (existing && existing.conditions?.prefix !== PREFIX) throw new Error(`R2 生命周期规则 ${RULE_ID} 被其他用途占用，请使用专用 Bucket。`);
  const lifecycleReady = existing?.enabled === true && existing.deleteObjectsTransition?.condition?.type === "Age" && existing.deleteObjectsTransition.condition.maxAge === RETENTION;
  if (checkOnly && (!corsReady || !lifecycleReady)) throw new Error("R2 直传 CORS 或 10 天附件清理规则尚未就绪，请运行 npm run deploy:worker。");
  if (!corsReady) await cloudflare(`${bucket}/cors`, "PUT", { rules: [...cors.rules, { allowed: { origins: [origin], methods: ["PUT"], headers: HEADERS }, exposeHeaders: ["ETag"], maxAgeSeconds: 3600 }] });
  if (!lifecycleReady) await cloudflare(`${bucket}/lifecycle`, "PUT", { rules: [...lifecycle.rules.filter((rule) => rule.id !== RULE_ID), { ...existing, ...wanted }] });
  log(`附件存储：R2 ${bucketName}，前缀 ${PREFIX}，直传来源 ${origin}，文件 10 天后自动清理。`);
}

export function applyR2Config(wrangler, secrets, config, accountId) {
  const attachment = r2Config(config);
  if (!attachment) return;
  wrangler.vars.R2_ACCOUNT_ID = accountId;
  wrangler.vars.R2_BUCKET_NAME = attachment.bucketName;
  wrangler.r2_buckets = [{ binding: "ATTACHMENTS_BUCKET", bucket_name: attachment.bucketName }];
  secrets.R2_ACCESS_KEY_ID = config.R2_ACCESS_KEY_ID;
  secrets.R2_SECRET_ACCESS_KEY = config.R2_SECRET_ACCESS_KEY;
}
