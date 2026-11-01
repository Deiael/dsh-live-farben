import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/body/biliLogin.ts
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
var TIMEOUT_MS = 1e4;
var HEADERS = { "User-Agent": UA, Referer: "https://www.bilibili.com/" };
async function startQrLogin() {
  const res = await fetch("https://passport.bilibili.com/x/passport-login/web/qrcode/generate", { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.json();
  if (body.code !== 0 || !body.data?.url || !body.data.qrcode_key) throw new Error(`B \u7AD9\u6CA1\u7ED9\u4E8C\u7EF4\u7801\uFF08${body.code} ${body.message ?? ""}\uFF09`);
  return { url: body.data.url, key: body.data.qrcode_key };
}
async function pollQrLogin(key) {
  const res = await fetch(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.json();
  const code = body.data?.code;
  if (body.code !== 0) return { state: "error", message: `B \u7AD9\u8FD4\u56DE ${body.code}` };
  if (code === 86101) return { state: "waiting" };
  if (code === 86090) return { state: "scanned" };
  if (code === 86038) return { state: "expired" };
  if (code !== 0) return { state: "error", message: body.data?.message ?? `B \u7AD9\u8FD4\u56DE ${code}` };
  const jar = /* @__PURE__ */ new Map();
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  if (!jar.get("SESSDATA") || !jar.get("bili_jct")) return { state: "error", message: "\u767B\u5F55\u6210\u529F\u4E86\uFF0C\u4F46 B \u7AD9\u6CA1\u7ED9 SESSDATA / bili_jct" };
  try {
    const spi = await fetch("https://api.bilibili.com/x/frontend/finger/spi", { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const d = (await spi.json()).data;
    if (d?.b_3) jar.set("buvid3", d.b_3);
    if (d?.b_4) jar.set("buvid4", d.b_4);
  } catch {
  }
  return { state: "ok", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
}
async function whoIs(cookie) {
  if (!cookie) return null;
  try {
    const res = await fetch("https://api.bilibili.com/x/web-interface/nav", { headers: { ...HEADERS, Cookie: cookie }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const d = (await res.json()).data;
    return d?.isLogin && d.mid ? { uid: d.mid, name: d.uname ?? "" } : null;
  } catch {
    return null;
  }
}

// src/core/moodText.ts
function splitByMood(text, moods) {
  const parts = [];
  let mood = "talk";
  let last = 0;
  for (const m of text.matchAll(/[[【]\s*([a-zA-Z]+)\s*[\]】]/g)) {
    const name = m[1].toLowerCase();
    if (!moods.includes(name)) continue;
    parts.push({ mood, text: text.slice(last, m.index) });
    mood = name;
    last = m.index + m[0].length;
  }
  parts.push({ mood, text: text.slice(last) });
  return parts.filter((p) => p.text.trim());
}

export {
  startQrLogin,
  pollQrLogin,
  whoIs,
  splitByMood
};
//# sourceMappingURL=chunk-4A2ZZR7B.js.map
