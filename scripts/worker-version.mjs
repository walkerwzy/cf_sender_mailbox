// Version uploads and deployments preserve existing domain bindings and routes.
export async function deployWorkerVersion({ command, configPath, secretPath, env }) {
  const output = await command(["versions", "upload", "--config", configPath, "--secrets-file", secretPath, "--keep-vars"], env);
  const versionId = /Worker Version ID:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i.exec(output)?.[1];
  if (!versionId) throw new Error("Worker 版本已上传，但无法读取版本 ID，尚未切换流量。请检查 .deploy/wrangler.log。");
  await command(["versions", "deploy", "--config", configPath, "--version-id", versionId, "--percentage", "100", "--yes"], env);
  return versionId;
}
