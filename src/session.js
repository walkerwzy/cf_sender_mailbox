import { HttpError, verifyAccess } from "./access.js";

export const SESSION_COOKIE = "__Host-mailroom_session";
export const ACCESS_LOGIN_PATH = "/auth/access";
const DAY_SECONDS = 86400;
const BEIJING_OFFSET = 8 * 3600;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function allowedEmails(env) {
  return [...new Set((env.ALLOWED_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

export function dualLogin(env) { return env.LOGIN_MODE === "dual"; }

export function beijingDay(now = Math.floor(Date.now() / 1000)) {
  const date = new Date((now + BEIJING_OFFSET) * 1000).toISOString().slice(0, 10);
  return { date, suffix: date.slice(5, 7) + date.slice(8, 10), expires: (Math.floor((now + BEIJING_OFFSET) / DAY_SECONDS) + 1) * DAY_SECONDS - BEIJING_OFFSET };
}

export function requireSessionConfig(env) {
  if (!dualLogin(env) || typeof env.LOGIN_PASSWORD !== "string" || !env.LOGIN_PASSWORD || typeof env.SESSION_SECRET !== "string" || env.SESSION_SECRET.length < 32 || !allowedEmails(env).length) {
    throw new HttpError(503, "登录服务尚未配置。");
  }
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid session encoding");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
}

async function sessionKey(env, method) {
  const material = `${env.SESSION_SECRET}\0mailroom:${method}${method === "password" ? `\0${env.LOGIN_PASSWORD}` : ""}`;
  return crypto.subtle.importKey("raw", encoder.encode(material), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function passwordMatches(value, env, now = Math.floor(Date.now() / 1000)) {
  requireSessionConfig(env);
  if (typeof value !== "string" || value.length > 512) return false;
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(value)),
    crypto.subtle.digest("SHA-256", encoder.encode(env.LOGIN_PASSWORD + beijingDay(now).suffix)),
  ]);
  const left = new Uint8Array(actual);
  const right = new Uint8Array(expected);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function issueSession(email, method, origin, env, now = Math.floor(Date.now() / 1000), identityExpiry = now + DAY_SECONDS) {
  requireSessionConfig(env);
  if (!["access", "password"].includes(method) || !allowedEmails(env).includes(email)) throw new HttpError(403, "这个邮箱没有访问权限。");
  const day = beijingDay(now);
  const expires = method === "password" ? day.expires : Math.min(now + DAY_SECONDS, identityExpiry);
  if (!Number.isSafeInteger(expires) || expires <= now) throw new HttpError(401, "登录凭证已过期，请重新登录。");
  const payload = encode(encoder.encode(JSON.stringify({ version: 1, email, method, origin, iat: now, exp: expires, ...(method === "password" ? { day: day.date } : {}) })));
  const signature = await crypto.subtle.sign("HMAC", await sessionKey(env, method), encoder.encode(payload));
  const token = `${payload}.${encode(new Uint8Array(signature))}`;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${expires - now}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export async function verifySession(request, env, options = {}) {
  requireSessionConfig(env);
  const entries = (request.headers.get("Cookie") || "").split(";").map((entry) => entry.trim()).filter((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
  if (!entries.length) throw new HttpError(401, "请先登录。");
  const token = entries[0].slice(SESSION_COOKIE.length + 1);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  try {
    if (entries.length !== 1 || token.length > 4096) throw new Error("Invalid cookie");
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) throw new Error("Invalid session");
    const data = JSON.parse(decoder.decode(decode(payload)));
    if (data.version !== 1 || !["password", "access"].includes(data.method)) throw new Error("Invalid session type");
    const valid = await crypto.subtle.verify("HMAC", await sessionKey(env, data.method), decode(signature), encoder.encode(payload));
    if (!valid || data.origin !== new URL(request.url).origin || !allowedEmails(env).includes(data.email)) throw new Error("Invalid session identity");
    if (!Number.isSafeInteger(data.iat) || !Number.isSafeInteger(data.exp) || data.iat > now + 30 || data.exp <= now || data.exp <= data.iat || data.exp - data.iat > DAY_SECONDS) throw new Error("Expired session");
    if (data.method === "password" && (data.day !== beijingDay(now).date || data.exp !== beijingDay(data.iat).expires)) throw new Error("Expired password day");
    return { email: data.email, method: data.method };
  } catch {
    throw new HttpError(401, "登录已过期，请重新登录。");
  }
}

export async function verifyIdentity(request, env, options = {}) {
  if (!dualLogin(env)) return verifyAccess(request, env, options);
  requireSessionConfig(env);
  // During the Access scope migration, already-authenticated requests still work.
  if (request.headers.has("Cf-Access-Jwt-Assertion")) return { ...await verifyAccess(request, env, options), method: "access" };
  return verifySession(request, env, options);
}
