import { requireAuth, sendError } from "./_lib/auth.js";
import { manualClose } from "./_lib/engine.js";
import { SYMBOLS } from "./_lib/util.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  const symbol = req.body?.symbol;
  if (!SYMBOLS.includes(symbol)) return res.status(400).json({ error: "銘柄を指定してください" });
  try {
    return res.status(200).json(await manualClose(symbol));
  } catch (e) {
    return sendError(res, e, 409);
  }
}
