import { requireAuth, sendError } from "./_lib/auth.js";
import { K, getTrades, redis } from "./_lib/redis.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const n = Math.min(200, Math.max(1, Number(req.query?.n) || 100));
    const [trades, stats] = await Promise.all([getTrades(n), redis.get(K.stats)]);
    return res.status(200).json({ trades, stats });
  } catch (e) {
    return sendError(res, e);
  }
}
