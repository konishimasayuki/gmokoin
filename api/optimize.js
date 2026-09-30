import { requireAuth, sendError } from "./_lib/auth.js";
import { SYMBOLS, finalizeOptimize, optimizeSymbol } from "./_lib/optimize.js";
import { finalizeWW, optimizeSymbolWW } from "./_lib/optww.js";
import { K, redis } from "./_lib/redis.js";
import { mergeConfig } from "./_lib/util.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    if (req.method === "GET") {
      const last = await redis.get(K.optimizeLast);
      return res.status(200).json({ result: last?.rule?.weekWin ? last : null, symbols: SYMBOLS });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    const body = req.body || {};
    // 検証する手法（既定はクロユキWWのみ）
    const cfg = mergeConfig(await redis.get(K.config));
    const wwOnly = (cfg.optStrategies || ["ww"]).join(",") === "ww";
    if (body.action === "symbol") {
      if (!SYMBOLS.includes(body.symbol))
        return res.status(400).json({ error: "対応していない銘柄です" });
      return res.status(200).json({
        symbolResult: await (wwOnly ? optimizeSymbolWW : optimizeSymbol)(body.symbol, {
          force: Boolean(body.force),
        }),
      });
    }
    if (body.action === "finalize") {
      return res.status(200).json({
        result: await (wwOnly ? finalizeWW : finalizeOptimize)({ apply: Boolean(body.apply) }),
      });
    }
    return res.status(400).json({ error: "action を指定してください" });
  } catch (e) {
    return sendError(res, e, 502);
  }
}
