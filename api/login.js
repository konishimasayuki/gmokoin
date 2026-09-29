import { checkPasscode, clearAuthCookie, isAuthed, sendError, setAuthCookie } from "./_lib/auth.js";

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res
        .status(200)
        .json({ authed: isAuthed(req), configured: Boolean(process.env.APP_PASSCODE) });
    }
    if (req.method === "POST") {
      if (!process.env.APP_PASSCODE) {
        return res
          .status(500)
          .json({ error: "APP_PASSCODE が未設定です（Vercelの環境変数に設定してください）" });
      }
      const pass = req.body?.passcode;
      if (!checkPasscode(pass)) return res.status(401).json({ error: "パスコードが違います" });
      setAuthCookie(res);
      return res.status(200).json({ ok: true });
    }
    if (req.method === "DELETE") {
      clearAuthCookie(res);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: "Method Not Allowed" });
  } catch (e) {
    return sendError(res, e);
  }
}
