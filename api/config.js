import { requireAuth, sendError } from "./_lib/auth.js";
import { K, addLog, redis } from "./_lib/redis.js";
import { NUMERIC_LIMITS, SYMBOLS, clamp, mergeConfig } from "./_lib/util.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const cur = mergeConfig(await redis.get(K.config));
    if (req.method === "GET") return res.status(200).json({ config: cur, symbols: SYMBOLS });
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const body = req.body || {};
    const next = { ...cur };
    for (const [key, [lo, hi]] of Object.entries(NUMERIC_LIMITS)) {
      if (body[key] === undefined || body[key] === "") continue;
      const v = Number(body[key]);
      if (!Number.isFinite(v)) return res.status(400).json({ error: `${key} の値が不正です` });
      next[key] = clamp(v, lo, hi);
    }
    next.units = Math.round(next.units);
    next.maxTradesPerDay = Math.round(next.maxTradesPerDay);
    next.tickSec = Math.round(next.tickSec);
    if (next.slMinPips > next.slMaxPips) {
      return res.status(400).json({ error: "損切り幅の下限が上限を超えています" });
    }
    if (typeof body.running === "boolean") next.running = body.running;
    if (typeof body.feeOn === "boolean") next.feeOn = body.feeOn;

    let symbolChanged = false;
    if (body.symbol !== undefined && body.symbol !== cur.symbol) {
      if (!SYMBOLS.includes(body.symbol))
        return res.status(400).json({ error: "対応していない銘柄です" });
      const pos = await redis.get(K.position);
      if (pos) return res.status(409).json({ error: "ポジション保有中は銘柄を変更できません" });
      next.symbol = body.symbol;
      symbolChanged = true;
    }

    await redis.set(K.config, next);
    if (symbolChanged) {
      await redis.del(K.regime, K.lastSignal);
      await addLog(`銘柄を${next.symbol.replace("_", "/")}に変更しました`);
    }
    if (next.running !== cur.running)
      await addLog(next.running ? "自動売買を開始しました" : "自動売買を停止しました");
    return res.status(200).json({ config: next, symbols: SYMBOLS });
  } catch (e) {
    return sendError(res, e);
  }
}
