import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { ATTACHMENT_LIMITS, attachmentConfigured, createUploads, readAttachmentToken, prepareMailAttachments, checkUploads } from "../src/attachments.js";
import { presignR2 } from "../src/r2-signing.js";
import { handleRequest } from "../src/worker.js";
import devWorker from "../src/dev-worker.js";

const now = 1793750400;
const origin = "https://mail.wzy.one";
const email = "hi@wzy.one";
const mail = { from: `walker <${email}>`, to: ["friend@example.com"], subject: "文件", text: "请查收。" };
const requestKey = "f12e0ef2-c8b3-4ba5-9cd7-13e096efa42f";
const success = { limit: async () => ({ success: true }) };
function fixture() {
  const objects = new Map();
  const env = { R2_ACCOUNT_ID: "a".repeat(32), R2_BUCKET_NAME: "mailroom-test", R2_ACCESS_KEY_ID: "test-access-key", R2_SECRET_ACCESS_KEY: "b".repeat(64), ATTACHMENTS_BUCKET: { head: async (key) => objects.get(key) || null }, RESEND_API_KEY: "test-resend-secret", UPLOAD_RATE_LIMITER: success, SEND_RATE_LIMITER: success };
  return { env, objects };
}
const post = (path, body, headers = {}, site = origin) => new Request(`${site}${path}`, { method: "POST", headers: { Origin: site, "Content-Type": "application/json", "Idempotency-Key": requestKey, ...headers }, body: JSON.stringify(body) });
const options = { now, authenticate: async () => ({ email }) };
async function grant(env, mode = "attachment", files = [{ filename: "手机照片.jpg", size: 8 * 1024 * 1024 }]) {
  return (await createUploads(files, mode, email, origin, env, now)).files;
}
async function uploaded(env, objects, files) {
  for (const file of files) { const data = await readAttachmentToken(file.token, email, origin, env, now); objects.set(data.key, { size: data.size }); }
  return files.map(({ token }) => ({ token }));
}

test("SigV4 PUT matches an independently specified canonical request with encoded paths and bound upload headers", async () => {
  const { env } = fixture();
  const url = new URL(await presignR2(env, { method: "PUT", key: "files/文档 !'().pdf", createdAt: now, expires: 900, headers: { "Content-Length": 12, "Content-Type": "application/octet-stream", "If-None-Match": "*" } }));
  const date = "20261104T000000Z";
  assert.equal(url.searchParams.get("X-Amz-Date"), date);
  const headers = "content-length;content-type;host;if-none-match";
  const query = `X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=test-access-key%2F20261104%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=${date}&X-Amz-Expires=900&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bif-none-match`;
  const canonical = `PUT\n/mailroom-test/files/%E6%96%87%E6%A1%A3%20%21%27%28%29.pdf\n${query}\ncontent-length:12\ncontent-type:application/octet-stream\nhost:${"a".repeat(32)}.r2.cloudflarestorage.com\nif-none-match:*\n\n${headers}\nUNSIGNED-PAYLOAD`;
  const mac = (key, value) => createHmac("sha256", key).update(value).digest();
  const signingKey = mac(mac(mac(mac(`AWS4${env.R2_SECRET_ACCESS_KEY}`, "20261104"), "auto"), "s3"), "aws4_request");
  const expected = mac(signingKey, `AWS4-HMAC-SHA256\n${date}\n20261104/auto/s3/aws4_request\n${createHash("sha256").update(canonical).digest("hex")}`).toString("hex");
  assert.equal(url.searchParams.get("X-Amz-Signature"), expected);
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), headers);
});

test("grants support camera-size files without Base64, sign immutable PUTs and hide the signing secret", async () => {
  const { env } = fixture();
  const [file] = await grant(env);
  assert.equal(file.size, 8 * 1024 * 1024);
  assert.equal(file.upload.headers["If-None-Match"], "*");
  assert.equal(file.upload.headers["Content-Length"], undefined, "Browsers must set their own Content-Length");
  assert.match(new URL(file.upload.url).searchParams.get("X-Amz-SignedHeaders"), /content-length/);
  assert.equal(new URL(file.upload.url).searchParams.get("X-Amz-Expires"), "900");
  assert.match(new URL(file.upload.url).pathname, /^\/mailroom-test\/attachment\/[a-f0-9]{32}\/[a-f0-9-]{36}$/);
  const data = await readAttachmentToken(file.token, email, origin, env, now);
  assert.equal(new URL(file.upload.url).pathname, `/mailroom-test/${data.key}`);
  assert.ok(!JSON.stringify(file).includes(env.R2_SECRET_ACCESS_KEY));
  assert.ok(!("content" in file));
  assert.equal(Date.parse(file.downloadExpiresAt) - now * 1000, 7 * 86400 * 1000);
  assert.equal(Date.parse(file.referenceExpiresAt) - now * 1000, 86400 * 1000);
});

