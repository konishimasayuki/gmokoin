// 過去の1分足でルールを再生する（相場判定はClaudeの代わりに1時間足の機械判定を使う）
import { getKlines } from "./gmo.js";
import { computeScalpIndicators } from "./indicators.js";
import { K, redis } from "./redis.js";
import {
  SESSIONS,
  buildHtf,
  buildMechanicalRegime,
  htfDirAt,
  mechanicalRegimeAt,
  sessionAllowed,
  signalAt,
  sizeUnits,
  slTp,
  stepCandle,
} from "./strategy.js";
import { businessDate, mergeConfig, pipSize, pnlYen, priceDigits, round } from "./util.js";

const MIN = 60000;
const DAY = 24 * 3600 * 1000;

export const DEFAULT_SPREAD = {
  USD_JPY: 0.2,
  EUR_JPY: 0.5,
  GBP_JPY: 1.0,
  AUD_JPY: 0.7,
  EUR_USD: 0.3,
  GBP_USD: 0.9,
};
// 決済通貨がUSDのペアを円換算する仮レート（バックテスト用の近似）
const APPROX_USDJPY = 150;

async function dayCandles(symbol, bd, today) {
  const key = K.btDay(symbol, bd);
  if (bd !== today) {
    const cached = await redis.get(key);
    if (Array.isArray(cached)) return cached;
  }
  const data = await getKlines(symbol, "1min", bd).catch(() => []);
  if (data.length && bd !== today) await redis.set(key, data, { ex: 60 * 60 * 24 * 10 });
  return data;
}

async function loadCandles(symbol, days, now) {
  const today = businessDate(now);
  const dates = [];
  // 週末を挟むので多めに遡る（ウォームアップ用に+3日）
  for (let i = days + 5; i >= 0; i--) dates.push(businessDate(now - i * DAY));
  const uniq = [...new Set(dates)];
  const out = [];
  for (let i = 0; i < uniq.length; i += 4) {
    const batch = await Promise.all(uniq.slice(i, i + 4).map((d) => dayCandles(symbol, d, today)));
    for (const arr of batch) out.push(...arr);
  }
  const map = new Map();
  for (const c of out) map.set(c.t, c);
  return [...map.values()].sort((a, b) => a.t - b.t).filter((c) => c.t + MIN <= now);
}

function summarize(trades, key) {
  const g = {};
  for (const t of trades) {
    const k = t[key] || "不明";
    g[k] ||= { trades: 0, wins: 0, net: 0 };
    g[k].trades++;
    if (t.net > 0) g[k].wins++;
    g[k].net += t.net;
  }
  return Object.entries(g).map(([name, v]) => ({
    name,
    ...v,
    net: round(v.net, 0),
    winRate: round((v.wins / v.trades) * 100, 0),
  }));
}

