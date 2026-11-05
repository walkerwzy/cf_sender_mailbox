const encoder = new TextEncoder();
const hex = (bytes) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
const awsEncode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const asciiOrder = ([a], [b]) => a < b ? -1 : a > b ? 1 : 0;

export async function sha256(value) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function hmac(key, value) {
  const bytes = typeof key === "string" ? encoder.encode(key) : key;
  const imported = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, encoder.encode(value));
}

export async function presignR2(env, { method, key, createdAt, expires, headers = {} }) {
  const date = new Date(createdAt * 1000).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const path = `/${[env.R2_BUCKET_NAME, ...key.split("/")].map(awsEncode).join("/")}`;
  const signed = Object.entries({ ...headers, host }).map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, " ")]).sort(asciiOrder);
  const signedHeaders = signed.map(([name]) => name).join(";");
  const params = { "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": `${env.R2_ACCESS_KEY_ID}/${scope}`, "X-Amz-Date": date, "X-Amz-Expires": String(expires), "X-Amz-SignedHeaders": signedHeaders };
  const query = Object.entries(params).map(([name, value]) => [awsEncode(name), awsEncode(value)]).sort(asciiOrder).map(([name, value]) => `${name}=${value}`).join("&");
  const canonical = [method, path, query, signed.map(([name, value]) => `${name}:${value}\n`).join(""), signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", date, scope, await sha256(canonical)].join("\n");
  const dayKey = await hmac(`AWS4${env.R2_SECRET_ACCESS_KEY}`, day);
  const regionKey = await hmac(dayKey, "auto");
  const serviceKey = await hmac(regionKey, "s3");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, toSign));
  return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}
