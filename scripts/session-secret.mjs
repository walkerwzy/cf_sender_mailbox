import { readFile, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

export async function getSessionSecret(directory, provided) {
  if (provided) {
    if (provided.length < 32) throw new Error("SESSION_SECRET 至少需要 32 个字符。");
    return provided;
  }
  const path = resolve(directory, "session-secret");
  try {
    await writeFile(path, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  await chmod(path, 0o600);
  const secret = await readFile(path, "utf8");
  if (secret.length < 32) throw new Error("本地会话签名密钥无效，请检查 .deploy/session-secret。");
  return secret;
}
