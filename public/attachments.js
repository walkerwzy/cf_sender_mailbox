export async function attachmentApi(path, data) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), signal: AbortSignal.timeout(22000) });
  if (response.redirected || !response.headers.get("content-type")?.includes("application/json")) throw new Error("登录可能已过期，请保留邮件并重新登录。");
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "附件操作失败，请稍后重试。");
  return result;
}

export function uploadFile(file, grant, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", grant.upload.url);
    xhr.withCredentials = false;
    xhr.timeout = 10 * 60 * 1000;
    for (const [name, value] of Object.entries(grant.upload.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100)); };
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`文件上传失败（HTTP ${xhr.status}），请重试。`));
    xhr.onerror = () => reject(new Error("文件上传连接失败，请检查网络后重试。"));
    xhr.ontimeout = () => reject(new Error("文件上传超时，请重试。"));
    xhr.onabort = () => reject(new Error("文件上传已取消，请重试。"));
    // File is sent as raw bytes. The browser supplies Content-Length automatically.
    xhr.send(file);
  });
}

export class AttachmentQueue {
  constructor({ api = attachmentApi, upload = uploadFile, changed = () => {}, now = Date.now } = {}) {
    Object.assign(this, { api, upload, changed, now, items: [], mode: "attachment", emailAttempted: false, busy: false });
  }
  validate(files = this.items.map((item) => item.file)) {
    if (!this.ready && files.length) throw new Error("附件服务尚未配置，请先配置 R2。");
    const maximum = this.mode === "link" ? this.limits?.linkMaxTotalBytes : this.limits?.maxTotalBytes;
    if (files.length > (this.limits?.maxCount || 10)) throw new Error("最多添加 10 个文件。");
    if (files.some((file) => !file.size)) throw new Error("不能添加空文件。");
    if (files.reduce((total, file) => total + file.size, 0) > maximum) throw new Error(this.mode === "link" ? "下载链接文件合计不能超过 100 MiB。" : "传统附件合计不能超过 25 MiB，请切换为下载链接或移除文件。");
  }
  add(files) {
    if (this.busy) return;
    this.validate([...this.items.map((item) => item.file), ...files]);
    this.items.push(...files.map((file) => ({ id: crypto.randomUUID(), file, status: "待上传" })));
    this.changed();
  }
  remove(id) {
    if (this.busy) return;
    this.items = this.items.filter((item) => item.id !== id);
    this.changed();
  }
  clear() { if (!this.busy) { this.items = []; this.changed(); } }
  async complete(items) {
    if (!items.length) return;
    const result = await this.api("/api/attachments/complete", { attachments: items.map((item) => ({ token: item.grant.token })), mode: this.mode });
    if (!Array.isArray(result.files) || result.files.length !== items.length) throw new Error("无法确认文件上传结果，请重试。");
    result.files.forEach((file, index) => { items[index].uploaded = file.uploaded === true; });
  }
  async prepare() {
    this.validate();
    if (!this.items.length) return [];
    this.busy = true;
    try {
      for (const item of this.items) {
        if (item.grant && Date.parse(item.grant.referenceExpiresAt) <= this.now()) {
          if (this.emailAttempted) throw new Error("附件引用已过期，无法原样重试。请先检查发件箱确认上次发送结果，再重新选择文件。");
          item.grant = undefined;
          item.uploaded = false;
        }
      }
      // A dropped PUT response may still mean the object reached R2.
      await this.complete(this.items.filter((item) => item.grant && item.attempted && !item.uploaded));
      const pending = this.items.filter((item) => !item.grant || (!item.uploaded && Date.parse(item.grant.uploadExpiresAt) <= this.now()));
      if (pending.length) {
        const result = await this.api("/api/attachments/uploads", { files: pending.map(({ file }) => ({ filename: file.name, size: file.size })), mode: this.mode });
        if (!Array.isArray(result.files) || result.files.length !== pending.length) throw new Error("无法创建文件上传，请重试。");
        pending.forEach((item, index) => { item.grant = result.files[index]; item.attempted = false; item.uploaded = false; });
      }
      for (const item of this.items) {
        if (!item.uploaded) {
          item.attempted = true;
          item.status = "上传中 · 0%";
          this.changed();
          try {
            await this.upload(item.file, item.grant, (percent) => { item.status = `上传中 · ${percent}%`; this.changed(); });
            item.uploaded = true;
          } catch (error) {
            item.status = "正在确认上传结果…";
            this.changed();
            await this.complete([item]);
            if (!item.uploaded) { item.status = "上传未完成，可重试"; throw error; }
          }
        }
        item.status = "已上传";
        this.changed();
      }
      return this.items.map((item) => ({ token: item.grant.token }));
    } finally { this.busy = false; this.changed(); }
  }
}

export const fileSize = (bytes) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
