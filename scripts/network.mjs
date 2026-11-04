const RESET = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);
const TIMEOUT = new Set(["ETIMEDOUT", "TimeoutError", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const DNS = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const TLS = new Set(["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID"]);
const PERMISSION = new Set(["EACCES", "EPERM"]);

export function networkCode(error) {
  const queue = [error];
  const seen = new Set();
  let fallback;
  for (const item of queue) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    const code = typeof item.code === "string" ? item.code : item.name === "TimeoutError" ? item.name : undefined;
    if (code && (RESET.has(code) || TIMEOUT.has(code) || DNS.has(code) || TLS.has(code) || PERMISSION.has(code) || code === "ECONNREFUSED")) return code;
    if (code && !fallback) fallback = code;
    if (item.cause) queue.push(item.cause);
    if (Array.isArray(item.errors)) queue.push(...item.errors);
  }
  return fallback || error?.name || "NETWORK_ERROR";
}

export function retryableNetworkCode(code) {
  return RESET.has(code) || TIMEOUT.has(code) || code === "EAI_AGAIN";
}

export function networkReport(code, sandboxDisabled = false) {
  if (sandboxDisabled && (DNS.has(code) || PERMISSION.has(code))) {
    return { code: "SANDBOX_NETWORK", message: "当前进程设置了 CODEX_SANDBOX_NETWORK_DISABLED=1，外网访问受限；请在允许联网的普通终端执行同一命令。" };
  }
  if (RESET.has(code)) return { code: "CONNECTION_RESET", message: "连接被中途断开，可能来自当前网络、VPN/代理或 API 上游。请先重试；若持续发生，对比同一终端中 curl 和 Node 的连接结果。" };
  if (TIMEOUT.has(code)) return { code: "CONNECTION_TIMEOUT", message: "API 连接或响应超时。请稍后重试；若持续发生，检查当前网络和代理连接。" };
  if (DNS.has(code)) return { code: "DNS", message: "API 域名解析失败。请检查当前终端的 DNS 和网络；仅凭这个错误不能确定是权限限制。" };
  if (code === "ECONNREFUSED") return { code: "CONNECTION_REFUSED", message: "目标服务器或代理拒绝连接。请确认代理服务正在运行，以及目标地址和端口正确。" };
  if (TLS.has(code)) return { code: "TLS", message: "HTTPS 证书验证失败。请检查系统时间、代理证书和 Node 的受信任证书配置。" };
  if (PERMISSION.has(code)) return { code: "NETWORK_PERMISSION", message: "操作系统拒绝了网络连接，请检查当前命令进程的网络权限。" };
  return { code: "NETWORK", message: "网络请求未完成，请结合具体错误码和同一终端的连接测试排查。" };
}
