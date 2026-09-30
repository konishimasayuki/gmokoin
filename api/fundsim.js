import { requireAuth, sendError } from "./_lib/auth.js";
import { runFundSim } from "./_lib/fundsim.js";

// 資金シミュレーション（本命＋追加候補）
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  try {
    return res.status(200).json({ result: await runFundSim(req.body || {}) });
  } catch (e) {
    return sendError(res, e, 502);
  }
}
