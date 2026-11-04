const $ = (id) => document.getElementById(id);
const form = $("mail-form");
const sendButton = $("send-button");
let format = "text";
let session;
let sending = false;
let sent = false;
let requestId;
let outboxLoaded = false;
let outboxLoading = false;
let outboxCursor = null;
let outboxCount = 0;
let detailRequest = 0;
let detailMail;
const outboxIds = new Set();
const mailEvents = { sent: "已发送", delivered: "已投递", delivery_delayed: "投递延迟", opened: "已打开", clicked: "已点击", bounced: "已退信", complained: "被投诉", failed: "发送失败", canceled: "已取消", scheduled: "待发送", queued: "排队中", suppressed: "已拦截" };

function mailTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(date);
}

function mailStatus(element, event) {
  element.textContent = mailEvents[event] || "状态未知";
  element.classList.toggle("failed", ["bounced", "complained", "failed", "suppressed"].includes(event));
}

function outboxNotice(message, error = false) {
  $("outbox-notice").textContent = message;
  $("outbox-notice").classList.toggle("error", error);
  $("outbox-notice").hidden = !message;
}

async function readOutbox(path) {
  const response = await fetch(path, { signal: AbortSignal.timeout(22000) });
  if (response.redirected || !response.headers.get("content-type")?.includes("application/json")) throw new Error("登录可能已过期，请重新登录。");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "无法读取发件箱，请稍后重试。");
  return data;
}

function readError(error) {
  return ["TimeoutError", "TypeError"].includes(error.name) ? "暂时无法读取发件箱，请稍后重试。" : error.message;
}

function appendMail(mail) {
  if (outboxIds.has(mail.id)) return;
  outboxIds.add(mail.id);
  outboxCount++;
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "outbox-row";
  const main = document.createElement("span");
  main.className = "outbox-row-main";
  const subject = document.createElement("strong");
  subject.className = "outbox-subject";
  subject.textContent = mail.subject || "（无主题）";
  const to = document.createElement("span");
  to.className = "outbox-to";
  to.textContent = `收件人：${mail.to.join("、")}`;
  main.append(subject, to);
  const meta = document.createElement("span");
  meta.className = "outbox-row-meta";
  const time = document.createElement("time");
  time.dateTime = mail.created_at;
  time.textContent = mailTime(mail.created_at);
  const status = document.createElement("span");
  status.className = "mail-status";
  mailStatus(status, mail.last_event);
  meta.append(time, status);
  button.append(main, meta);
  button.addEventListener("click", () => openMail(mail.id));
  item.append(button);
  $("outbox-list").append(item);
}

