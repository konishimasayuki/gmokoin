import { closedOnly, getCachedKlines, getTickers } from "./gmo.js";
import { computeScalpIndicators } from "./indicators.js";
import { K, acquireLock, addLog, getLogs, getTrades, redis } from "./redis.js";
import {
  businessDate,
  clamp,
  jstHM,
  mergeConfig,
  pipSize,
  pnlYen,
  priceDigits,
  quoteToJpy,
  round,
} from "./util.js";

export const EMPTY_DAILY = { pnl: 0, trades: 0, wins: 0 };
export const EMPTY_STATS = { net: 0, trades: 0, wins: 0, grossWin: 0, grossLoss: 0, fees: 0 };

const SIDE_JP = { BUY: "買い", SELL: "売り" };
const MIN = 60000;

export function regimeFreshness(regime, cfg, now) {
  if (!regime) return { stale: true, expired: true };
  const age = now - regime.at;
  const iv = cfg.regimeIntervalMin * MIN;
  return { stale: age >= iv, expired: age >= iv * 2 };
}

function no(why, waiting = false) {
  return { ok: false, why, waiting };
}

// ---- 決済
async function closeTrade({ pos, exit, reason, closedAt, cfg, conv, daily, stats }) {
  const pip = pipSize(pos.symbol);
  const dir = pos.side === "BUY" ? 1 : -1;
  const pips = round((dir * (exit - pos.entry)) / pip, 1);
  const gross = round(pnlYen(pos.side, pos.entry, exit, pos.units, conv), 0);
  const fee = cfg.feeOn ? round(cfg.feePerUnit * pos.units * 2, 0) : 0;
  const net = gross - fee;
  const bd = businessDate(closedAt);
  const trade = {
    id: pos.id,
    symbol: pos.symbol,
    side: pos.side,
    units: pos.units,
    entry: pos.entry,
    exit,
    sl: pos.sl,
    tp: pos.tp,
    setup: pos.setup,
    regimeMode: pos.regimeMode,
    openedAt: pos.openedAt,
    closedAt,
    reason,
    pips,
    gross,
    fee,
    net,
  };
  const nd = {
    pnl: daily.pnl + net,
    trades: daily.trades + 1,
    wins: daily.wins + (net > 0 ? 1 : 0),
  };
  const ns = {
    net: stats.net + net,
    trades: stats.trades + 1,
    wins: stats.wins + (net > 0 ? 1 : 0),
    grossWin: stats.grossWin + (net > 0 ? net : 0),
    grossLoss: stats.grossLoss + (net < 0 ? -net : 0),
    fees: stats.fees + fee,
  };
  const p = redis
    .pipeline()
    .set(K.trade(pos.id), trade, { ex: 60 * 60 * 24 * 120 })
    .lpush(K.tradeIds, pos.id)
    .ltrim(K.tradeIds, 0, 499)
    .set(K.daily(bd), nd, { ex: 60 * 60 * 24 * 30 })
    .sadd(K.dailyKeys, K.daily(bd))
    .set(K.stats, ns)
    .del(K.position);
  if (cfg.cooldownSec >= 1) p.set(K.cooldown, closedAt, { ex: Math.round(cfg.cooldownSec) });
  await p.exec();
  const sign = net >= 0 ? "+" : "";
  await addLog(
    `${SIDE_JP[pos.side]}決済（${reason}）${sign}${pips}pips / ${sign}${net.toLocaleString("ja-JP")}円`,
    net >= 0 ? "win" : "loss",
  );
  return { trade, daily: nd, stats: ns };
}

// ---- 画面を閉じていた間の値動きを1分足で検証（損切り優先の保守的判定）
function scanCandles(pos, candles) {
  const spread = pos.spreadPrice || 0;
  const timeStopTs = pos.openedAt + (pos.timeStopMin || 15) * MIN;
  let scanFrom = pos.scanFrom;
  for (const c of candles) {
    if (c.t < scanFrom) continue;
    scanFrom = c.t + MIN;
    if (c.t >= timeStopTs) {
      const exit = pos.side === "BUY" ? c.o : c.o + spread;
      return { hit: { exit, reason: "時間切れ（1分足で判定）", at: c.t }, scanFrom };
    }
    if (pos.side === "BUY") {
      if (c.l <= pos.sl)
        return { hit: { exit: pos.sl, reason: "損切り（1分足で判定）", at: c.t }, scanFrom };
      if (c.h >= pos.tp)
        return { hit: { exit: pos.tp, reason: "利確（1分足で判定）", at: c.t }, scanFrom };
    } else {
      if (c.h + spread >= pos.sl)
        return { hit: { exit: pos.sl, reason: "損切り（1分足で判定）", at: c.t }, scanFrom };
      if (c.l + spread <= pos.tp)
        return { hit: { exit: pos.tp, reason: "利確（1分足で判定）", at: c.t }, scanFrom };
    }
  }
  return { hit: null, scanFrom };
}

