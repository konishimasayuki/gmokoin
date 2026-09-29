import { requireAuth, sendError } from "./_lib/auth.js";
import { runBacktest } from "./_lib/backtest.js";
import { K, redis } from "./_lib/redis.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    if (req.method === "GET")
      return res.status(200).json({ result: await redis.get(K.backtestLast) });
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    const days = Math.min(20, Math.max(1, Math.round(Number(req.body?.days) || 5)));
    return res
      .status(200)
      .json({ result: await runBacktest({ days, spreadPips: req.body?.spreadPips }) });
  } catch (e) {
    return sendError(res, e, 502);
  }
}