test("traditional attachment and link limits count raw bytes across files", async () => {
  const { env } = fixture();
  await grant(env, "attachment", [{ filename: "report.pdf", size: ATTACHMENT_LIMITS.maxTotalBytes }]);
  await grant(env, "link", [{ filename: "video.mov", size: ATTACHMENT_LIMITS.linkMaxTotalBytes }]);
  for (const [files, mode, status] of [
    [[{ filename: "report.pdf", size: ATTACHMENT_LIMITS.maxTotalBytes + 1 }], "attachment", 413],
    [[{ filename: "a.pdf", size: 13 * 1024 * 1024 }, { filename: "b.pdf", size: 13 * 1024 * 1024 }], "attachment", 413],
    [[{ filename: "a.mov", size: ATTACHMENT_LIMITS.linkMaxTotalBytes + 1 }], "link", 413],
    [[{ filename: "a.txt", size: 0 }], "attachment", 400],
    [[{ filename: "a.txt", size: 1.5 }], "attachment", 400],
    [[{ filename: "../a.txt", size: 1 }], "attachment", 400],
    [[{ filename: "a\r\n.txt", size: 1 }], "attachment", 400],
    [[{ filename: "文".repeat(86), size: 1 }], "attachment", 400],
    [Array.from({ length: 11 }, () => ({ filename: "a.txt", size: 1 })), "link", 400],
    [[], "attachment", 400],
  ]) await assert.rejects(grant(env, mode, files), { status });
});