function liveCheck(pos, t, now) {
  const price = pos.side === "BUY" ? t.bid : t.ask;
  if (pos.side === "BUY") {
    if (price <= pos.sl) return { exit: price, reason: "損切り" };
    if (price >= pos.tp) return { exit: price, reason: "利確" };
  } else {
    if (price >= pos.sl) return { exit: price, reason: "損切り" };
    if (price <= pos.tp) return { exit: price, reason: "利確" };
  }
  if (now - pos.openedAt >= (pos.timeStopMin || 15) * MIN)
    return { exit: price, reason: "時間切れ" };
  return null;
}

// ---- エントリー判定（Claudeの方針の範囲内でだけ、ルールで入る）
function evaluateEntry({
  cfg,
  regime,
  fresh,
  t,
  market,
  daily,
  cooldownActive,
  lastSignal,
  candles,
  ind,
  now,
}) {
  const pip = pipSize(cfg.symbol);
  if (t.status !== "OPEN") return no("市場クローズ中");
  if (!regime) return no("Claudeの相場判定待ち");
  if (fresh.expired) return no("相場判定が古いため待機");
  if (regime.mode === "NO_TRADE" || regime.allow === "NONE")
    return no(`Claude判定：見送り${regime.summary ? `（${regime.summary}）` : ""}`);
  if (regime.pauseUntilTs && now < regime.pauseUntilTs)
    return no(`${jstHM(regime.pauseUntilTs)}まで停止（Claude指示）`);
  const buf = cfg.eventBufferMin * MIN;
  const ev = (regime.events || []).find(
    (e) => e.ts && e.impact !== "low" && Math.abs(now - e.ts) <= buf,
  );
  if (ev) return no(`指標前後のため停止：${ev.time_jst} ${ev.name}`);
  if (cfg.dailyLossLimit > 0 && daily.pnl <= -cfg.dailyLossLimit) return no("日次損失上限に到達");
  if (daily.trades >= cfg.maxTradesPerDay) return no("本日の取引回数上限");
  if (cooldownActive) return no("決済後のクールダウン中");
  const regimeSpread =
    Number(regime.max_spread_pips) > 0 ? Number(regime.max_spread_pips) : Number.POSITIVE_INFINITY;
  const maxSp = Math.min(cfg.maxSpreadPips, regimeSpread);
  if (market.spreadPips > maxSp) return no(`スプレッド拡大（${market.spreadPips}pips）`);

  const L = candles.length - 1;
  if (L < 60) return no("1分足データ不足");
  const a = ind.atr14[L];
  const aPips = a / pip;
  if (aPips < cfg.minAtrPips) return no(`値動きが小さい（ATR ${round(aPips, 1)}pips）`);
  if (aPips > cfg.maxAtrPips) return no(`値動きが荒い（ATR ${round(aPips, 1)}pips）`);
  const c = candles[L];
  if (lastSignal && Number(lastSignal) === c.t) return no("同じ足では再エントリーしない");

  const e9 = ind.ema9[L];
  const e21 = ind.ema21[L];
  const e9prev = ind.ema9[L - 3];
  const r = ind.rsi7[L];
  const bb = ind.bb[L];
  const allowLong = regime.allow === "LONG" || regime.allow === "BOTH";
  const allowShort = regime.allow === "SHORT" || regime.allow === "BOTH";
  let side = null;
  let setup = "";

  if (regime.mode === "TREND_UP" && allowLong) {
    if (
      e9 > e21 &&
      e9 > e9prev &&
      c.l <= e9 + 0.2 * a &&
      c.c > e9 &&
      r >= 45 &&
      r <= 72 &&
      t.bid > c.c
    ) {
      side = "BUY";
      setup = "押し目買い";
    }
  } else if (regime.mode === "TREND_DOWN" && allowShort) {
    if (
      e9 < e21 &&
      e9 < e9prev &&
      c.h >= e9 - 0.2 * a &&
      c.c < e9 &&
      r >= 28 &&
      r <= 55 &&
      t.bid < c.c
    ) {
      side = "SELL";
      setup = "戻り売り";
    }
  } else if (regime.mode === "RANGE" && bb) {
    if (allowLong && c.l <= bb.lo && r < 30 && c.c > c.o) {
      side = "BUY";
      setup = "レンジ下限の反発";
    } else if (allowShort && c.h >= bb.up && r > 70 && c.c < c.o) {
      side = "SELL";
      setup = "レンジ上限の反落";
    }
  }
  if (!side) return no("シグナル待ち", true);
  return { ok: true, side, setup, atr: a, lastT: c.t };
}

