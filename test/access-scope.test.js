import test from "node:test";
import assert from "node:assert/strict";
import { applyAccessScope, planAccessScope } from "../scripts/access-scope.mjs";

const config = { domain: "mail.wzy.one", appName: "Mailroom", otpId: "otp", loginMode: "dual" };
const app = { id: "app", aud: "stable-audience", name: config.appName, domain: config.domain };

test("reuses the existing app and audience while moving Access to the OTP bridge", () => {
  const plan = planAccessScope({ ...config, apps: [app] });
  assert.equal(plan.app, app);
  assert.equal(plan.appConfig.domain, "mail.wzy.one/auth/access");
  assert.deepEqual(plan.appConfig.allowed_idps, ["otp"]);
  assert.throws(() => planAccessScope({ ...config, apps: [app], checkOnly: true }), /登录范围需要更新/);
  assert.equal(planAccessScope({ ...config, apps: [{ ...app, domain: "mail.wzy.one/auth/access" }], checkOnly: true }).app.aud, app.aud);
});

test("restores whole-host Access when password login is disabled", () => {
  const plan = planAccessScope({ ...config, loginMode: "access", apps: [{ ...app, domain: "mail.wzy.one/auth/access" }] });
  assert.equal(plan.appConfig.domain, config.domain);
});

test("refuses unrelated or duplicate applications that could prevent password login", () => {
  assert.throws(() => planAccessScope({ ...config, apps: [{ ...app, name: "Other app" }] }), /其他 Access 应用/);
  assert.throws(() => planAccessScope({ ...config, apps: [app, { ...app, id: "other", domain: "mail.wzy.one/auth/access" }] }), /多个 Access 应用/);
});

test("updates the existing application and refuses an unexpected audience change", async () => {
  const { appConfig } = planAccessScope({ ...config, apps: [app] });
  const updated = await applyAccessScope({ base: "/accounts/account", app, appConfig, cloudflare: async (path, method, body) => {
    assert.equal(path, "/accounts/account/access/apps/app");
    assert.equal(method, "PUT");
    assert.equal(body, appConfig);
    return { ...app, ...body };
  } });
  assert.equal(updated.aud, app.aud);
  await assert.rejects(applyAccessScope({ base: "/accounts/account", app, appConfig, cloudflare: async () => ({ aud: "changed" }) }), /audience 发生变化/);
});
