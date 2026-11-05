import { verifyAccess } from "../../src/access.js";
import { handleRequest } from "../../src/worker.js";
import { beijingDay } from "../../src/session.js";
import { readAttachmentToken } from "../../src/attachments.js";
import devWorker from "../../src/dev-worker.js";

function assert(condition, message) { if (!condition) throw new Error(message); }
function encode(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function part(data) { return encode(new TextEncoder().encode(JSON.stringify(data))); }
const origin = "https://mail.wzy.one";

async function fixture(upstream, domain, email, changes = {}) {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "runtime-key", alg: "RS256", use: "sig" };
  const now = Math.floor(Date.now() / 1000);
  const input = `${part({ alg: "RS256", kid: jwk.kid })}.${part({ iss: `https://${domain}`, aud: ["runtime-audience"], email, exp: now + 3600, iat: now - 10 })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
  const jwt = `${input}.${encode(new Uint8Array(signature))}`;
  const from = `walker <${email}>`;
  await upstream.fetch("https://fixture.test/configure", { method: "POST", body: JSON.stringify({ domain, keys: [jwk], from, ...changes }) });
  return {
    jwt, from,
    env: { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: "runtime-audience", ALLOWED_EMAILS: "admin@wzy.one,hi@wzy.one", MAIL_FROM_NAME: "walker", RESEND_API_KEY: "runtime-test-secret", RESEND_READ_API_KEY: `runtime-outbox:${domain}`, ASSETS: { fetch: async () => new Response("mailroom") }, SEND_RATE_LIMITER: { limit: async () => ({ success: true }) }, OUTBOX_RATE_LIMITER: { limit: async () => ({ success: true }) } },
  };
}

