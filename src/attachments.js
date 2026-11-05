import { HttpError } from "./access.js";
import { hmac, presignR2, sha256 } from "./r2-signing.js";

export const ATTACHMENT_LIMITS = Object.freeze({ maxCount: 10, maxFileBytes: 25 * 1024 * 1024, maxTotalBytes: 25 * 1024 * 1024, linkMaxFileBytes: 100 * 1024 * 1024, linkMaxTotalBytes: 100 * 1024 * 1024, linkExpiresSeconds: 7 * 86400 });
export const UPLOAD_HEADERS = ["content-type", "content-disposition", "if-none-match"];
const PREFIX = "attachment/";
const TOKEN_TTL = 86400;
const UPLOAD_TTL = 900;
const encode = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decode = (value) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));

export function attachmentConfigured(env) {
  return /^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID || "") && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET_NAME || "") && typeof env.R2_ACCESS_KEY_ID === "string" && Boolean(env.R2_ACCESS_KEY_ID) && typeof env.R2_SECRET_ACCESS_KEY === "string" && env.R2_SECRET_ACCESS_KEY.length >= 32 && typeof env.ATTACHMENTS_BUCKET?.head === "function";
}

function requireConfig(env) {
  if (!attachmentConfigured(env)) throw new HttpError(503, "附件服务尚未配置，请联系管理员。");
}

function checkMode(mode) {
  if (!["attachment", "link"].includes(mode)) throw new HttpError(400, "请选择附件或下载链接方式。");
}

function filenameValid(filename) {
  return typeof filename === "string" && Boolean(filename.trim()) && ![".", ".."].includes(filename) && !/[\\/\x00-\x1f\x7f]/.test(filename) && new TextEncoder().encode(filename).length <= 255;
}

function validateFiles(files, mode) {
  checkMode(mode);
  if (!Array.isArray(files) || !files.length || files.length > ATTACHMENT_LIMITS.maxCount) throw new HttpError(400, "请选择 1 至 10 个文件。");
  const maximum = mode === "link" ? ATTACHMENT_LIMITS.linkMaxTotalBytes : ATTACHMENT_LIMITS.maxTotalBytes;
  let total = 0;
  for (const file of files) {
    if (!file || !filenameValid(file.filename)) throw new HttpError(400, "附件文件名无效，不能包含路径、控制字符或超过 255 字节。");
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new HttpError(400, "附件不能为空，文件大小必须有效。");
    total += file.size;
    if (file.size > maximum || total > maximum) throw new HttpError(413, mode === "link" ? "下载链接模式下，文件合计不能超过 100 MiB。" : "传统附件合计不能超过 25 MiB；更大的文件请选择下载链接。");
  }
}

async function seal(data, env) {
  const payload = encode(new TextEncoder().encode(JSON.stringify(data)));
  return `${payload}.${encode(await hmac(env.R2_SECRET_ACCESS_KEY, `mailroom-upload-v1:${payload}`))}`;
}

export async function readAttachmentToken(token, email, origin, env, now) {
  requireConfig(env);
  try {
    if (typeof token !== "string" || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
    const [payload, signature] = token.split(".");
    if (encode(decode(signature)) !== signature) throw new Error();
    const signingKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.R2_SECRET_ACCESS_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("HMAC", signingKey, decode(signature), new TextEncoder().encode(`mailroom-upload-v1:${payload}`))) throw new Error();
    const data = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (data.v !== 1 || data.email !== email || data.origin !== origin || data.bucket !== env.R2_BUCKET_NAME || data.account !== env.R2_ACCOUNT_ID || !Number.isSafeInteger(data.createdAt) || data.createdAt > now + 30 || data.expires !== data.createdAt + TOKEN_TTL || data.expires <= now || typeof data.key !== "string" || !data.key.startsWith(PREFIX)) throw new Error();
    validateFiles([data], "link");
    return data;
  } catch { throw new HttpError(400, "附件引用无效或已过期，请重新选择并上传文件。"); }
}

