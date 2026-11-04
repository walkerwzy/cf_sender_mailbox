import test from "node:test";
import assert from "node:assert/strict";
import { ensureSendingDomains } from "../scripts/resend-domain.mjs";

const records = [
  { record: "DKIM", type: "TXT", name: "resend._domainkey", value: "p=public-key" },
  { record: "SPF", type: "TXT", name: "send", value: "v=spf1 include:amazonses.com ~all" },
  { record: "SPF", type: "MX", name: "send", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
  { record: "Receiving", type: "MX", name: "wzy.one", value: "receiving-server.example" },
];
const silent = () => {};

test("verified domains require no DNS changes", async () => {
  await ensureSendingDomains({ domains: ["wzy.one"], accountId: "account", resend: async (path) => path === "/domains" ? { data: [{ id: "id", name: "wzy.one" }] } : { status: "verified" }, cloudflare: async () => { assert.fail("Must not touch DNS"); }, log: silent });
});

test("adds only sending records on subdomains, preserving inbox routing", async () => {
  const changes = [];
  let checked = false;
  await ensureSendingDomains({ domains: ["wzy.one"], accountId: "account", log: silent, pause: async () => {},
    resend: async (path, method) => {
      if (path === "/domains") return { data: [{ id: "id", name: "wzy.one" }] };
      if (method === "POST") { checked = true; return {}; }
      return { status: checked ? "verified" : "pending", records };
    },
    cloudflare: async (path, method, body) => {
      if (path.startsWith("/zones?")) return [{ id: "zone", name: "wzy.one" }];
      if (method === "POST") { changes.push(body); return {}; }
      return [];
    },
  });
  assert.equal(changes.length, 3);
  assert.ok(changes.every((record) => record.name !== "wzy.one" && record.name.endsWith(".wzy.one")));
  assert.equal(changes.filter((record) => record.type === "MX")[0].name, "send.wzy.one");
});

test("conflicting records abort before any DNS writes", async () => {
  let writes = 0;
  await assert.rejects(ensureSendingDomains({ domains: ["wzy.one"], accountId: "account", log: silent,
    resend: async (path) => path === "/domains" ? { data: [{ id: "id", name: "wzy.one" }] } : { status: "pending", records },
    cloudflare: async (path, method) => {
      if (method === "POST") { writes++; return {}; }
      if (path.startsWith("/zones?")) return [{ id: "zone", name: "wzy.one" }];
      return path.includes("name=send.wzy.one") ? [{ content: "v=spf1 -all" }] : [];
    },
  }), /不会覆盖/);
  assert.equal(writes, 0);
});

test("read-only checking never creates an unregistered domain", async () => {
  const calls = [];
  await assert.rejects(ensureSendingDomains({ domains: ["wzy.one"], accountId: "account", checkOnly: true, log: silent, resend: async (path, method) => { calls.push([path, method]); return { data: [] }; }, cloudflare: async () => assert.fail() }), /尚未添加/);
  assert.deepEqual(calls, [["/domains", undefined]]);
});

test("unexpected root-domain sending MX records are refused", async () => {
  await assert.rejects(ensureSendingDomains({ domains: ["wzy.one"], accountId: "account", log: silent,
    resend: async (path) => path === "/domains" ? { data: [{ id: "id", name: "wzy.one" }] } : { status: "pending", records: [{ record: "SPF", type: "MX", name: "wzy.one", value: "server.example" }] },
    cloudflare: async (path) => path.startsWith("/zones?") ? [{ id: "zone", name: "wzy.one" }] : assert.fail(),
  }), /拒绝修改根域名/);
});
