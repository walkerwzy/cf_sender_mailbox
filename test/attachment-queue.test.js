import test from "node:test";
import assert from "node:assert/strict";
import { AttachmentQueue, uploadFile } from "../public/attachments.js";
import { ATTACHMENT_LIMITS } from "../src/attachments.js";

const start = Date.UTC(2026, 10, 4);
function fixture(overrides = {}) {
  let count = 0;
  const calls = [];
  const queue = new AttachmentQueue({ now: () => start, api: async (path, body) => {
    calls.push({ path, body });
    if (path.endsWith("/complete")) return { files: body.attachments.map(() => ({ uploaded: false })) };
    return { files: body.files.map(() => ({ token: `grant-${++count}`, referenceExpiresAt: new Date(start + 86400000).toISOString(), uploadExpiresAt: new Date(start + 900000).toISOString(), upload: { url: "https://r2.test", headers: {} } })) };
  }, upload: async () => {}, ...overrides });
  queue.ready = true;
  queue.limits = ATTACHMENT_LIMITS;
  return { queue, calls };
}
const file = (name = "file.pdf") => new File(["binary"], name, { type: "application/pdf" });

test("queue reuses uploaded references across uncertain email retries and mode changes", async () => {
  let puts = 0;
  const { queue, calls } = fixture({ upload: async () => { puts++; } });
  queue.add([file(), file("photo.jpg")]);
  const first = await queue.prepare();
  queue.emailAttempted = true;
  assert.deepEqual(await queue.prepare(), first);
  queue.mode = "link";
  assert.deepEqual(await queue.prepare(), first);
  assert.equal(puts, 2);
  assert.equal(calls.length, 1, "All grants are issued in one request and no bytes are resent");
  assert.deepEqual(calls[0].body.files, [{ filename: "file.pdf", size: 6 }, { filename: "photo.jpg", size: 6 }]);
});

test("a lost PUT response confirmed by R2 HEAD continues without a second upload", async () => {
  let puts = 0;
  const { queue } = fixture({ api: async (path) => path.endsWith("/complete") ? { files: [{ uploaded: true }] } : { files: [{ token: "stable-grant", referenceExpiresAt: new Date(start + 86400000).toISOString(), uploadExpiresAt: new Date(start + 900000).toISOString() }] }, upload: async () => { puts++; throw new Error("lost response"); } });
  queue.add([file()]);
  assert.deepEqual(await queue.prepare(), [{ token: "stable-grant" }]);
  assert.equal(puts, 1);
  assert.equal(queue.items[0].status, "已上传");
});

test("failed uploads keep completed files and reuse still-valid grants on retry", async () => {
  let puts = 0;
  const { queue, calls } = fixture({ upload: async () => { if (++puts === 2) throw new Error("offline"); } });
  queue.add([file(), file("second.pdf")]);
  await assert.rejects(queue.prepare(), /offline/);
  assert.equal(queue.busy, false);
  assert.equal(queue.items[0].uploaded, true);
  assert.deepEqual(await queue.prepare(), [{ token: "grant-1" }, { token: "grant-2" }]);
  assert.equal(puts, 3);
  assert.equal(calls.filter((call) => call.path.endsWith("/uploads")).length, 1);
});

test("expired unused PUTs are renewed, but expired references from uncertain mail submissions are preserved", async () => {
  const { queue, calls } = fixture();
  queue.add([file()]);
  queue.items[0].grant = { token: "old-grant", referenceExpiresAt: new Date(start + 3600000).toISOString(), uploadExpiresAt: new Date(start - 1000).toISOString() };
  assert.deepEqual(await queue.prepare(), [{ token: "grant-1" }]);
  assert.equal(calls.length, 1);
  queue.emailAttempted = true;
  queue.now = () => start + 86400000;
  await assert.rejects(queue.prepare(), /先检查发件箱/);
  assert.equal(queue.items[0].grant.token, "grant-1");
  assert.equal(calls.length, 1);
});

test("a large link-mode selection cannot be sent as traditional attachments", async () => {
  const { queue } = fixture();
  queue.mode = "link";
  queue.add([{ name: "video.mov", size: 30 * 1024 * 1024 }]);
  queue.mode = "attachment";
  await assert.rejects(queue.prepare(), /切换为下载链接/);
  queue.mode = "link";
  assert.throws(() => queue.add([{ name: "video2.mov", size: 80 * 1024 * 1024 }]), /100 MiB/);
  queue.ready = false;
  await assert.rejects(queue.prepare(), /配置 R2/);
});

test("browser PUT sends the original File with signed headers, progress and no credentials or manual Content-Length", async (t) => {
  const selected = file();
  const events = [];
  class Xhr {
    constructor() { this.upload = {}; this.headers = {}; }
    open(method, url) { assert.equal(method, "PUT"); assert.equal(url, "https://r2.test/file"); }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) {
      assert.equal(body, selected);
      assert.equal(this.withCredentials, false);
      assert.equal(this.headers["Content-Length"], undefined);
      assert.equal(this.headers["If-None-Match"], "*");
      this.upload.onprogress({ lengthComputable: true, loaded: 3, total: 6 });
      this.status = 200;
      this.onload();
    }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, writable: true, value: Xhr });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "XMLHttpRequest", previous); else delete globalThis.XMLHttpRequest; });
  await uploadFile(selected, { upload: { url: "https://r2.test/file", headers: { "Content-Type": "application/octet-stream", "If-None-Match": "*" } } }, (value) => events.push(value));
  assert.deepEqual(events, [50]);
});
