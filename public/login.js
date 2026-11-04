const form = document.getElementById("login-form");
const email = document.getElementById("login-email");
const password = document.getElementById("login-password");
const button = document.getElementById("login-submit");
const notice = document.getElementById("login-notice");
let submitting = false;

function showError(message) { notice.textContent = message; notice.hidden = false; }

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitting || !form.reportValidity()) return;
  submitting = true;
  button.disabled = true;
  button.textContent = "正在登录…";
  notice.hidden = true;
  try {
    const response = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email.value, password: password.value }), signal: AbortSignal.timeout(10000) });
    if (response.redirected || !response.headers.get("content-type")?.includes("application/json")) throw new Error("登录入口尚未更新，请确认部署已完成。");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "登录失败，请重试。");
    password.value = "";
    window.location.replace("/");
  } catch (error) {
    showError(error.name === "TimeoutError" || error.name === "TypeError" ? "登录请求未完成，请稍后重试。" : error.message);
    submitting = false;
    button.disabled = false;
    button.textContent = "密码登录";
  }
});

async function init() {
  try {
    const response = await fetch("/api/login-options", { signal: AbortSignal.timeout(10000) });
    if (response.redirected || !response.headers.get("content-type")?.includes("application/json")) throw new Error("登录入口尚未更新，请确认部署已完成。");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法读取登录配置。");
    email.replaceChildren(...data.emails.map((address) => new Option(address, address)));
    document.getElementById("password-hint").textContent = `密码为固定前缀 + ${data.dateSuffix}（今日 MMDD，按北京时间计算）。`;
    document.getElementById("access-login").href = data.accessUrl;
    email.disabled = false;
    password.disabled = false;
    button.disabled = false;
  } catch (error) {
    showError(error.name === "TimeoutError" || error.name === "TypeError" ? "登录配置暂时无法读取，请刷新页面重试。" : error.message);
  }
}

init();
