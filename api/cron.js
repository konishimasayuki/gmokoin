import { finalizeWW, optimizeSymbolWW } from "./_lib/optww.js";
import { K, addLog, redis } from "./_lib/redis.js";
import { SYMBOLS, mergeConfig } from "./_lib/util.js";

// 毎朝の自動検証（Vercel Cron）。前日までのデータを取り込み、クロユキWWの検証を済ませておく
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const okAuth = secret
    ? req.headers.authorization === `Bearer ${secret}`
    : String(req.headers["user-agent"] || "").startsWith("vercel-cron");
  if (!okAuth) return res.status(401).json({ error: "unauthorized" });
  const started = Date.now();
  const cfg = mergeConfig(await redis.get(K.config));
  if ((cfg.optStrategies || ["ww"]).join(",") !== "ww")
    return res.status(200).json({ skipped: true });
  const done = [];
  for (const s of SYMBOLS) {
    if (Date.now() - started > 230000) break; // 時間切れ前に止める（残りは画面から実行した時に計算）
    try {
      const r = await optimizeSymbolWW(s);
      done.push({ symbol: s, cached: Boolean(r.cached), error: r.error || null });
    } catch (e) {
      done.push({ symbol: s, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const fin = await finalizeWW({ apply: false });
  await addLog(`毎朝の自動検証：${done.length}/${SYMBOLS.length}銘柄を準備しました`, "regime");
  return res.status(200).json({
    done,
    pool: fin.wwPool ? { passed: fin.wwPool.passed, trades: fin.wwPool.full.trades } : null,
  });
}