async function openPosition({ ev, cfg, t, regime, now }) {
  const pip = pipSize(cfg.symbol);
  const d = priceDigits(cfg.symbol);
  const entry = round(ev.side === "BUY" ? t.ask : t.bid, d);
  const slDist = clamp(ev.atr * cfg.slAtrMult, cfg.slMinPips * pip, cfg.slMaxPips * pip);
  const sl = round(ev.side === "BUY" ? entry - slDist : entry + slDist, d);
  const tp = round(ev.side === "BUY" ? entry + slDist * cfg.rr : entry - slDist * cfg.rr, d);
  const pos = {
    id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    symbol: cfg.symbol,
    side: ev.side,
    units: cfg.units,
    entry,
    sl,
    tp,
    openedAt: now,
    scanFrom: Math.floor(now / MIN) * MIN + MIN,
    spreadPrice: t.ask - t.bid,
    setup: ev.setup,
    regimeMode: regime?.mode || null,
    timeStopMin: cfg.timeStopMin,
  };
  await redis.pipeline().set(K.position, pos).set(K.lastSignal, ev.lastT, { ex: 3600 }).exec();
  await addLog(
    `${SIDE_JP[ev.side]}エントリー（${ev.setup}）@${entry.toFixed(d)} 損切${sl.toFixed(d)} 利確${tp.toFixed(d)}`,
    "entry",
  );
  return pos;
}

function withUnrealized(pos, t, cfg, conv) {
  if (!pos || !t) return pos;
  const price = pos.side === "BUY" ? t.bid : t.ask;
  const pip = pipSize(pos.symbol);
  const dir = pos.side === "BUY" ? 1 : -1;
  const fee = cfg.feeOn ? cfg.feePerUnit * pos.units * 2 : 0;
  return {
    ...pos,
    price,
    pips: round((dir * (price - pos.entry)) / pip, 1),
    yen: round(pnlYen(pos.side, pos.entry, price, pos.units, conv) - fee, 0),
  };
}