export async function createUploads(files, mode, email, origin, env, now) {
  requireConfig(env);
  validateFiles(files, mode);
  const owner = (await sha256(JSON.stringify([origin, email]))).slice(0, 32);
  return { files: await Promise.all(files.map(async ({ filename, size }) => {
    const data = { v: 1, email, origin, bucket: env.R2_BUCKET_NAME, account: env.R2_ACCOUNT_ID, key: `${PREFIX}${owner}/${crypto.randomUUID()}`, filename, size, createdAt: now, expires: now + TOKEN_TTL };
    // Blob/File uploads set the signed Content-Length in the browser's HTTP stack.
    const headers = { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`, "If-None-Match": "*" };
    const url = await presignR2(env, { method: "PUT", key: data.key, createdAt: now, expires: UPLOAD_TTL, headers: { ...headers, "Content-Length": size } });
    return { filename, size, token: await seal(data, env), upload: { url, headers }, uploadExpiresAt: new Date((now + UPLOAD_TTL) * 1000).toISOString(), referenceExpiresAt: new Date(data.expires * 1000).toISOString(), downloadExpiresAt: new Date((now + ATTACHMENT_LIMITS.linkExpiresSeconds) * 1000).toISOString() };
  })) };
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

async function readFiles(refs, mode, email, origin, env, now) {
  checkMode(mode);
  if (refs === undefined) return [];
  if (!Array.isArray(refs) || refs.length > ATTACHMENT_LIMITS.maxCount) throw new HttpError(400, "附件格式不正确，最多添加 10 个文件。");
  if (!refs.length) return [];
  const tokens = refs.map((ref) => {
    if (!ref || typeof ref !== "object" || Array.isArray(ref) || Object.keys(ref).some((key) => key !== "token") || typeof ref.token !== "string") throw new HttpError(400, "请先上传文件，邮件只接受本站签发的附件引用。");
    return ref.token;
  });
  if (new Set(tokens).size !== tokens.length) throw new HttpError(400, "不能重复提交同一个附件。");
  const files = await Promise.all(tokens.map((token) => readAttachmentToken(token, email, origin, env, now)));
  if (new Set(files.map((file) => file.key)).size !== files.length) throw new HttpError(400, "不能重复提交同一个附件。");
  validateFiles(files, mode);
  return files;
}

export async function checkUploads(refs, mode, email, origin, env, now) {
  const files = await readFiles(refs, mode, email, origin, env, now);
  return inspectFiles(files, env);
}

async function inspectFiles(files, env) {
  return { files: await Promise.all(files.map(async (file) => {
    let object;
    try { object = await env.ATTACHMENTS_BUCKET.head(file.key); } catch { throw new HttpError(503, "暂时无法确认附件上传结果，请稍后重试。"); }
    if (object && object.size !== file.size) throw new HttpError(400, "附件大小不符，请移除并重新上传文件。");
    return { uploaded: Boolean(object) };
  })) };
}

export async function prepareMailAttachments(mail, refs, mode, email, origin, env, now) {
  const files = await readFiles(refs, mode, email, origin, env, now);
  if (!files.length) return mail;
  const result = await inspectFiles(files, env);
  if (result.files.some((file) => !file.uploaded)) throw new HttpError(400, "附件尚未上传完成，请重新上传文件。");
  const attachments = await Promise.all(files.map(async (file) => ({ filename: file.filename, path: await presignR2(env, { method: "GET", key: file.key, createdAt: file.createdAt, expires: ATTACHMENT_LIMITS.linkExpiresSeconds }) })));
  if (mode === "attachment") return { ...mail, attachments };
  const until = (file) => new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date((file.createdAt + ATTACHMENT_LIMITS.linkExpiresSeconds) * 1000));
  if (typeof mail.text === "string") return { ...mail, text: `${mail.text}\n\n文件下载（时间为北京时间）：\n${attachments.map((attachment, index) => `${attachment.filename}（有效期至 ${until(files[index])}）\n${attachment.path}`).join("\n\n")}` };
  return { ...mail, html: `${mail.html}\n<hr><p>文件下载（时间为北京时间）：</p><ul>${attachments.map((attachment, index) => `<li><a href="${escapeHtml(attachment.path)}">${escapeHtml(attachment.filename)}</a>（有效期至 ${escapeHtml(until(files[index]))}）</li>`).join("")}</ul>` };
}
