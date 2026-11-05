import { HttpError, verifyAccess } from "./access.js";
import { ACCESS_LOGIN_PATH, allowedEmails, beijingDay, clearSessionCookie, dualLogin, issueSession, passwordMatches, requireSessionConfig, verifyIdentity } from "./session.js";
import { listOutbox, getOutboxMail } from "./outbox.js";
import { ATTACHMENT_LIMITS, attachmentConfigured, createUploads, checkUploads, prepareMailAttachments } from "./attachments.js";

const MAX_BODY_BYTES = 128 * 1024;
const EMAIL = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, { status, headers: extraHeaders });
}

function secureResponse(response, env) {
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) result.headers.set(name, value);
  if (attachmentConfigured(env)) result.headers.set("Content-Security-Policy", SECURITY_HEADERS["Content-Security-Policy"].replace("connect-src 'self'", `connect-src 'self' https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`));
  return result;
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "请使用 JSON 提交邮件。");
  }
  if (Number(request.headers.get("content-length")) > maxBytes) throw new HttpError(413, "请求内容过长。");
  if (!request.body) throw new HttpError(400, "邮件内容不能为空。");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "请求内容过长。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "邮件内容不是有效的 JSON。");
  }
}

function recipients(value, label, required = false) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(400, `请填写${label}。`);
    return [];
  }
  const list = typeof value === "string" ? value.split(/[,;，；\n]+/) : value;
  if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) throw new HttpError(400, `${label}格式不正确。`);
  const normalized = [...new Set(list.map((item) => item.trim()).filter(Boolean))];
  if (required && !normalized.length) throw new HttpError(400, `请填写${label}。`);
  if (normalized.some((item) => item.length > 254 || !EMAIL.test(item) || /[\x00-\x1f\x7f]/.test(item))) {
    throw new HttpError(400, `${label}中有无效的邮箱地址。`);
  }
  return normalized;
}

export function validateMail(data, from) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "邮件内容格式不正确。");
  const sender = from?.match(/^(?:[^<>\r\n]+ <)?([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>?$/)?.[1];
  if (!sender || !EMAIL.test(sender) || /[\x00-\x1f\x7f]/.test(from)) throw new HttpError(503, "发件人尚未配置。");
  const to = recipients(data.to, "收件人", true);
  const cc = recipients(data.cc, "抄送");
  const bcc = recipients(data.bcc, "密送");
  if (to.length + cc.length + bcc.length > 20) throw new HttpError(400, "一封邮件最多填写 20 位收件人。");
  if (typeof data.subject !== "string" || !data.subject.trim() || data.subject.length > 200 || /[\x00-\x1f\x7f]/.test(data.subject)) {
    throw new HttpError(400, "主题不能为空，最多 200 个字符，且不能换行。");
  }
  if (!['text', 'html'].includes(data.format)) throw new HttpError(400, "请选择纯文本或 HTML 格式。");
  if (typeof data.body !== "string" || !data.body.trim() || data.body.length > 60000) throw new HttpError(400, "正文不能为空，最多 60,000 个字符。");
  const mail = { from, to, subject: data.subject.trim(), [data.format]: data.body };
  if (cc.length) mail.cc = cc;
  if (bcc.length) mail.bcc = bcc;
  if (data.replyTo) {
    const reply = recipients(data.replyTo, "回复地址");
    if (reply.length !== 1) throw new HttpError(400, "回复地址只能填写一个邮箱。");
    mail.reply_to = reply[0];
  }
  return mail;
}

async function sendMail(mail, key, env) {
  if (!env.RESEND_API_KEY) throw new HttpError(503, "发件服务尚未配置。");
  let response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(mail),
      signal: AbortSignal.timeout(mail.attachments?.length ? 45000 : 15000),
      // Keep credentials and mail on this origin; Workers has no "error" mode.
      redirect: "manual",
    });
  } catch {
    throw new HttpError(502, "发送结果暂时无法确认，请保持内容不变并重试。");
  }
  if (!response.ok) {
    if (response.status === 429) throw new HttpError(429, "发件服务繁忙，请稍后重试。");
    if (response.status === 409) throw new HttpError(409, "重试内容发生变化，请修改邮件后重新发送。");
    if (response.status === 401 || response.status === 403) throw new HttpError(502, "发件服务授权失败，请检查 API Key 和发件域名。");
    if (response.status === 413) throw new HttpError(413, "发件服务认为邮件过大，请减少正文或附件后重试。");
    if (response.status === 422 || response.status === 400) throw new HttpError(502, "发件服务未接受邮件，请检查发件域名、邮件内容或附件格式。");
    throw new HttpError(502, "发件服务暂时不可用，请稍后重试。");
  }
  let data;
  try { data = await response.json(); } catch { throw new HttpError(502, "发送结果暂时无法确认，请保持内容不变并重试。"); }
  if (typeof data.id !== "string" || !data.id) throw new HttpError(502, "发送结果暂时无法确认，请保持内容不变并重试。");
  return data;
}