export async function runTick({ full = false } = {}) {
  const now = Date.now();
  const [storedCfg, regime, position, storedStats, cooldown, lastSignal] = await redis.mget(
    K.config,
    K.regime,
    K.position,
    K.stats,
    K.cooldown,
    K.lastSignal,
  );
  const cfg = mergeConfig(storedCfg);
  const bd = businessDate(now);
  const [tickers, raw, dailyRaw] = await Promise.all([
    getTickers(),
    getCachedKlines(cfg.symbol, "1min", now),
    redis.get(K.daily(bd)),
  ]);
  const t = tickers[cfg.symbol];
  if (!t) throw new Error(`${cfg.symbol}のレートを取得できません`);
  const conv = quoteToJpy(cfg.symbol, tickers) ?? 1;
  const pip = pipSize(cfg.symbol);
  const market = {
    bid: t.bid,
    ask: t.ask,
    spreadPips: round((t.ask - t.bid) / pip, 1),
    status: t.status,
    ts: t.ts,
  };
  const candles = closedOnly(raw, "1min", now);
  const ind = computeScalpIndicators(candles);
  const fresh = regimeFreshness(regime, cfg, now);
  let daily = { ...EMPTY_DAILY, ...(dailyRaw || {}) };
  let stats = { ...EMPTY_STATS, ...(storedStats || {}) };
  let pos = position;
  let closed = null;
  let decision = { state: "idle", text: "停止中（新規エントリーはしません）" };

  const locked = await acquireLock(K.tickLock, 8);
  if (locked) {
    try {
      if (pos) {
        const scan = scanCandles(pos, candles);
        let hit = scan.hit;
        let at = hit?.at ?? now;
        if (!hit && t.status === "OPEN") {
          hit = liveCheck(pos, t, now);
          at = now;
        }
        if (hit) {
          const r = await closeTrade({
            pos,
            exit: hit.exit,
            reason: hit.reason,
            closedAt: Math.max(at, pos.openedAt),
            cfg,
            conv,
            daily,
            stats,
          });
          closed = r.trade;
          daily = r.daily;
          stats = r.stats;
          pos = null;
        } else if (scan.scanFrom !== pos.scanFrom) {
          pos = { ...pos, scanFrom: scan.scanFrom };
          await redis.set(K.position, pos);
        }
      }

      if (pos) {
        decision = {
          state: "holding",
          text: `${SIDE_JP[pos.side]}ポジション保有中（${pos.setup}）`,
        };
      } else if (cfg.running) {
        const ev = evaluateEntry({
          cfg,
          regime,
          fresh,
          t,
          market,
          daily,
          cooldownActive: Boolean(cooldown) || Boolean(closed),
          lastSignal,
          candles,
          ind,
          now,
        });
        if (ev.ok) {
          pos = await openPosition({ ev, cfg, t, regime, now });
          decision = { state: "entered", text: `${SIDE_JP[ev.side]}エントリー（${ev.setup}）` };
        } else {
          decision = { state: ev.waiting ? "watching" : "blocked", text: ev.why };
        }
      }
    } finally {
      await redis.del(K.tickLock);
    }
  } else {
    decision = { state: "busy", text: "別の処理が実行中" };
  }

  const L = candles.length - 1;
  const n = 90;
  const from = Math.max(0, candles.length - n);
  const snap = {
    now,
    symbol: cfg.symbol,
    digits: priceDigits(cfg.symbol),
    config: cfg,
    market,
    regime,
    regimeStale: fresh.stale,
    position: withUnrealized(pos, t, cfg, conv),
    closed,
    daily,
    stats,
    decision,
    watch:
      L >= 0
        ? {
            ema9: ind.ema9[L],
            ema21: ind.ema21[L],
            rsi7: ind.rsi7[L] === null ? null : round(ind.rsi7[L], 1),
            atrPips: ind.atr14[L] === null ? null : round(ind.atr14[L] / pip, 2),
          }
        : null,
    chart: {
      candles: candles.slice(from),
      ema9: ind.ema9.slice(from),
      ema21: ind.ema21.slice(from),
    },
  };
  if (full || closed) {
    const [trades, logs] = await Promise.all([getTrades(30), getLogs(30)]);
    snap.trades = trades;
    snap.logs = logs;
  }
  return snap;
}

export async function manualClose() {
  const now = Date.now();
  const ok = await acquireLock(K.tickLock, 8, 10, 300);
  if (!ok) throw new Error("処理中です。少し待ってからもう一度押してください");
  try {
    const [storedCfg, pos, storedStats] = await redis.mget(K.config, K.position, K.stats);
    if (!pos) return { closed: null };
    const cfg = mergeConfig(storedCfg);
    const tickers = await getTickers();
    const t = tickers[pos.symbol];
    if (!t || t.status !== "OPEN") throw new Error("市場クローズ中のため決済できません");
    const exit = pos.side === "BUY" ? t.bid : t.ask;
    const dailyRaw = await redis.get(K.daily(businessDate(now)));
    const r = await closeTrade({
      pos,
      exit,
      reason: "手動決済",
      closedAt: now,
      cfg,
      conv: quoteToJpy(pos.symbol, tickers) ?? 1,
      daily: { ...EMPTY_DAILY, ...(dailyRaw || {}) },
      stats: { ...EMPTY_STATS, ...(storedStats || {}) },
    });
    return { closed: r.trade };
  } finally {
    await redis.del(K.tickLock);
  }
}

export async function resetPaper() {
  const ok = await acquireLock(K.tickLock, 8, 10, 300);
  if (!ok) throw new Error("処理中です。少し待ってからもう一度押してください");
  try {
    const ids = await redis.lrange(K.tradeIds, 0, -1);
    const dailyKeys = await redis.smembers(K.dailyKeys);
    const keys = [
      K.position,
      K.stats,
      K.tradeIds,
      K.cooldown,
      K.lastSignal,
      K.logs,
      K.dailyKeys,
      ...ids.map((id) => K.trade(id)),
      ...dailyKeys,
    ];
    for (let i = 0; i < keys.length; i += 200) await redis.del(...keys.slice(i, i + 200));
    await addLog("ペーパー口座をリセットしました");
    return { ok: true };
  } finally {
    await redis.del(K.tickLock);
  }
}