async function loadOutbox(refresh = false) {
  if (!session || outboxLoading) return;
  outboxLoading = true;
  $("outbox-refresh").disabled = true;
  $("outbox-more").disabled = true;
  $("outbox-list-view").setAttribute("aria-busy", "true");
  outboxNotice("正在读取邮件…");
  try {
    const cursor = refresh ? null : outboxCursor;
    const page = await readOutbox(`/api/outbox${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (refresh) {
      $("outbox-list").replaceChildren();
      outboxIds.clear();
      outboxCount = 0;
    }
    page.data.forEach(appendMail);
    outboxCursor = page.next_cursor;
    outboxLoaded = true;
    $("outbox-more").hidden = !page.has_more;
    $("outbox-empty").hidden = outboxCount > 0;
    $("outbox-empty").textContent = page.has_more ? "尚未找到当前邮箱的邮件，可继续加载更早记录。" : "暂无可查询的已发送邮件。";
    $("outbox-count").textContent = `${outboxCount} 封邮件${page.has_more ? " · 还有更早记录" : ""}`;
    outboxNotice(page.has_more && page.data.length === 0 && outboxCount > 0 ? "这一页没有当前邮箱的邮件，可继续加载更早记录。" : "");
  } catch (error) {
    $("outbox-empty").hidden = outboxCount > 0;
    $("outbox-empty").textContent = "读取未完成，请点击刷新重试。";
    outboxNotice(readError(error), true);
  } finally {
    outboxLoading = false;
    $("outbox-refresh").disabled = false;
    $("outbox-more").disabled = false;
    $("outbox-list-view").setAttribute("aria-busy", "false");
  }
}

function showMailBody(format) {
  $("detail-body").textContent = detailMail?.[format] ?? "暂无可查询的正文。";
  $("detail-body").classList.toggle("html-source", format === "html");
  for (const type of ["text", "html"]) {
    $("detail-" + type).classList.toggle("active", type === format);
    $("detail-" + type).setAttribute("aria-pressed", String(type === format));
  }
}

async function openMail(id) {
  const request = ++detailRequest;
  detailMail = undefined;
  $("outbox-list-view").hidden = true;
  $("outbox-detail").hidden = false;
  $("outbox-detail").setAttribute("aria-busy", "true");
  $("detail-subject").textContent = "正在读取邮件…";
  $("detail-status").textContent = "";
  $("detail-addresses").replaceChildren();
  $("detail-formats").hidden = true;
  $("detail-body").textContent = "";
  outboxNotice("");
  try {
    const mail = await readOutbox(`/api/outbox/${encodeURIComponent(id)}`);
    if (request !== detailRequest) return;
    detailMail = mail;
    $("detail-subject").textContent = mail.subject || "（无主题）";
    mailStatus($("detail-status"), mail.last_event);
    const fields = [["发件人", mail.from], ["收件人", mail.to.join("、")], ["抄送", mail.cc.join("、")], ["密送", mail.bcc.join("、")], ["回复地址", mail.reply_to.join("、")], ["发送时间", mailTime(mail.created_at)], ["邮件编号", mail.id]];
    for (const [label, value] of fields) {
      if (!value) continue;
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = value;
      $("detail-addresses").append(term, description);
    }
    $("detail-formats").hidden = mail.text === null && mail.html === null;
    $("detail-text").hidden = mail.text === null;
    $("detail-html").hidden = mail.html === null;
    showMailBody(mail.text !== null ? "text" : "html");
    $("detail-subject").focus();
  } catch (error) {
    if (request !== detailRequest) return;
    $("detail-subject").textContent = "邮件读取未完成";
    outboxNotice(readError(error), true);
  } finally {
    if (request === detailRequest) $("outbox-detail").setAttribute("aria-busy", "false");
  }
}

function backToOutbox() {
  detailRequest++;
  detailMail = undefined;
  $("outbox-detail").hidden = true;
  $("outbox-list-view").hidden = false;
  outboxNotice("");
}

function selectView() {
  const outbox = window.location.hash === "#outbox";
  $("compose-panel").hidden = outbox;
  $("outbox-panel").hidden = !outbox;
  for (const [id, active] of [["nav-compose", !outbox], ["nav-outbox", outbox]]) {
    if (active) $(id).setAttribute("aria-current", "page");
    else $(id).removeAttribute("aria-current");
  }
  $("page-title").textContent = $("breadcrumb-page").textContent = outbox ? "发件箱" : "新建邮件";
  $("page-eyebrow").textContent = outbox ? "LETTERS YOU HAVE SENT" : "A NOTE FROM YOU";
  $("page-description").textContent = outbox ? "查看寄出的邮件，留意每一次投递。" : "写下想说的话，送到对方的收件箱。";
  $("page-index").textContent = outbox ? "MAIL / 002" : "MAIL / 001";
  if (!outbox) backToOutbox();
  if (outbox && !outboxLoaded) loadOutbox(true);
}

$("outbox-refresh").addEventListener("click", () => loadOutbox(true));
$("outbox-more").addEventListener("click", () => loadOutbox());
$("outbox-back").addEventListener("click", () => { backToOutbox(); $("outbox-refresh").focus(); });
$("detail-text").addEventListener("click", () => showMailBody("text"));
$("detail-html").addEventListener("click", () => showMailBody("html"));
window.addEventListener("hashchange", selectView);

function showNotice(message, error = false) {
  const notice = $("notice");
  notice.textContent = message;
  notice.classList.toggle("error", error);
  notice.hidden = false;
}

function updateButton() {
  sendButton.disabled = sending || sent || !session?.ready;
  $("clear-button").disabled = sending;
  $("send-label").textContent = sending ? "正在发送…" : sent ? "已发送" : session?.preview ? "模拟发送" : "发送邮件";
}

function onEdit() {
  requestId = undefined;
  sent = false;
  $("character-count").textContent = new Intl.NumberFormat("zh-CN").format($("body").value.length);
  if (session?.ready && !sending) $("notice").hidden = true;
  updateButton();
}

form.addEventListener("input", onEdit);
document.querySelectorAll("[data-format]").forEach((button) => {
  button.addEventListener("click", () => {
    if (sending || format === button.dataset.format) return;
    format = button.dataset.format;
    document.querySelectorAll("[data-format]").forEach((item) => {
      const active = item.dataset.format === format;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    $("body").classList.toggle("html-mode", format === "html");
    $("body").spellcheck = format === "text";
    $("body").placeholder = format === "html" ? "<h1>你好，</h1>\n<p>从这里开始写一封邮件…</p>" : "你好，\n\n从这里开始写一封邮件…";
    $("format-hint").textContent = format === "html" ? "填写 HTML 源码，作为邮件正文发送" : "简单、清晰，专注于内容";
    onEdit();
  });
});

$("toggle-extra").addEventListener("click", () => {
  const hidden = !$("extra-fields").hidden;
  $("extra-fields").hidden = hidden;
  $("toggle-extra").setAttribute("aria-expanded", String(!hidden));
});

$("clear-button").addEventListener("click", () => {
  if (sending) return;
  if (["to", "cc", "bcc", "reply-to", "subject", "body"].some((id) => $(id).value) && !confirm("清空这封邮件的全部内容？")) return;
  form.reset();
  onEdit();
  $("to").focus();
});

$("logout").addEventListener("click", async (event) => {
  event.preventDefault();
  if (sending) return;
  try {
    const response = await fetch("/api/logout", { method: "POST", signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "退出登录失败，请重试。");
    window.location.replace(result.redirect);
  } catch (error) {
    showNotice("退出登录未完成，请稍后重试。", true);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (sending || sent || !session?.ready || !form.reportValidity()) return;
  const payload = { to: $("to").value, cc: $("cc").value, bcc: $("bcc").value, replyTo: $("reply-to").value, subject: $("subject").value, body: $("body").value, format };
  requestId ||= crypto.randomUUID();
  const submissionId = requestId;
  sending = true;
  updateButton();
  // Keep retries identical while the provider request is in flight.
  form.querySelectorAll("input, textarea, [data-format]").forEach((element) => { element.disabled = true; });
  try {
    const response = await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": submissionId },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(22000),
    });
    if (response.redirected || !response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("登录可能已过期，请保留邮件内容并重新登录。");
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "发送失败，请稍后重试。");
    sent = true;
    outboxLoaded = false;
    showNotice(result.preview ? `本地预览成功，未发送真实邮件。编号：${result.id}` : `邮件已提交发送。邮件编号：${result.id}`);
  } catch (error) {
    const message = error.name === "TimeoutError" || error.name === "TypeError" ? "发送结果暂时无法确认，请保持内容不变并重试。" : error.message;
    showNotice(message, true);
  } finally {
    sending = false;
    form.querySelectorAll("input, textarea, [data-format]").forEach((element) => { element.disabled = false; });
    updateButton();
    selectView();
  }
});

async function init() {
  try {
    const response = await fetch("/api/session", { signal: AbortSignal.timeout(10000) });
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("请先登录后使用发信页面。");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法读取登录信息。");
    session = data;
    $("account-email").textContent = data.email;
    $("sender").textContent = data.from;
    $("domain").textContent = data.email.split("@")[1];
    if (data.preview) {
      $("access-label").textContent = "本地预览";
      $("logout").hidden = true;
      showNotice("本地预览模式：可以填写和模拟发送，邮件不会实际寄出。");
    } else {
      $("access-label").textContent = data.loginMethod === "password" ? "密码登录" : "邮箱验证码登录";
      if (!data.ready) showNotice("发件服务尚未配置，请先完成 Resend 配置。", true);
    }
    updateButton();
    selectView();
  } catch (error) {
    $("account-email").textContent = "登录验证未完成";
    $("sender").textContent = "无法读取发件人";
    showNotice(error.name === "TimeoutError" ? "登录验证超时，请刷新页面后重试。" : error.message, true);
  }
}

selectView();
init();