function request(jwt, path = "/api/session", send = false) {
  return new Request(`${origin}${path}`, {
    method: send ? "POST" : "GET",
    headers: { "Cf-Access-Jwt-Assertion": jwt, ...(send ? { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": "f12e0ef2-c8b3-4ba5-9cd7-13e096efa42f" } : {}) },
    ...(send ? { body: JSON.stringify({ to: "recipient@example.com", subject: "Runtime test", body: "Local test only", format: "text" }) } : {}),
  });
}

export const loginAndSend = {
  async test(ctrl, bindings, ctx) {
    const { jwt, env, from } = await fixture(bindings.UPSTREAM, "runtime-login.cloudflareaccess.com", "admin@wzy.one");
    const session = await handleRequest(request(jwt), env, ctx);
    assert(session.status === 200, `Session should succeed in Workers: HTTP ${session.status}`);
    assert((await session.json()).from === from, "Session must use the verified sender");
    const page = await handleRequest(request(jwt, "/"), env, ctx);
    assert(page.status === 200 && await page.text() === "mailroom", "Authenticated page must load");
    const sent = await handleRequest(request(jwt, "/api/send", true), env, ctx);
    assert(sent.status === 200, `Mail should reach the local Resend stub: HTTP ${sent.status}`);
    assert((await sent.json()).id === "runtime-message-id", "Must return the upstream mail id");
  },
};

async function assertOutbox(headers, env, ctx, expectedFrom) {
  const response = await handleRequest(new Request(`${origin}/api/outbox`, { headers }), env, ctx);
  assert(response.status === 200, `Outbox must load in Workers: HTTP ${response.status}`);
  const page = await response.json();
  assert(page.data.length === 1 && page.data[0].from === expectedFrom, "Outbox list must contain only the current sender");
  assert(!("text" in page.data[0]), "List must omit bodies");
  const next = await handleRequest(new Request(`${origin}/api/outbox?cursor=${page.next_cursor}`, { headers }), env, ctx);
  assert(next.status === 200 && (await next.json()).has_more === false, "Encrypted pagination must work in Workers");
  const detail = await handleRequest(new Request(`${origin}/api/outbox/${page.data[0].id}`, { headers }), env, ctx);
  assert(detail.status === 200 && (await detail.json()).text === "Runtime outbox content", "Own message detail must load");
  const denied = await handleRequest(new Request(`${origin}/api/outbox/bcd23456-c8b3-4ba5-9cd7-13e096efa42f`, { headers }), env, ctx);
  assert(denied.status === 404, "Another sender's message must stay private");
}

export const accessOutbox = {
  async test(ctrl, bindings, ctx) {
    const { jwt, env, from } = await fixture(bindings.UPSTREAM, "runtime-outbox.cloudflareaccess.com", "hi@wzy.one");
    await assertOutbox({ "Cf-Access-Jwt-Assertion": jwt }, env, ctx, from);
  },
};

export const rejectOutboxRedirect = {
  async test(ctrl, bindings, ctx) {
    const domain = "runtime-outbox-redirect.cloudflareaccess.com";
    const { jwt, env } = await fixture(bindings.UPSTREAM, domain, "hi@wzy.one", { outboxRedirect: true });
    const response = await handleRequest(request(jwt, "/api/outbox"), env, ctx);
    assert(response.status === 502, "Outbox read must reject a redirect");
    const stats = await (await bindings.UPSTREAM.fetch(`https://fixture.test/stats?domain=${domain}`)).json();
    assert(stats.redirectVisits === 0, "Reading credentials must not follow a redirect");
  },
};

export const rejectKeyRedirect = {
  async test(ctrl, bindings) {
    const domain = "runtime-keys.cloudflareaccess.com";
    const { jwt, env } = await fixture(bindings.UPSTREAM, domain, "admin@wzy.one", { certRedirect: true });
    let error;
    try { await verifyAccess(request(jwt), env, { cache: new Map() }); } catch (failure) { error = failure; }
    assert(error?.status === 503, "Redirected public keys must fail closed");
    const stats = await (await bindings.UPSTREAM.fetch(`https://fixture.test/stats?domain=${domain}`)).json();
    assert(stats.certRequests === 1 && stats.redirectVisits === 0, "Public-key fetch must reach Access without following redirects");
  },
};

export const rejectMailRedirect = {
  async test(ctrl, bindings, ctx) {
    const domain = "runtime-mail.cloudflareaccess.com";
    const { jwt, env } = await fixture(bindings.UPSTREAM, domain, "hi@wzy.one", { sendRedirect: true });
    const response = await handleRequest(request(jwt, "/api/send", true), env, ctx);
    assert(response.status === 502, `Redirected mail must be rejected: HTTP ${response.status}`);
    const stats = await (await bindings.UPSTREAM.fetch(`https://fixture.test/stats?domain=${domain}`)).json();
    assert(stats.redirectVisits === 0, "Resend credentials and mail must not follow a redirect");
  },
};

function dualEnv(env) {
  return { ...env, LOGIN_MODE: "dual", LOGIN_PASSWORD: "runtime-password-prefix", SESSION_SECRET: "runtime-session-signing-secret-with-32-characters", LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) } };
}

export const passwordLoginAndSend = {
  async test(ctrl, bindings, ctx) {
    const configured = await fixture(bindings.UPSTREAM, "runtime-password.cloudflareaccess.com", "hi@wzy.one");
    const env = dualEnv(configured.env);
    const login = await handleRequest(new Request(`${origin}/api/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "hi@wzy.one", password: env.LOGIN_PASSWORD + beijingDay().suffix }) }), env, ctx);
    assert(login.status === 200, `Password login must succeed in Workers: HTTP ${login.status}`);
    const cookie = login.headers.get("Set-Cookie").split(";")[0];
    const session = await handleRequest(new Request(`${origin}/api/session`, { headers: { Cookie: cookie } }), env, ctx);
    assert(session.status === 200 && (await session.json()).loginMethod === "password", "Password session must authenticate without an Access JWT");
    const post = request(configured.jwt, "/api/send", true);
    post.headers.delete("Cf-Access-Jwt-Assertion");
    post.headers.set("Cookie", cookie);
    const sent = await handleRequest(post, env, ctx);
    assert(sent.status === 200, `Password session must send in Workers: HTTP ${sent.status}`);
    await assertOutbox({ Cookie: cookie }, env, ctx, configured.from);
    const stats = await (await bindings.UPSTREAM.fetch("https://fixture.test/stats?domain=runtime-password.cloudflareaccess.com")).json();
    assert(stats.certRequests === 0, "Password authentication must not fetch Access public keys");
  },
};

export const accessBridgeAndCookie = {
  async test(ctrl, bindings, ctx) {
    const { jwt, env: configured } = await fixture(bindings.UPSTREAM, "runtime-bridge.cloudflareaccess.com", "admin@wzy.one");
    const env = dualEnv(configured);
    const login = await handleRequest(request(jwt, "/auth/access"), env, ctx);
    assert(login.status === 303 && login.headers.get("Location") === "/", "Verified Access login must exchange its JWT for a local session");
    const cookie = login.headers.get("Set-Cookie").split(";")[0];
    const session = await handleRequest(new Request(`${origin}/api/session`, { headers: { Cookie: cookie } }), env, ctx);
    assert(session.status === 200 && (await session.json()).loginMethod === "access", "Access session must work outside the Access-protected bridge");
    await assertOutbox({ Cookie: cookie }, env, ctx, "walker <admin@wzy.one>");
    const forged = new Request(`${origin}/auth/access`, { headers: { "Cf-Access-Authenticated-User-Email": "admin@wzy.one" } });
    assert((await handleRequest(forged, env, ctx)).status === 401, "The bridge must require a signed JWT, not an email header");
  },
};

export const attachmentsWithBothLogins = {
  async test(ctrl, bindings, ctx) {
    const { jwt, env: configured } = await fixture(bindings.UPSTREAM, "runtime-attachments.cloudflareaccess.com", "admin@wzy.one");
    const objects = new Map();
    const env = { ...dualEnv(configured), R2_ACCOUNT_ID: "a".repeat(32), R2_BUCKET_NAME: "mailroom-runtime", R2_ACCESS_KEY_ID: "runtime-r2-key", R2_SECRET_ACCESS_KEY: "runtime-r2-secret-at-least-32-characters", ATTACHMENTS_BUCKET: { head: async (key) => objects.get(key) || null }, UPLOAD_RATE_LIMITER: { limit: async () => ({ success: true }) } };
    const access = await handleRequest(request(jwt, "/auth/access"), env, ctx);
    const password = await handleRequest(new Request(`${origin}/api/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@wzy.one", password: env.LOGIN_PASSWORD + beijingDay().suffix }) }), env, ctx);
    for (const login of [access, password]) {
      const cookie = login.headers.get("Set-Cookie").split(";")[0];
      const post = (path, body) => new Request(`${origin}${path}`, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(body) });
      const upload = await handleRequest(post("/api/attachments/uploads", { files: [{ filename: "文档.pdf", size: 12 }] }), env, ctx);
      assert(upload.status === 200, `Both login methods must issue upload grants: ${upload.status}`);
      const [file] = (await upload.json()).files;
      const data = await readAttachmentToken(file.token, "admin@wzy.one", origin, env, Math.floor(Date.now() / 1000));
      objects.set(data.key, { size: 12 });
      const refs = [{ token: file.token }];
      for (const mode of ["attachment", "link"]) {
        let payload;
        const sent = await handleRequest(post("/api/send", { to: "friend@example.com", subject: "文件", body: "查收", format: "text", attachments: refs, attachmentMode: mode }), env, ctx, { sendMail: async (mail) => { payload = mail; return { id: "runtime-attachment-mail" }; } });
        assert(sent.status === 200, `Workers must prepare ${mode} delivery: ${sent.status}`);
        if (mode === "attachment") assert(payload.attachments[0].filename === "文档.pdf" && payload.attachments[0].path.includes("X-Amz-Signature="), "Resend gets a signed URL attachment");
        else assert(!payload.attachments && payload.text.includes("有效期至") && payload.text.includes("X-Amz-Expires=604800"), "Link delivery appends an expiring download link");
      }
    }
  },
};

export const binaryAttachmentPreview = {
  async test(ctrl, bindings, ctx) {
    const site = "http://127.0.0.1:8787";
    const env = { SEND_RATE_LIMITER: { limit: async () => ({ success: true }) } };
    const post = (path, body) => new Request(`${site}${path}`, { method: "POST", headers: { Origin: site, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(body) });
    const grants = await devWorker.fetch(post("/api/attachments/uploads", { files: [{ filename: "binary.pdf", size: 4 }] }), env, ctx);
    assert(grants.status === 200, "Local preview must issue upload grants");
    const [file] = (await grants.json()).files;
    const put = () => new Request(file.upload.url, { method: "PUT", headers: { Origin: site, ...file.upload.headers }, body: new Uint8Array([0, 255, 10, 128]) });
    assert((await devWorker.fetch(put(), env, ctx)).status === 200, "Actual binary stream must upload");
    assert((await devWorker.fetch(put(), env, ctx)).status === 412, "Uploaded objects must be immutable");
    const sent = await devWorker.fetch(post("/api/send", { to: "friend@example.com", subject: "附件", body: "查收", format: "text", attachments: [{ token: file.token }] }), env, ctx);
    assert(sent.status === 200 && (await sent.json()).preview, "Preview must simulate attachment delivery with no external calls");
  },
};
