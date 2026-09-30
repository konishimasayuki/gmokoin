import { requireAuth, sendError } from "./_lib/auth.js";
import { ensureLevels } from "./_lib/levels.js";
import { K, redis } from "./_lib/redis.js";
import { mergeConfig, portfolioOf } from "./_lib/util.js";

// 監視中の全銘柄の水平線マップを用意する
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const cfg = mergeConfig(await redis.get(K.config));
    const force = req.method === "POST" && Boolean(req.body?.force);
    const symbols = portfolioOf(cfg).map((p) => p.symbol);
    if (!symbols.length) symbols.push(cfg.symbol);
    const results = await Promise.all(
      symbols.map((s) => ensureLevels(s, { force }).catch(() => null)),
    );
    const focus = req.body?.focus || req.query?.focus || symbols[0];
    const idx = Math.max(0, symbols.indexOf(focus));
    return res.status(200).json({ levels: results[idx], count: results.filter(Boolean).length });
  } catch (e) {
    return sendError(res, e, 502);
  }
}
