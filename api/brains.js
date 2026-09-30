import { requireAuth, sendError } from "./_lib/auth.js";
import { BRAINS, MODELS, activeBrainOf, modelOf, shadowBrainsOf } from "./_lib/brains.js";
import { K, redis } from "./_lib/redis.js";
import { mergeConfig } from "./_lib/util.js";

// 脳みその一覧（考え方・プロンプト全文・成績・直近の判断）
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const cfg = mergeConfig(await redis.get(K.config));
    const ids = BRAINS.map((b) => b.id);
    const [stats, shadows, logs] = await Promise.all([
      redis.mget(...ids.map((id) => K.brainStats(id))),
      redis.mget(...ids.map((id) => K.shadow(id))),
      Promise.all(ids.map((id) => redis.lrange(K.brainLog(id), 0, 9))),
    ]);
    const active = activeBrainOf(cfg).id;
    const shadowIds = shadowBrainsOf(cfg).map((b) => b.id);
    const list = BRAINS.map((b, i) => ({
      ...b,
      model: b.kind === "ai" ? modelOf(cfg, b.id).key : null,
      status: b.id === active ? "active" : shadowIds.includes(b.id) ? "shadow" : "off",
      liveStats: stats[i] || null,
      shadowStats: shadows[i]?.stats || null,
      shadowTrades: (shadows[i]?.trades || []).slice(0, 10),
      log: logs[i] || [],
    }));
    return res.status(200).json({
      brains: list,
      models: MODELS,
      active,
      shadows: shadowIds,
      aiAvailable: Boolean(process.env.ANTHROPIC_API_KEY),
      regimeIntervalMin: cfg.regimeIntervalMin,
      shadowIntervalMin: cfg.shadowIntervalMin,
    });
  } catch (e) {
    return sendError(res, e);
  }
}
