export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const jwksCache = new Map();
const decoder = new TextDecoder();

function decodePart(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("Invalid JWT encoding");
  const binary = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function loadKeys(domain, fetcher, cache, now, refresh = false) {
  const existing = cache.get(domain);
  if (!refresh && existing?.expires > now) return existing.keys;
  let response;
  try {
    response = await fetcher(`https://${domain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(5000),
      // Workers accepts follow/manual; reject redirects via response.ok below.
      redirect: "manual",
    });
    if (!response.ok) throw new Error("JWKS unavailable");
    const data = await response.json();
    if (!Array.isArray(data.keys) || !data.keys.length) throw new Error("Invalid JWKS");
    cache.set(domain, { keys: data.keys, expires: now + 300 });
    return data.keys;
  } catch {
    throw new HttpError(503, "暂时无法验证登录，请稍后重试。");
  }
}

export async function verifyAccess(request, env, options = {}) {
  const domain = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  const allowed = (env.ALLOWED_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(domain || "") || !audience || !allowed.length) {
    throw new HttpError(503, "登录服务尚未配置。");
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || token.length > 16384) throw new HttpError(401, "请先通过 Cloudflare Access 登录。");
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const fetcher = options.fetcher ?? fetch;
  const cache = options.cache ?? jwksCache;

  let header, payload, signature, signingInput;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT");
    header = JSON.parse(decoder.decode(decodePart(parts[0])));
    payload = JSON.parse(decoder.decode(decodePart(parts[1])));
    signature = decodePart(parts[2]);
    signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.crit) throw new Error("Invalid JWT header");
    if (payload.iss !== `https://${domain}`) throw new Error("Wrong issuer");
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(audience)) throw new Error("Wrong audience");
    if (!Number.isFinite(payload.exp) || payload.exp <= now) throw new Error("Expired JWT");
    if (payload.nbf !== undefined && (!Number.isFinite(payload.nbf) || payload.nbf > now + 30)) throw new Error("JWT not valid yet");
    if (payload.iat !== undefined && (!Number.isFinite(payload.iat) || payload.iat > now + 30)) throw new Error("JWT issued in the future");
  } catch {
    throw new HttpError(401, "登录凭证无效或已过期，请重新登录。");
  }

  let keys = await loadKeys(domain, fetcher, cache, now);
  let jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
  if (!jwk) {
    keys = await loadKeys(domain, fetcher, cache, now, true);
    jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
  }
  if (!jwk) throw new HttpError(401, "登录凭证无效，请重新登录。");

  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signingInput)) throw new Error("Wrong signature");
  } catch {
    throw new HttpError(401, "登录凭证无效，请重新登录。");
  }

  if (typeof payload.email !== "string" || !allowed.includes(payload.email.toLowerCase())) {
    throw new HttpError(403, "这个邮箱没有访问权限。");
  }
  return { email: payload.email.toLowerCase(), ...(options.includeExpiration ? { expires: payload.exp } : {}) };
}
