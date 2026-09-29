import { requireAuth, sendError } from "./_lib/auth.js";
import { SYMBOLS, finalizeOptimize, optimizeSymbol } from "./_lib/optimize.js";
import { K, redis } from "./_lib/redis.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    if (req.method === "GET") {
      return res.status(200).json({ result: await redis.get(K.optimizeLast), symbols: SYMBOLS });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    const body = req.body || {};
    if (body.action === "symbol") {
      if (!SYMBOLS.includes(body.symbol))
        return res.status(400).json({ error: "対応していない銘柄です" });
      return res.status(200).json({ symbolResult: await optimizeSymbol(body.symbol) });
    }
    if (body.action === "finalize") {
      return res
        .status(200)
        .json({ result: await finalizeOptimize({ apply: Boolean(body.apply) }) });
    }
    return res.status(400).json({ error: "action を指定してください" });
  } catch (e) {
    return sendError(res, e, 502);
  }
}
