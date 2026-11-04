import test from "node:test";
import assert from "node:assert/strict";
import { preflightCustomDomain } from "../scripts/custom-domain.mjs";

const accountId = "account";
const domain = "mail.wzy.one";

test("finds the parent DNS zone and checks route access before deployment", async () => {
  const calls = [];
  const result = await preflightCustomDomain({ accountId, domain, cloudflare: async (path) => {
    calls.push(path);
    if (path.includes("name=mail.wzy.one")) return [];
    if (path.includes("name=wzy.one")) return [{ id: "zone-id", name: "wzy.one" }];
    assert.equal(path, "/zones/zone-id/workers/routes");
    return [];
  } });
  assert.deepEqual(result, { id: "zone-id", name: "wzy.one" });
  assert.equal(calls.length, 3);
  assert.ok(calls[0].includes("account.id=account"));
});

test("identifies route access failures and names the required zone permission", async () => {
  for (const status of [401, 403]) {
    await assert.rejects(preflightCustomDomain({ accountId, domain, cloudflare: async (path) => {
      if (path.includes("/workers/routes")) throw Object.assign(new Error("No access"), { status });
      return [{ id: "zone-id", name: "wzy.one" }];
    } }), (error) => {
      assert.equal(error.code, "CUSTOM_DOMAIN_PERMISSION");
      assert.match(error.message, /Workers Routes → Edit/);
      assert.match(error.message, /wzy\.one/);
      return true;
    });
  }
});

test("does not misclassify an API outage as missing permissions", async () => {
  const failure = Object.assign(new Error("Unavailable"), { status: 503 });
  await assert.rejects(preflightCustomDomain({ accountId, domain, cloudflare: async (path) => {
    if (path.includes("/workers/routes")) throw failure;
    return [{ id: "zone-id", name: "wzy.one" }];
  } }), (error) => error === failure);
});

test("stops before route access if the token cannot see the DNS zone", async () => {
  await assert.rejects(preflightCustomDomain({ accountId, domain, cloudflare: async (path) => {
    assert.ok(!path.includes("/workers/routes"));
    return [];
  } }), /Zone → Zone → Read/);
});
