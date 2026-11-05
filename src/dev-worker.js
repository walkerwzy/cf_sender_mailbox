import { handleRequest } from "./worker.js";
import { HttpError } from "./access.js";
import { createUploads, readAttachmentToken } from "./attachments.js";

const previewObjects = new Map();
const previewAttachmentEnv = {
  R2_ACCOUNT_ID: "a".repeat(32), R2_BUCKET_NAME: "mailroom-preview",
  R2_ACCESS_KEY_ID: "preview-access-key", R2_SECRET_ACCESS_KEY: "preview-only-signing-key-not-a-real-r2-secret",
  ATTACHMENTS_BUCKET: { head: async (key) => previewObjects.get(key) || null },
  UPLOAD_RATE_LIMITER: { limit: async () => ({ success: true }) },
};

async function previewUpload(request, env, url) {
  try {
    if (request.method !== "PUT") return new Response("PUT only", { status: 405 });
    if (request.headers.get("Origin") !== url.origin || request.headers.get("Sec-Fetch-Site") === "cross-site") return new Response("Same origin only", { status: 403 });
    const now = Math.floor(Date.now() / 1000);
    const file = await readAttachmentToken(decodeURIComponent(url.pathname.slice("/api/attachments/preview/".length)), "admin@wzy.one", url.origin, env, now);
    if (file.createdAt + 900 <= now) return new Response("Upload expired", { status: 403 });
    if (request.headers.get("If-None-Match") !== "*" || previewObjects.has(file.key)) return new Response("Cannot overwrite", { status: 412 });
    if (!request.body) return new Response("Missing bytes", { status: 400 });
    const reader = request.body.getReader();
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > file.size) { await reader.cancel(); return new Response("Wrong size", { status: 400 }); }
      }
    } finally { reader.releaseLock(); }
    if (size !== file.size) return new Response("Wrong size", { status: 400 });
    // Preview consumes the actual binary stream and retains only size metadata.
    for (const [key, object] of previewObjects) if (object.expires <= now) previewObjects.delete(key);
    if (previewObjects.size >= 500) return new Response("Preview storage full", { status: 503 });
    previewObjects.set(file.key, { size, expires: file.expires });
    return new Response(null, { status: 200 });
  } catch { return new Response("Invalid preview upload", { status: 400 }); }
}

const previewMails = [
  { id: "79d803ab-d6b1-4d6e-bd47-3a23b6e5e661", from: "walker <admin@wzy.one>", to: ["friend@example.com"], subject: "一封来自私人邮局的信", text: "你好，\n\n这是发件箱的本地示例。这里可以查看寄出的邮件和投递状态。", html: null, last_event: "delivered" },
  { id: "79d803ab-d6b1-4d6e-bd47-3a23b6e5e662", from: "walker <admin@wzy.one>", to: ["hello@example.com"], subject: "HTML 邮件示例", text: null, html: "<h1>你好，</h1>\n<p>这是模拟邮件，正文以 HTML 源码显示。</p>", last_event: "sent" },
].map((mail, index) => ({ ...mail, created_at: new Date(Date.now() - (index + 1) * 3600000).toISOString(), cc: [], bcc: [], reply_to: [] }));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      return new Response("Local preview only", { status: 403 });
    }
    const previewEnv = { ...env, ...previewAttachmentEnv, OUTBOX_RATE_LIMITER: { limit: async () => ({ success: true }) } };
    if (url.pathname.startsWith("/api/attachments/preview/")) return previewUpload(request, previewEnv, url);
    return handleRequest(request, previewEnv, ctx, {
      authenticate: async () => ({ email: "admin@wzy.one" }),
      preview: true,
      createUploads: async (...args) => {
        const result = await createUploads(...args);
        for (const file of result.files) file.upload.url = `${url.origin}/api/attachments/preview/${encodeURIComponent(file.token)}`;
        return result;
      },
      sendMail: async (mail) => {
        const id = crypto.randomUUID();
        previewMails.unshift({ ...mail, id, created_at: new Date().toISOString(), last_event: "sent", text: mail.text ?? null, html: mail.html ?? null, cc: mail.cc || [], bcc: mail.bcc || [], reply_to: mail.reply_to ? [mail.reply_to] : [] });
        previewMails.splice(20);
        return { id: `preview-${id}` };
      },
      listOutbox: async () => ({ data: previewMails.map(({ id, from, to, subject, created_at, last_event }) => ({ id, from, to, subject, created_at, last_event })), has_more: false, next_cursor: null }),
      getOutboxMail: async (id) => {
        const mail = previewMails.find((entry) => entry.id === id);
        if (!mail) throw new HttpError(404, "邮件不存在或已无法查询。");
        return mail;
      },
    });
  },
};