export async function handleRequest(request, env, ctx, options = {}) {
  const url = new URL(request.url);
  const secure = (response) => secureResponse(response, env);
  try {
    const dual = dualLogin(env);
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const sameOrigin = () => {
      if (request.headers.get("Origin") !== url.origin || request.headers.get("Sec-Fetch-Site") === "cross-site") throw new HttpError(403, "请从当前页面提交操作。");
    };
    if (dual && ["/login", "/login.js", "/styles.css", "/favicon.svg"].includes(url.pathname)) {
      requireSessionConfig(env);
      if (!["GET", "HEAD"].includes(request.method)) throw new HttpError(405, "不支持此请求方法。");
      // Static Assets maps /login to login.html; fetching .html explicitly redirects.
      return secure(await env.ASSETS.fetch(request));
    }
    if (dual && url.pathname === "/api/login-options" && request.method === "GET") {
      requireSessionConfig(env);
      return secure(json({ emails: allowedEmails(env), dateSuffix: beijingDay(now).suffix, accessUrl: ACCESS_LOGIN_PATH }));
    }
    if (dual && url.pathname === "/api/login") {
      requireSessionConfig(env);
      if (request.method !== "POST") throw new HttpError(405, "请使用 POST 登录。");
      sameOrigin();
      if (!env.LOGIN_RATE_LIMITER) throw new HttpError(503, "登录服务尚未配置。");
      const { success } = await env.LOGIN_RATE_LIMITER.limit({ key: `password:${request.headers.get("CF-Connecting-IP") || "unknown"}` });
      if (!success) return secure(json({ error: "尝试过于频繁，请一分钟后重试。" }, 429, { "Retry-After": "60" }));
      const data = await readJson(request, 4096);
      const email = typeof data?.email === "string" ? data.email.trim().toLowerCase() : "";
      const matches = await passwordMatches(data?.password, env, now);
      if (!matches || !allowedEmails(env).includes(email)) throw new HttpError(401, "邮箱或密码不正确。");
      const cookie = await issueSession(email, "password", url.origin, env, now);
      return secure(json({ ok: true }, 200, { "Set-Cookie": cookie }));
    }
    if (dual && url.pathname === ACCESS_LOGIN_PATH) {
      requireSessionConfig(env);
      if (request.method !== "GET") throw new HttpError(405, "请使用 GET 登录。");
      const identity = await verifyAccess(request, env, { now, includeExpiration: true });
      const cookie = await issueSession(identity.email, "access", url.origin, env, now, identity.expires);
      return secure(new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": cookie } }));
    }
    if (url.pathname === "/api/logout") {
      if (request.method !== "POST") throw new HttpError(405, "请使用 POST 退出登录。");
      sameOrigin();
      let method = "access";
      if (dual) {
        try { method = (await verifyIdentity(request, env)).method; } catch { method = "password"; }
      }
      return secure(json({ redirect: method === "password" ? "/login" : "/cdn-cgi/access/logout" }, 200, { "Set-Cookie": clearSessionCookie() }));
    }
    const identity = await (options.authenticate ?? verifyIdentity)(request, env, { now });
    const name = env.MAIL_FROM_NAME || "walker";
    if (typeof name !== "string" || /[<>\x00-\x1f\x7f]/.test(name) || !EMAIL.test(identity.email)) {
      throw new HttpError(503, "发件人尚未配置。");
    }
    const from = `${name} <${identity.email}>`;
    if (url.pathname === "/api/session" && request.method === "GET") {
      return secure(json({ email: identity.email, from, preview: Boolean(options.preview), ready: Boolean(options.preview || env.RESEND_API_KEY), loginMethod: identity.method || (options.preview ? "preview" : "access"), attachmentLimits: ATTACHMENT_LIMITS, attachmentReady: Boolean(options.preview || attachmentConfigured(env)) }));
    }
    if (["/api/attachments/uploads", "/api/attachments/complete"].includes(url.pathname)) {
      if (request.method !== "POST") return secure(json({ error: "请使用 POST 创建附件上传。" }, 405, { Allow: "POST" }));
      sameOrigin();
      if (!options.preview && !attachmentConfigured(env)) throw new HttpError(503, "附件服务尚未配置，请联系管理员。");
      if (!env.UPLOAD_RATE_LIMITER) throw new HttpError(503, "附件上传服务尚未配置。");
      const { success } = await env.UPLOAD_RATE_LIMITER.limit({ key: identity.email });
      if (!success) return secure(json({ error: "创建上传过于频繁，请一分钟后重试。" }, 429, { "Retry-After": "60" }));
      const data = await readJson(request, url.pathname.endsWith("/uploads") ? 8192 : 32 * 1024);
      const result = url.pathname.endsWith("/uploads")
        ? await (options.createUploads ?? createUploads)(data?.files, data?.mode || "attachment", identity.email, url.origin, env, now)
        : await checkUploads(data?.attachments, data?.mode || "attachment", identity.email, url.origin, env, now);
      return secure(json(result));
    }
    if (url.pathname === "/api/outbox" || url.pathname.startsWith("/api/outbox/")) {
      if (request.method !== "GET") return secure(json({ error: "请使用 GET 读取发件箱。" }, 405, { Allow: "GET" }));
      if (!env.OUTBOX_RATE_LIMITER) throw new HttpError(503, "发件箱服务尚未配置。");
      const { success } = await env.OUTBOX_RATE_LIMITER.limit({ key: identity.email });
      if (!success) return secure(json({ error: "读取过于频繁，请一分钟后重试。" }, 429, { "Retry-After": "60" }));
      const data = url.pathname === "/api/outbox"
        ? await (options.listOutbox ?? listOutbox)(url, identity.email, env, now)
        : await (options.getOutboxMail ?? getOutboxMail)(url.pathname.slice("/api/outbox/".length), identity.email, env);
      return secure(json(data));
    }
    if (url.pathname === "/api/send") {
      if (request.method !== "POST") return secure(json({ error: "请使用 POST 发送邮件。" }, 405, { Allow: "POST" }));
      if (request.headers.get("Origin") !== url.origin || request.headers.get("Sec-Fetch-Site") === "cross-site") {
        throw new HttpError(403, "请从当前页面提交邮件。");
      }
      const idempotencyKey = request.headers.get("Idempotency-Key");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey || "")) {
        throw new HttpError(400, "缺少有效的发送请求编号，请刷新页面后重试。");
      }
      const data = await readJson(request);
      let mail = validateMail(data, from);
      if (!env.SEND_RATE_LIMITER) throw new HttpError(503, "发件服务暂时不可用。");
      const { success } = await env.SEND_RATE_LIMITER.limit({ key: identity.email });
      if (!success) return secure(json({ error: "发送过于频繁，每分钟最多 5 封，请稍后重试。" }, 429, { "Retry-After": "60" }));
      mail = await prepareMailAttachments(mail, data.attachments, data.attachmentMode || "attachment", identity.email, url.origin, env, now);
      // Scope the provider key to the signed-in user; two users cannot collide.
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${identity.email}:${idempotencyKey}`));
      const scopedKey = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const result = await (options.sendMail ?? sendMail)(mail, scopedKey, env);
      return secure(json({ id: result.id, preview: Boolean(options.preview) }));
    }
    if (url.pathname.startsWith("/api/")) return secure(json({ error: "接口不存在。" }, 404));
    if (!["GET", "HEAD"].includes(request.method)) return secure(json({ error: "不支持此请求方法。" }, 405, { Allow: "GET, HEAD" }));
    return secure(await env.ASSETS.fetch(request));
  } catch (error) {
    if (dualLogin(env) && error instanceof HttpError && error.status === 401 && ["GET", "HEAD"].includes(request.method) && !url.pathname.startsWith("/api/") && url.pathname !== ACCESS_LOGIN_PATH) {
      return secure(new Response(null, { status: 303, headers: { Location: "/login" } }));
    }
    if (error instanceof HttpError) return secure(json({ error: error.message }, error.status));
    // Do not log request bodies, addresses, JWTs, or provider credentials.
    console.error("Request failed:", error?.name || "Error");
    return secure(json({ error: "服务暂时不可用，请稍后重试。" }, 500));
  }
}

export default { fetch: handleRequest };
