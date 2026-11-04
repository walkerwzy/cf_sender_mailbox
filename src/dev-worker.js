import { handleRequest } from "./worker.js";
import { HttpError } from "./access.js";

const previewMails = [
  { id: "79d803ab-d6b1-4d6e-bd47-3a23b6e5e661", from: "walker <admin@wzy.one>", to: ["friend@example.com"], subject: "一封来自私人邮局的信", text: "你好，\n\n这是发件箱的本地示例。这里可以查看寄出的邮件和投递状态。", html: null, last_event: "delivered" },
  { id: "79d803ab-d6b1-4d6e-bd47-3a23b6e5e662", from: "walker <admin@wzy.one>", to: ["hello@example.com"], subject: "HTML 邮件示例", text: null, html: "<h1>你好，</h1>\n<p>这是模拟邮件，正文以 HTML 源码显示。</p>", last_event: "sent" },
].map((mail, index) => ({ ...mail, created_at: new Date(Date.now() - (index + 1) * 3600000).toISOString(), cc: [], bcc: [], reply_to: [] }));

export default {
  async fetch(request, env, ctx) {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) {
      return new Response("Local preview only", { status: 403 });
    }
    return handleRequest(request, { ...env, OUTBOX_RATE_LIMITER: { limit: async () => ({ success: true }) } }, ctx, {
      authenticate: async () => ({ email: "admin@wzy.one" }),
      preview: true,
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
