import { requireAuth, sendError } from "./_lib/auth.js";
import { riskLockState } from "./_lib/engine.js";
import { K, addLog, redis } from "./_lib/redis.js";
import {
  BOOLEAN_KEYS,
  NUMERIC_LIMITS,
  RISK_UP_KEYS,
  SYMBOLS,
  clamp,
  mergeConfig,
} from "./_lib/util.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const cur = mergeConfig(await redis.get(K.config));
    if (req.method === "GET") {
      return res.status(200).json({ config: cur, symbols: SYMBOLS, lock: await riskLockState() });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const body = req.body || {};
    const next = { ...cur, sessions: { ...cur.sessions } };
    for (const [key, [lo, hi]] of Object.entries(NUMERIC_LIMITS)) {
      if (body[key] === undefined || body[key] === "") continue;
      const v = Number(body[key]);
      if (!Number.isFinite(v)) return res.status(400).json({ error: `${key} の値が不正です` });
      next[key] = clamp(v, lo, hi);
    }
    for (const k of ["units", "maxTradesPerDay", "tickSec", "maxUnits", "lossStreakMax"])
      next[k] = Math.round(next[k]);
    if (next.slMinPips > next.slMaxPips)
      return res.status(400).json({ error: "損切り幅の下限が上限を超えています" });
    for (const k of BOOLEAN_KEYS) if (typeof body[k] === "boolean") next[k] = body[k];
    if (body.sessions && typeof body.sessions === "object") {
      for (const s of ["tokyo", "london", "ny"])
        if (typeof body.sessions[s] === "boolean") next.sessions[s] = body.sessions[s];
    }
    if (["fixed", "risk"].includes(body.sizingMode)) next.sizingMode = body.sizingMode;
    if ([1, 5].includes(Number(body.signalTf))) next.signalTf = Number(body.signalTf);
    if (["auto", "manual"].includes(body.symbolMode)) next.symbolMode = body.symbolMode;
    if (next.symbolMode === "manual") next.autoBlocked = false;

    // 損失中・連敗中はリスクを増やす変更をロック（感情で設定をいじる事故を防ぐ）
    const riskUp =
      RISK_UP_KEYS.some((k) => Number(next[k]) > Number(cur[k])) ||
      (next.sizingMode === "risk" && cur.sizingMode !== "risk");
    if (riskUp) {
      const lock = await riskLockState();
      if (lock.locked) {
        return res.status(423).json({
          error: `${lock.why}、リスクを増やす変更はロック中です（翌取引日の6時以降に変更できます）`,
        });
      }
    }

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
    const changed = Object.keys(next).filter(
      (k) =>
        !["running", "symbol"].includes(k) && JSON.stringify(next[k]) !== JSON.stringify(cur[k]),
    );
    if (changed.length) await addLog(`設定を変更：${changed.join(", ")}`);
    return res.status(200).json({ config: next, symbols: SYMBOLS, lock: await riskLockState() });
  } catch (e) {
    return sendError(res, e);
  }
}
