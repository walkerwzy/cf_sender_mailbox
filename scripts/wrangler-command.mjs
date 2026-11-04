import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Retain possible partial secrets across chunks before publishing any output.
export function redactedOutput(stream, secrets) {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const retained = Math.max(0, ...values.map((value) => value.length - 1));
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const emit = (flush) => {
    let cut = flush ? pending.length : Math.max(0, pending.length - retained);
    if (!flush) {
      let changed;
      do {
        changed = false;
        for (const secret of values) {
          let at = pending.indexOf(secret);
          while (at >= 0 && at < cut) {
            if (at + secret.length > cut) { cut = at; changed = true; }
            at = pending.indexOf(secret, at + 1);
          }
        }
      } while (changed);
    }
    let output = pending.slice(0, cut);
    pending = pending.slice(cut);
    for (const secret of values) output = output.replaceAll(secret, "[REDACTED]");
    if (output) stream.write(output);
  };
  return {
    write(chunk) { pending += decoder.write(chunk); emit(false); },
    end() { pending += decoder.end(); emit(true); },
  };
}

function hasCompleted(entries, args) {
  const last = entries.at(-1);
  if (last?.version !== 1 || entries.some((entry) => entry.type === "command-failed")) return false;
  if (args[0] !== "versions") return false;
  if (args[1] === "upload") return last.type === "version-upload" && UUID.test(last.version_id || "");
  if (args[1] === "deploy") return last.type === "version-deploy" && UUID.test(last.deployment_id || "");
  return false;
}

export async function runWrangler(args, { cwd, env = {}, sensitive = [], stdout = process.stdout, stderr = process.stderr, timeoutMs = 300000, exitGraceMs = 3000, pollMs = 250, heartbeatMs = 15000 } = {}) {
  const outputPath = resolve(cwd, `.deploy/wrangler-result-${randomUUID()}.jsonl`);
  await writeFile(outputPath, "", { flag: "wx", mode: 0o600 });
  const label = args[0] === "versions" ? `wrangler versions ${args[1]}` : "wrangler deploy";
  stdout.write(`正在执行 ${label}…\n`);
  try {
    return await new Promise((resolveCommand, reject) => {
      const child = spawn("wrangler", args, {
        cwd,
        env: { ...process.env, ...env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_SANITIZE: "true", WRANGLER_LOG_PATH: resolve(cwd, ".deploy/wrangler.log"), WRANGLER_OUTPUT_FILE_PATH: outputPath },
        stdio: ["ignore", "pipe", "pipe"],
        // Stop this command and its CLI child together if cleanup hangs.
        detached: process.platform !== "win32",
      });
      const out = redactedOutput(stdout, sensitive);
      const err = redactedOutput(stderr, sensitive);
      let captured = "";
      let stopped;
      let completedAt;
      let cleanupStop = false;
      let polling = false;
      let closed = false;
      let killTimer;
      const started = Date.now();
      const kill = (signal) => {
        if (!child.pid) return;
        try {
          if (process.platform === "win32") child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch (error) { if (error.code !== "ESRCH") stderr.write("无法结束 Wrangler 子进程，请在终端停止本次部署。\n"); }
      };
      const stop = () => {
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), 1000);
      };
      const interrupt = () => {
        if (stopped || cleanupStop) return;
        stopped = new Error("已取消本次 Wrangler 命令，未自动重试。");
        stop();
      };
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", interrupt);
      child.stdout.on("data", (chunk) => { captured += chunk.toString(); out.write(chunk); });
      child.stderr.on("data", (chunk) => err.write(chunk));
      const timeout = setTimeout(() => {
        stopped = new Error(`${label} 执行超过 ${Math.round(timeoutMs / 1000)} 秒，已停止本次命令。线上结果可能尚未确认，请检查 .deploy/wrangler.log；未自动重试。`);
        stop();
      }, timeoutMs);
      const heartbeat = setInterval(() => {
        stdout.write(`${label} 仍在执行（${Math.floor((Date.now() - started) / 1000)} 秒），详情见 .deploy/wrangler.log。\n`);
      }, heartbeatMs);
      const poll = setInterval(async () => {
        if (closed || polling || stopped || cleanupStop) return;
        polling = true;
        try {
          const raw = await readFile(outputPath, "utf8");
          if (closed || stopped || cleanupStop) return;
          const entries = raw.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
          if (!hasCompleted(entries, args)) return;
          completedAt ??= Date.now();
          if (Date.now() - completedAt >= exitGraceMs) {
            cleanupStop = true;
            stdout.write(`${label} 已返回正式成功记录，但进程未退出；正在结束残留进程并继续。\n`);
            stop();
          }
        } catch (error) { if (error.code !== "ENOENT") stderr.write("暂时无法读取 Wrangler 完成记录，继续等待进程结果。\n"); }
        finally { polling = false; }
      }, pollMs);
      const finish = (error, code) => {
        if (closed) return;
        closed = true;
        for (const timer of [timeout, heartbeat, poll, killTimer]) clearTimeout(timer);
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
        out.end(); err.end();
        if (error || stopped) reject(error || stopped);
        else if (code === 0 || cleanupStop) resolveCommand(captured);
        else reject(new Error(`Wrangler 执行失败（退出码 ${code ?? "未知"}）。`));
      };
      child.on("error", (error) => finish(new Error(error.code === "ENOENT" ? "找不到 Wrangler。请先运行 npm ci。" : "无法启动 Wrangler 子进程。")));
      child.on("close", (code) => finish(null, code));
    });
  } finally { await unlink(outputPath).catch(() => {}); }
}