test("attachment references reject tampering, other users/sites/buckets/accounts and expiry before R2 reads", async () => {
  const { env } = fixture();
  const [file] = await grant(env);
  const [payload, signature] = file.token.split(".");
  const tampered = `${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const alias = `${payload}.${signature.slice(0, -1)}${alphabet[alphabet.indexOf(signature.at(-1)) + 1]}`;
  for (const args of [
    [tampered, email, origin, env, now],
    [alias, email, origin, env, now],
    [file.token, "admin@wzy.one", origin, env, now],
    [file.token, email, "https://other.example", env, now],
    [file.token, email, origin, { ...env, R2_BUCKET_NAME: "other-bucket" }, now],
    [file.token, email, origin, { ...env, R2_ACCOUNT_ID: "c".repeat(32) }, now],
    [file.token, email, origin, env, now + 86400],
    [file.token, email, origin, env, now - 31],
  ]) await assert.rejects(readAttachmentToken(...args), { status: 400 });
});

test("R2 completion detects lost uploads, validates actual size, and send never accepts raw content or URLs", async () => {
  const { env, objects } = fixture();
  const files = await grant(env);
  const refs = files.map(({ token }) => ({ token }));
  assert.deepEqual(await checkUploads(refs, "attachment", email, origin, env, now), { files: [{ uploaded: false }] });
  await assert.rejects(prepareMailAttachments(mail, refs, "attachment", email, origin, env, now), { status: 400 });
  await uploaded(env, objects, files);
  assert.deepEqual(await checkUploads(refs, "attachment", email, origin, env, now), { files: [{ uploaded: true }] });
  for (const value of [null, {}, [{ filename: "file.pdf", path: "https://attacker.example/file" }], [{ token: files[0].token, content: "aGVsbG8=" }], [refs[0], refs[0]]]) {
    await assert.rejects(prepareMailAttachments(mail, value, "attachment", email, origin, env, now), { status: 400 });
  }
  objects.values().next().value.size++;
  await assert.rejects(checkUploads(refs, "attachment", email, origin, env, now), { status: 400 });
  env.ATTACHMENTS_BUCKET.head = async () => { throw new Error(env.R2_SECRET_ACCESS_KEY); };
  await assert.rejects(checkUploads(refs, "attachment", email, origin, env, now), (error) => { assert.equal(error.status, 503); assert.ok(!error.message.includes(env.R2_SECRET_ACCESS_KEY)); return true; });
});

test("provider attachment URLs and download mail stay identical for retries; link filenames are escaped", async () => {
  const { env, objects } = fixture();
  const files = await grant(env, "link", [{ filename: '<img src=x onerror="alert(1)">.pdf', size: 30 * 1024 * 1024 }]);
  const refs = await uploaded(env, objects, files);
  await assert.rejects(prepareMailAttachments(mail, refs, "attachment", email, origin, env, now), { status: 413 });
  const htmlMail = { ...mail, text: undefined, html: "<p>请下载</p>" };
  const first = await prepareMailAttachments(htmlMail, refs, "link", email, origin, env, now);
  assert.deepEqual(first, await prepareMailAttachments(htmlMail, refs, "link", email, origin, env, now + 3600));
  assert.ok(!first.html.includes("<img"));
  assert.match(first.html, /&lt;img/);
  assert.equal(first.attachments, undefined);
  const text = await prepareMailAttachments(mail, refs, "link", email, origin, env, now);
  assert.match(text.text, /有效期至/);
  assert.match(text.text, /X-Amz-Expires=604800/);
  const small = await grant(env);
  const smallRefs = await uploaded(env, objects, small);
  const traditional = await prepareMailAttachments(mail, smallRefs, "attachment", email, origin, env, now);
  assert.deepEqual(traditional, await prepareMailAttachments(mail, smallRefs, "attachment", email, origin, env, now + 3600));
  assert.deepEqual(Object.keys(traditional.attachments[0]), ["filename", "path"]);
  assert.match(new URL(traditional.attachments[0].path).pathname, /^\/mailroom-test\/attachment\//);
  assert.equal(traditional.text, mail.text);
});

test("upload and completion endpoints require authentication, same origin, configuration and rate limits", async () => {
  const { env } = fixture();
  const body = { files: [{ filename: "a.pdf", size: 10 }] };
  for (const path of ["/api/attachments/uploads", "/api/attachments/complete"]) {
    assert.notEqual((await handleRequest(post(path, body), env)).status, 200);
    assert.equal((await handleRequest(post(path, body, { Origin: "https://evil.example" }), env, {}, options)).status, 403);
    assert.equal((await handleRequest(post(path, body, { "Sec-Fetch-Site": "cross-site" }), env, {}, options)).status, 403);
    assert.equal((await handleRequest(new Request(`${origin}${path}`), env, {}, options)).status, 405);
    assert.equal((await handleRequest(post(path, body), { ...env, R2_SECRET_ACCESS_KEY: undefined }, {}, options)).status, 503);
    const blocked = { ...env, UPLOAD_RATE_LIMITER: { limit: async () => ({ success: false }) }, ATTACHMENTS_BUCKET: { head: () => assert.fail("Rate limit must precede R2 reads") } };
    assert.equal((await handleRequest(post(path, body), blocked, {}, options)).status, 429);
  }
  assert.equal(attachmentConfigured(env), true);
  const session = await handleRequest(new Request(`${origin}/api/session`), env, {}, options);
  const details = await session.text();
  assert.match(details, /"attachmentReady":true/);
  assert.ok(!details.includes(env.R2_ACCESS_KEY_ID) && !details.includes(env.R2_SECRET_ACCESS_KEY));
  assert.match(session.headers.get("Content-Security-Policy"), /connect-src 'self' https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com/);
});

test("send passes only signed R2 URL attachments to Resend and rate limit runs before R2 HEAD", async (t) => {
  const { env, objects } = fixture();
  const files = await grant(env);
  const refs = await uploaded(env, objects, files);
  const body = { to: mail.to, subject: mail.subject, body: mail.text, format: "text", attachments: refs };
  const upstream = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { upstream.push({ url, init }); return Response.json({ id: "mail-id" }); });
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await handleRequest(post("/api/send", body), env, {}, { ...options, now: now + attempt * 60 })).status, 200);
  assert.equal(upstream[0].url, "https://api.resend.com/emails");
  assert.equal(upstream[0].init.body, upstream[1].init.body);
  assert.equal(upstream[0].init.headers["Idempotency-Key"], upstream[1].init.headers["Idempotency-Key"]);
  const payload = JSON.parse(upstream[0].init.body);
  assert.equal(payload.attachments[0].filename, "手机照片.jpg");
  assert.match(payload.attachments[0].path, /^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\//);
  assert.ok(!upstream[0].init.body.includes(env.R2_SECRET_ACCESS_KEY));
  const blocked = { ...env, SEND_RATE_LIMITER: { limit: async () => ({ success: false }) }, ATTACHMENTS_BUCKET: { head: () => assert.fail("Do not read R2 when blocked") } };
  assert.equal((await handleRequest(post("/api/send", body), blocked, {}, options)).status, 429);
  assert.equal(upstream.length, 2);
});

test("local preview uploads raw binary, rejects overwrites and simulates both delivery modes without external APIs", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("Preview must never use external APIs"));
  const site = "http://127.0.0.1:8787";
  const { env } = fixture();
  const response = await devWorker.fetch(post("/api/attachments/uploads", { files: [{ filename: "报告.pdf", size: 6 }], mode: "attachment" }, {}, site), env);
  assert.equal(response.status, 200);
  const [file] = (await response.json()).files;
  const put = () => new Request(file.upload.url, { method: "PUT", headers: { Origin: site, ...file.upload.headers }, body: Uint8Array.of(0, 255, 13, 128, 23, 0) });
  assert.equal((await devWorker.fetch(put(), env)).status, 200);
  assert.equal((await devWorker.fetch(put(), env)).status, 412);
  const refs = [{ token: file.token }];
  const completed = await devWorker.fetch(post("/api/attachments/complete", { attachments: refs }, {}, site), env);
  assert.deepEqual(await completed.json(), { files: [{ uploaded: true }] });
  for (const attachmentMode of ["attachment", "link"]) {
    const sent = await devWorker.fetch(post("/api/send", { to: mail.to, subject: mail.subject, body: mail.text, format: "text", attachments: refs, attachmentMode }, {}, site), env);
    assert.equal(sent.status, 200);
    assert.equal((await sent.json()).preview, true);
  }
  assert.equal((await handleRequest(post("/api/attachments/preview/test", {}), env, {}, options)).status, 404);
});
