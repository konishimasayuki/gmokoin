// 過去の1分足でルールを再生する（相場判定はClaudeの代わりに1時間足の機械判定を使う）
import { getKlines, getTickers } from "./gmo.js";
import { computeScalpIndicators } from "./indicators.js";
import { K, redis } from "./redis.js";
import {
  SESSIONS,
  aggregate,
  buildHtf,
  buildMechanicalRegime,
  htfDirAt,
  sessionOf,
  signalAt,
  sizeUnits,
  slTp,
  stepCandle,
} from "./strategy.js";
import {
  businessDate,
  mergeConfig,
  pipSize,
  pnlYen,
  priceDigits,
  quoteToJpy,
  round,
} from "./util.js";

const MIN = 60000;
const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// GMOコインの一般的なスプレッドの目安（pips）。実際はそれより広がる時間帯もある
export const DEFAULT_SPREAD = {
  USD_JPY: 0.2,
  EUR_JPY: 0.5,
  GBP_JPY: 1.0,
  AUD_JPY: 0.7,
  EUR_USD: 0.3,
  GBP_USD: 0.9,
};

async function dayCandles(symbol, bd, today) {
  const key = K.btDay(symbol, bd);
  if (bd !== today) {
    const cached = await redis.get(key);
    if (Array.isArray(cached)) return cached;
  }
  let data = [];
  for (let i = 0; i < 2; i++) {
    try {
      data = await getKlines(symbol, "1min", bd);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  if (data.length && bd !== today) await redis.set(key, data, { ex: 60 * 60 * 24 * 10 });
  return data;
}

export async function loadCandles(symbol, days, now) {
  const today = businessDate(now);
  const dates = [];
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

// 設定に依存しない下ごしらえ（指標・時間帯・機械判定を一度だけ計算）
export function prepare(candles) {
  const n = candles.length;
  const ind1 = computeScalpIndicators(candles);
  const m5 = aggregate(candles, 5);
  const ind5 = computeScalpIndicators(m5);
  const htf5 = buildHtf(candles, 5);
  const htf15 = buildHtf(candles, 15);
  const mr = buildMechanicalRegime(candles);
  const regime = new Array(n);
  const htfDir1 = new Int8Array(n);
  const htfDir5 = new Int8Array(n);
  const map5 = new Int32Array(n).fill(-1);
  const ses = new Array(n);
  const bd = new Array(n);
  let j = -1;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const endTs = candles[i].t + MIN;
    while (j + 1 < mr.h1.length && mr.h1[j + 1].t + HOUR <= endTs) j++;
    if (j < 0 || mr.e50[j] === null) regime[i] = { mode: "NO_TRADE", allow: "NONE" };
    else {
      const c = mr.h1[j].c;
      if (mr.e20[j] > mr.e50[j] && c > mr.e20[j]) regime[i] = { mode: "TREND_UP", allow: "LONG" };
      else if (mr.e20[j] < mr.e50[j] && c < mr.e20[j])
        regime[i] = { mode: "TREND_DOWN", allow: "SHORT" };
      else regime[i] = { mode: "RANGE", allow: "BOTH" };
    }
    htfDir1[i] = htfDirAt(htf5, endTs);
    if (endTs % (5 * MIN) === 0) {
      const t5 = endTs - 5 * MIN;
      while (k < m5.length && m5[k].t < t5) k++;
      if (k < m5.length && m5[k].t === t5) {
        map5[i] = k;
        htfDir5[i] = htfDirAt(htf15, endTs);
      }
    }
    ses[i] = sessionOf(endTs);
    bd[i] = businessDate(endTs);
  }
  return { candles, ind1, m5, ind5, regime, htfDir1, htfDir5, map5, ses, bd };
}

export function metricsOf(trades, cfg) {
  const n = trades.length;
  let grossWin = 0;
  let grossLoss = 0;
  let wins = 0;
  let pipsSum = 0;
  let eq = 0;
  let peak = 0;
  let maxDd = 0;
  let fees = 0;
  for (const t of trades) {
    if (t.net > 0) {
      grossWin += t.net;
      wins++;
    } else grossLoss -= t.net;
    pipsSum += t.pips;
    eq += t.net;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
    if (cfg.feeOn) fees += cfg.feePerUnit * t.units * 2;
  }
  return {
    trades: n,
    winRate: n ? round((wins / n) * 100, 1) : 0,
    net: round(grossWin - grossLoss, 0),
    pf: grossLoss > 0 ? round(grossWin / grossLoss, 2) : grossWin > 0 ? 99 : 0,
    maxDd: round(maxDd, 0),
    avgWin: wins ? round(grossWin / wins, 0) : 0,
    avgLoss: n - wins ? round(-grossLoss / (n - wins), 0) : 0,
    avgPips: n ? round(pipsSum / n, 2) : 0,
    fees: round(fees, 0),
  };
}

// 設定1つ分のシミュレーション
export function simulate(prep, cfg, { spread, conv, pip, digits, fromTs, toTs }) {
  const { candles, ind1, m5, ind5, regime, htfDir1, htfDir5, map5, ses, bd } = prep;
  const tf = cfg.signalTf === 5 ? 5 : 1;
  const trades = [];
  let pos = null;
  let equity = cfg.paperBalance;
  let lastCloseAt = 0;
  let losses = 0;
  let pauseUntil = 0;
  let lastSignalT = null;
  const daily = {};
  const n = candles.length;
  for (let i = 60; i < n - 1; i++) {
    const c = candles[i];
    if (c.t >= toTs) break;
    if (pos) {
      const r = stepCandle(pos, c, spread);
      if (r.hit) {
        const dir = pos.side === "BUY" ? 1 : -1;
        const pips = round((dir * (r.hit.exit - pos.entry)) / pip, 1);
        const fee = cfg.feeOn ? cfg.feePerUnit * pos.units * 2 : 0;
        const net = round(pnlYen(pos.side, pos.entry, r.hit.exit, pos.units, conv) - fee, 0);
        const closedAt = c.t + MIN;
        trades.push({ ...pos, exit: r.hit.exit, reason: r.hit.reason, closedAt, pips, net });
        equity += net;
        const d = bd[i];
        daily[d] ||= { pnl: 0, trades: 0 };
        daily[d].pnl += net;
        daily[d].trades++;
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
    if (c.t < fromTs) continue;
    const sk = ses[i];
    if (!sk || !cfg.sessions[sk]) continue;
    const endTs = c.t + MIN;
    if (endTs < pauseUntil || endTs - lastCloseAt < cfg.cooldownSec * 1000) continue;
    const d = daily[bd[i]];
    if (d && cfg.dailyLossLimit > 0 && d.pnl <= -cfg.dailyLossLimit) continue;
    if (d && d.trades >= cfg.maxTradesPerDay) continue;
    const reg = regime[i];
    if (reg.mode === "NO_TRADE") continue;

    let sc;
    let si;
    let L;
    let hd;
    if (tf === 5) {
      L = map5[i];
      if (L < 60) continue;
      sc = m5;
      si = ind5;
      hd = htfDir5[i];
    } else {
      L = i;
      sc = candles;
      si = ind1;
      hd = htfDir1[i];
    }
    const a = si.atr14[L];
    if (a === null) continue;
    const aPips = a / pip;
    if (aPips < cfg.minAtrPips || aPips > cfg.maxAtrPips) continue;
    if (lastSignalT === sc[L].t) continue;
    const next = candles[i + 1];
    const sig = signalAt({
      mode: reg.mode,
      allow: reg.allow,
      candles: sc,
      ind: si,
      L,
      confirm: next.o,
      cfg,
      htfDir: hd,
    });
    if (!sig) continue;
    const entry = round(sig.side === "BUY" ? next.o + spread : next.o, digits);
    const lv = slTp({ entry, side: sig.side, atr: a, cfg, pip, digits });
    const size = sizeUnits({ cfg, equity, slDist: lv.slDist, conv });
    if (!size.units) continue;
    lastSignalT = sc[L].t;
    pos = {
      side: sig.side,
      setup: sig.setup,
      session: SESSIONS[sk]?.label || "不明",
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
    };
  }
  return trades;
}

export function summarize(trades, key) {
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

export async function marketContext(symbol) {
  const tickers = await getTickers().catch(() => ({}));
  const conv = quoteToJpy(symbol, tickers) ?? (symbol.endsWith("_JPY") ? 1 : 150);
  return { conv, tickers };
}

export async function runBacktest({ days = 5, spreadPips } = {}) {
  const now = Date.now();
  const cfg = mergeConfig(await redis.get(K.config));
  const symbol = cfg.symbol;
  const pip = pipSize(symbol);
  const digits = priceDigits(symbol);
  const spread =
    (Number(spreadPips) > 0 ? Number(spreadPips) : DEFAULT_SPREAD[symbol] || 0.5) * pip;
  const { conv } = await marketContext(symbol);
  const candles = await loadCandles(symbol, days, now);
  if (candles.length < 500) throw new Error("過去データが不足しています");
  const prep = prepare(candles);
  const trades = simulate(prep, cfg, {
    spread,
    conv,
    pip,
    digits,
    fromTs: now - days * DAY,
    toTs: now,
  });
  const metrics = metricsOf(trades, cfg);
  let eq = 0;
  const curveAll = trades.map((t) => {
    eq += t.net;
    return { t: t.closedAt, v: round(eq, 0) };
  });
  const step = Math.max(1, Math.ceil(curveAll.length / 120));
  const result = {
    at: now,
    symbol,
    days,
    spreadPips: round(spread / pip, 2),
    note: "相場判定はClaudeではなく1時間足EMA20/50の機械判定で代用。水平線フィルター・指標停止は未反映。",
    config: {
      signalTf: cfg.signalTf,
      sessions: cfg.sessions,
      beOn: cfg.beOn,
      rr: cfg.rr,
      slAtrMult: cfg.slAtrMult,
    },
    metrics,
    bySession: summarize(trades, "session"),
    bySetup: summarize(trades, "setup"),
    byReason: summarize(trades, "reason"),
    curve: curveAll.filter((_, i) => i % step === 0 || i === curveAll.length - 1),
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
