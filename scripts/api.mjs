import { networkCode, networkReport, retryableNetworkCode } from "./network.mjs";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function makeApi(base, headers, label, options = {}) {
  const fetcher = options.fetcher || fetch;
  const pause = options.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const warn = options.warn || console.warn;
  const sandboxDisabled = options.sandboxDisabled ?? process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1";
  async function close(response) { try { await response?.body?.cancel(); } catch { /* Body might already be consumed. */ } }
  return async (path, method = "GET", body) => {
    // A lost response to a creation/update must never cause an automatic replay.
    const attempts = method === "GET" ? 3 : 1;
    const description = `${label} ${method} ${path.split("?")[0]}`;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let response;
      let data;
      try {
        response = await fetcher(`${base}${path}`, {
          method, headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(20000), redirect: "error",
        });
        if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
          const retryAfter = response.headers.get("Retry-After");
          const seconds = retryAfter === null ? NaN : Number(retryAfter);
          const delay = Number.isFinite(seconds) ? Math.min(5000, Math.max(1000, seconds * 1000)) : 1000 * 2 ** (attempt - 1);
          warn(`${description} 返回 HTTP ${response.status}，${delay / 1000} 秒后重试（${attempt + 1}/${attempts}）。`);
          await close(response);
          await pause(delay);
          continue;
        }
        try { data = await response.json(); }
        catch (error) {
          if (!response.ok) {
            throw Object.assign(new Error(`${description} 失败（${response.status}）：API 返回了非 JSON 响应。`), { status: response.status });
          }
          const code = networkCode(error);
          if (retryableNetworkCode(code)) throw error;
          throw Object.assign(new Error(`${label} 返回了无效的响应（${response.status}）。`), { invalidResponse: true });
        }
      } catch (error) {
        if (error.status || error.invalidResponse) throw error;
        const code = networkCode(error);
        await close(response);
        if (retryableNetworkCode(code) && attempt < attempts) {
          const delay = 1000 * 2 ** (attempt - 1);
          warn(`${description} 连接异常（${code}），${delay / 1000} 秒后重试（${attempt + 1}/${attempts}）。`);
          await pause(delay);
          continue;
        }
        const report = networkReport(code, sandboxDisabled);
        const failure = new Error(`无法连接 ${label}：${code}。${description}，已尝试 ${attempt} 次。${report.message}${method === "GET" ? "" : "本次写入未自动重试；重新运行部署会先读取已有配置。"}`);
        failure.code = code;
        failure.attempts = attempt;
        throw failure;
      }
      if (!response.ok || data?.success === false) {
        const detail = data?.errors?.map((item) => item.message).join("; ") || data?.message || ([401, 403].includes(response.status) ? "请检查 Token 权限" : "API 未返回错误详情");
        const error = new Error(`${description} 失败（${response.status}）：${detail}`);
        error.status = response.status;
        error.apiErrors = Array.isArray(data?.errors) ? data.errors : [];
        throw error;
      }
      if (!data || typeof data !== "object") throw new Error(`${label} 返回了无效的响应（${response.status}）。`);
      return label === "Cloudflare" ? data.result : data;
    }
  };
}
