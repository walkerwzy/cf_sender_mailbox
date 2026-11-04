import { HttpError } from "./access.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 100;
const unavailable = () => new HttpError(502, "暂时无法读取发件箱，请稍后重试。");

export function ownsMail(mail, email) {
  if (typeof mail?.from !== "string") return false;
  const from = mail.from.trim();
  const address = from.includes("<") ? from.match(/^[^<>\r\n]*<([^<>\s]+)>$/)?.[1] : from;
  return address?.toLowerCase() === email.toLowerCase();
}

function readKey(env) {
  const key = env.RESEND_READ_API_KEY || env.RESEND_API_KEY;
  if (!key) throw new HttpError(503, "发件箱服务尚未配置。");
  return key;
}

async function readResend(path, env) {
  let response;
  try {
    response = await fetch(`https://api.resend.com${path}`, {
      headers: { Authorization: `Bearer ${readKey(env)}` },
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) throw new HttpError(404, "邮件不存在或已无法查询。");
    if ([401, 403].includes(response.status)) throw new HttpError(502, "发件箱读取授权失败，请联系管理员配置读取权限。");
    if (response.status === 429) throw new HttpError(429, "发件箱服务繁忙，请稍后重试。");
    throw unavailable();
  }
  try { return await response.json(); } catch { throw unavailable(); }
}

function summary(mail) {
  if (!ID.test(mail?.id || "") || typeof mail.from !== "string" || !Array.isArray(mail.to) || mail.to.some((value) => typeof value !== "string") || typeof mail.subject !== "string" || typeof mail.created_at !== "string") throw unavailable();
  // Never forward bodies, headers, or extra provider fields in the list.
  return { id: mail.id, from: mail.from, to: mail.to, subject: mail.subject, created_at: mail.created_at, last_event: typeof mail.last_event === "string" ? mail.last_event : null };
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function cursorKey(env, email, origin) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["outbox-cursor-v1", readKey(env), email, origin])));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sealCursor(id, env, email, origin, now) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cursorKey(env, email, origin), new TextEncoder().encode(JSON.stringify({ id, expires: now + 3600 }))));
  const bytes = new Uint8Array(iv.length + encrypted.length);
  bytes.set(iv); bytes.set(encrypted, iv.length);
  return encode(bytes);
}

async function openCursor(cursor, env, email, origin, now) {
  try {
    if (!/^[A-Za-z0-9_-]{40,400}$/.test(cursor)) throw new Error();
    const bytes = Uint8Array.from(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await cursorKey(env, email, origin), bytes.slice(12))));
    if (!ID.test(data.id) || !Number.isInteger(data.expires) || data.expires <= now) throw new Error();
    return data.id;
  } catch (error) {
    if (error instanceof HttpError && error.status === 503) throw error;
    throw new HttpError(400, "分页已失效，请刷新发件箱后重试。");
  }
}

export async function listOutbox(url, email, env, now = Math.floor(Date.now() / 1000)) {
  if ([...url.searchParams.keys()].some((name) => name !== "cursor") || url.searchParams.getAll("cursor").length > 1) throw new HttpError(400, "发件箱查询参数不正确。");
  const cursor = url.searchParams.get("cursor");
  const after = cursor === null ? null : await openCursor(cursor, env, email, url.origin, now);
  // One provider request per page, even when this sender has no mail on that page.
  const page = await readResend(`/emails?limit=${PAGE_SIZE}${after ? `&after=${after}` : ""}`, env);
  if (!Array.isArray(page?.data) || page.data.length > PAGE_SIZE || typeof page.has_more !== "boolean" || (page.has_more && !page.data.length)) throw unavailable();
  const rows = page.data.map(summary);
  const lastId = rows.at(-1)?.id;
  if (page.has_more && lastId === after) throw unavailable();
  return {
    data: rows.filter((mail) => ownsMail(mail, email)),
    has_more: page.has_more,
    // Hide other senders' cursor IDs and bind pagination to this user and host.
    next_cursor: page.has_more ? await sealCursor(lastId, env, email, url.origin, now) : null,
  };
}

export async function getOutboxMail(id, email, env) {
  if (!ID.test(id)) throw new HttpError(400, "邮件编号不正确。");
  const mail = await readResend(`/emails/${id}`, env);
  if (!ownsMail(mail, email)) throw new HttpError(404, "邮件不存在或已无法查询。");
  const data = summary(mail);
  if (data.id.toLowerCase() !== id.toLowerCase()) throw unavailable();
  const addresses = (value) => Array.isArray(value) ? value.filter((address) => typeof address === "string") : typeof value === "string" ? [value] : [];
  return { ...data, cc: addresses(mail.cc), bcc: addresses(mail.bcc), reply_to: addresses(mail.reply_to), text: typeof mail.text === "string" ? mail.text : null, html: typeof mail.html === "string" ? mail.html : null };
}
