import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { runWrangler, redactedOutput } from "../scripts/wrangler-command.mjs";

const versionId = "f12e0ef2-c8b3-4ba5-9cd7-13e096efa42f";
const buffer = () => ({ text: "", write(chunk) { this.text += chunk; } });

test("live output redacts secrets split across chunks and preserves split UTF-8", () => {
  const bytes = Buffer.from("上传中\nkey=very-private-token\n准备部署\n");
  for (let size = 1; size < bytes.length; size++) {
    const output = buffer();
    const writer = redactedOutput(output, ["very-private-token", "private"]);
    for (let at = 0; at < bytes.length; at += size) writer.write(bytes.subarray(at, at + size));
    writer.end();
    assert.equal(output.text, "上传中\nkey=[REDACTED]\n准备部署\n");
  }
});

async function fixture(t, body, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), "mailroom-wrangler-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".deploy"));
  await writeFile(join(root, "wrangler"), `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  const stdout = buffer();
  const stderr = buffer();
  return { root, stdout, stderr, config: { cwd: root, env: { PATH: root + delimiter + process.env.PATH }, stdout, stderr, heartbeatMs: 100, pollMs: 10, exitGraceMs: 50, timeoutMs: 5000, ...settings } };
}

const marker = `require("node:fs").appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({type:"version-upload",version:1,version_id:"${versionId}"}) + "\\n");`;

test("streams upload progress before the child exits and retains stdout for exact-version deployment", async (t) => {
  const f = await fixture(t, `
console.log("Uploading assets now");
setTimeout(() => { console.log("Worker Version ID: ${versionId}"); }, 300);
`);
  let progressBeforeCompletion = false;
  const write = f.stdout.write.bind(f.stdout);
  f.stdout.write = (chunk) => {
    write(chunk);
    if (f.stdout.text.includes("Uploading assets now") && !f.stdout.text.includes(versionId)) progressBeforeCompletion = true;
  };
  const result = await runWrangler(["versions", "upload"], f.config);
  assert.ok(progressBeforeCompletion, "Output must be visible before upload completion");
  assert.match(result, new RegExp(versionId));
  assert.ok(!(await readdir(join(f.root, ".deploy"))).some((name) => name.startsWith("wrangler-result-")));
});

test("a successful upload with a lingering process completes after formal success and stops its children", async (t) => {
  const f = await fixture(t, `
const {spawn}=require("node:child_process");
spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});
console.log("Worker Version ID: ${versionId}");
${marker}
setInterval(()=>{},1000);
`);
  const result = await runWrangler(["versions", "upload"], f.config);
  assert.match(result, new RegExp(versionId));
  assert.match(f.stdout.text, /正式成功记录/);
});

test("does not accept a printed version ID, malformed records, wrong completion types, or explicit failure as success", async (t) => {
  for (const entry of [null, { type: "version-upload", version: 1, version_id: "invalid" }, { type: "version-deploy", version: 1, deployment_id: versionId }, { type: "command-failed", version: 1, code: 403 }]) {
    const f = await fixture(t, `
const fs=require("node:fs");
fs.appendFileSync("invocations", "once\\n");
console.log("Worker Version ID: ${versionId}");
fs.appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, ${JSON.stringify(JSON.stringify(entry) + "\n")});
setInterval(()=>{},1000);
`, { timeoutMs: 1500 });
    await assert.rejects(runWrangler(["versions", "upload"], f.config), /未自动重试/);
    assert.equal(await readFile(join(f.root, "invocations"), "utf8"), "once\n");
    assert.ok(!f.stdout.text.includes("正式成功记录"));
  }
});

test("formal deployment completion can release a lingering CLI process", async (t) => {
  const f = await fixture(t, `
require("node:fs").appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH,JSON.stringify({type:"version-deploy",version:1,deployment_id:"${versionId}"})+"\\n");
console.log("Deployment complete");
setInterval(()=>{},1000);
`);
  assert.match(await runWrangler(["versions", "deploy"], f.config), /Deployment complete/);
  assert.match(f.stdout.text, /正式成功记录/);
});

test("nonzero exit remains a failure even with a completion record, and output is redacted", async (t) => {
  const f = await fixture(t, `
process.stdout.write("private-");
${marker}
setTimeout(()=> { process.stdout.write("token\\n"); console.error("private-token"); process.exitCode=2; },30);
`, { sensitive: ["private-token"] });
  await assert.rejects(runWrangler(["versions", "upload"], f.config), /退出码 2/);
  assert.ok(!f.stdout.text.includes("private-token") && !f.stderr.text.includes("private-token"));
  assert.match(f.stdout.text, /\[REDACTED\]/);
  assert.match(f.stderr.text, /\[REDACTED\]/);
});
