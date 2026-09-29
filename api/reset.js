import { requireAuth, sendError } from "./_lib/auth.js";
import { resetPaper } from "./_lib/engine.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  if (req.body?.confirm !== "RESET")
    return res.status(400).json({ error: "確認文字列が一致しません" });
  try {
    return res.status(200).json(await resetPaper());
  } catch (e) {
    return sendError(res, e, 409);
  }
}