export async function runBacktest({ days = 5, spreadPips } = {}) {
  const now = Date.now();
  const cfg = mergeConfig(await redis.get(K.config));
  const symbol = cfg.symbol;
  const pip = pipSize(symbol);
  const digits = priceDigits(symbol);
  const spread =
    (Number(spreadPips) > 0 ? Number(spreadPips) : DEFAULT_SPREAD[symbol] || 0.5) * pip;
  const conv = symbol.endsWith("_JPY") ? 1 : APPROX_USDJPY;

  const candles = await loadCandles(symbol, days, now);
  if (candles.length < 500) throw new Error("過去データが不足しています");
  const startTs = now - days * DAY;
  const ind = computeScalpIndicators(candles);
  const htf = buildHtf(candles);
  const mr = buildMechanicalRegime(candles);

  const trades = [];
  let pos = null;
  let equity = cfg.paperBalance;
  let peak = equity;
  let maxDd = 0;
  let lastCloseAt = 0;
  let losses = 0;
  let pauseUntil = 0;
  const daily = {};
  const curve = [];
  let lastSignalT = null;

  for (let i = 60; i < candles.length - 1; i++) {
    const c = candles[i];
    if (pos) {
      const r = stepCandle(pos, c, spread);
      if (r.hit) {
        const dir = pos.side === "BUY" ? 1 : -1;
        const pips = round((dir * (r.hit.exit - pos.entry)) / pip, 1);
        const gross = pnlYen(pos.side, pos.entry, r.hit.exit, pos.units, conv);
        const fee = cfg.feeOn ? cfg.feePerUnit * pos.units * 2 : 0;
        const net = round(gross - fee, 0);
        const closedAt = c.t + MIN;
        trades.push({ ...pos, exit: r.hit.exit, reason: r.hit.reason, closedAt, pips, net });
        equity += net;
        peak = Math.max(peak, equity);
        maxDd = Math.max(maxDd, peak - equity);
        curve.push({ t: closedAt, v: round(equity - cfg.paperBalance, 0) });
        const bd = businessDate(closedAt);
        daily[bd] ||= { pnl: 0, trades: 0 };
        daily[bd].pnl += net;
        daily[bd].trades++;
        lastCloseAt = closedAt;
        losses = net < 0 ? losses + 1 : 0;
        if (losses >= cfg.lossStreakMax && cfg.lossStreakPauseMin > 0) {
          pauseUntil = closedAt + cfg.lossStreakPauseMin * MIN;
          losses = 0;
        }
        pos = null;
      }
      continue;
    }
    if (c.t < startTs) continue;
    const endTs = c.t + MIN;
    const ses = sessionAllowed(endTs, cfg);
    if (!ses.ok || endTs < pauseUntil) continue;
    if (endTs - lastCloseAt < cfg.cooldownSec * 1000) continue;
    const d = daily[businessDate(endTs)] || { pnl: 0, trades: 0 };
    if (cfg.dailyLossLimit > 0 && d.pnl <= -cfg.dailyLossLimit) continue;
    if (d.trades >= cfg.maxTradesPerDay) continue;
    if (cfg.rr < cfg.minRr) break;
    const a = ind.atr14[i];
    if (a === null) continue;
    const aPips = a / pip;
    if (aPips < cfg.minAtrPips || aPips > cfg.maxAtrPips) continue;
    if (lastSignalT === c.t) continue;
    const reg = mechanicalRegimeAt(mr, endTs);
    if (reg.mode === "NO_TRADE") continue;
    const next = candles[i + 1];
    const sig = signalAt({
      mode: reg.mode,
      allow: reg.allow,
      candles,
      ind,
      L: i,
      confirm: next.o,
      cfg,
      htfDir: htfDirAt(htf, endTs),
    });
    if (!sig) continue;
    const entry = round(sig.side === "BUY" ? next.o + spread : next.o, digits);
    const lv = slTp({ entry, side: sig.side, atr: a, cfg, pip, digits });
    const size = sizeUnits({ cfg, equity, slDist: lv.slDist, conv });
    if (!size.units) continue;
    lastSignalT = c.t;
    pos = {
      side: sig.side,
      setup: sig.setup,
      session: SESSIONS[ses.key]?.label || "不明",
      units: size.units,
      entry,
      sl: lv.sl,
      tp: lv.tp,
      openedAt: next.t,
      timeStopMin: cfg.timeStopMin,
      beOn: cfg.beOn,
      beTrigger: cfg.beOn ? lv.slDist * cfg.beTriggerR : null,
      beMoved: false,
      pip,
      digits,
      hour: new Date(next.t + 9 * 3600 * 1000).getUTCHours(),
    };
  }

  const n = trades.length;
  const wins = trades.filter((t) => t.net > 0);
  const lossesArr = trades.filter((t) => t.net <= 0);
  const grossWin = wins.reduce((s, t) => s + t.net, 0);
  const grossLoss = -lossesArr.reduce((s, t) => s + t.net, 0);
  const net = grossWin - grossLoss;
  const step = Math.max(1, Math.ceil(curve.length / 120));
  const result = {
    at: now,
    symbol,
    days,
    spreadPips: round(spread / pip, 2),
    note: "相場判定はClaudeではなく1時間足EMA20/50の機械判定で代用。水平線フィルター・指標停止は未反映。",
    config: {
      sessions: cfg.sessions,
      htfFilter: cfg.htfFilter,
      beOn: cfg.beOn,
      rr: cfg.rr,
      slAtrMult: cfg.slAtrMult,
      timeStopMin: cfg.timeStopMin,
      sizingMode: cfg.sizingMode,
    },
    metrics: {
      trades: n,
      winRate: n ? round((wins.length / n) * 100, 1) : 0,
      net: round(net, 0),
      pf: grossLoss > 0 ? round(grossWin / grossLoss, 2) : grossWin > 0 ? 99 : 0,
      maxDd: round(maxDd, 0),
      avgWin: wins.length ? round(grossWin / wins.length, 0) : 0,
      avgLoss: lossesArr.length ? round(-grossLoss / lossesArr.length, 0) : 0,
      avgPips: n ? round(trades.reduce((s, t) => s + t.pips, 0) / n, 2) : 0,
      fees: round(cfg.feeOn ? trades.reduce((s, t) => s + cfg.feePerUnit * t.units * 2, 0) : 0, 0),
    },
    bySession: summarize(trades, "session"),
    bySetup: summarize(trades, "setup"),
    byReason: summarize(trades, "reason"),
    byHour: summarize(
      trades.map((t) => ({ ...t, hourLabel: `${String(t.hour).padStart(2, "0")}時` })),
      "hourLabel",
    ).sort((a, b) => a.name.localeCompare(b.name)),
    curve: curve.filter((_, i) => i % step === 0 || i === curve.length - 1),
    recent: trades
      .slice(-30)
      .reverse()
      .map((t) => ({
        side: t.side,
        setup: t.setup,
        reason: t.reason,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        pips: t.pips,
        net: t.net,
      })),
  };
  await redis.set(K.backtestLast, result, { ex: 60 * 60 * 24 * 30 });
  return result;
}
