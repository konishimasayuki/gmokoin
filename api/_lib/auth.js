import crypto from "node:crypto";

const COOKIE = "fxbot_auth";
const MAX_AGE = 60 * 60 * 24 * 30;

function expectedToken() {
  const pass = process.env.APP_PASSCODE || "";
  return crypto.createHmac("sha256", pass).update("fxbot-session-v1").digest("hex");
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function isAuthed(req) {
  if (!process.env.APP_PASSCODE) return false;
  const t = parseCookies(req.headers.cookie)[COOKIE];
  return Boolean(t) && safeEqual(t, expectedToken());
}

export function checkPasscode(input) {
  const pass = process.env.APP_PASSCODE;
  if (!pass) return false;
  return safeEqual(input || "", pass);
}

export function setAuthCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${expectedToken()}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`,
  );
}

export function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

export function requireAuth(req, res) {
  if (isAuthed(req)) return true;
  res.status(401).json({ error: "ログインが必要です" });
  return false;
}

export function sendError(res, e, status = 500) {
  res.status(status).json({ error: e instanceof Error ? e.message : String(e) });
}
