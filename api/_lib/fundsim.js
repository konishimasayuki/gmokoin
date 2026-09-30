// 資金シミュレーション：本命（毎営業日 8:00買い→9:55）と追加候補（ゴトー日・月末 9:55売り→12:00）
// 1万通貨から始めて「利益◯万円ごとに1万通貨追加」。損切りはATR倍率・固定pips・なしから選ぶ
import { DAY, loadBars } from "./backtest.js";
import { isFixDay } from "./flows.js";
import { atr } from "./indicators.js";
import { round } from "./util.js";

const MIN = 60000;
const PIP = 0.01; // ドル円
const jstMin = (ts) => {
  const d = new Date(ts + 9 * 3600000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const ymOf = (ts) => {
  const d = new Date(ts + 9 * 3600000);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

export const STRATS = {
  main: { name: "本命", entryHm: 480, exitHm: 595, side: "BUY", days: "all" },
  add: { name: "追加候補", entryHm: 595, exitHm: 720, side: "SELL", days: "fix" },
};

export async function runFundSim(opts, now = Date.now()) {
  const o = {
    years: Math.min(2, Math.max(0.25, Number(opts.years) || 1)),
    startUnits: Math.max(1000, Math.round(Number(opts.startUnits) || 10000)),
    stepYen: Math.max(0, Number(opts.stepYen) || 100000), // 0なら増やさない
    stepUnits: Math.max(1000, Math.round(Number(opts.stepUnits) || 10000)),
    maxUnits: Math.max(1000, Math.round(Number(opts.maxUnits) || 100000)),
    slMode: ["atr", "pips", "none"].includes(opts.slMode) ? opts.slMode : "atr",
    slValue: Math.max(0, Number(opts.slValue) || 2),
    spreadPips: Math.max(0, Number(opts.spreadPips ?? 0.2)),
    feePerUnit: Math.max(0, Number(opts.feePerUnit ?? 0.002)),
    useMain: opts.useMain !== false,
    useAdd: opts.useAdd !== false,
  };
  const bars = await loadBars("USD_JPY", "5min", Math.ceil(o.years * 365) + 20, now);
  if (bars.length < 1000)
    throw new Error("過去データがありません（先に検証を1回実行してください）");
  const a = atr(bars, 12 * 14);
  const from = now - o.years * 365 * DAY;
  const spread = o.spreadPips * PIP;
  const strats = [o.useMain && "main", o.useAdd && "add"].filter(Boolean);

  let profit = 0;
  let peak = 0;
  let maxDd = 0;
  let units = o.startUnits;
  const unitsNow = () =>
    Math.min(
      o.maxUnits,
      o.startUnits +
        (o.stepYen > 0 ? Math.floor(Math.max(0, profit) / o.stepYen) : 0) * o.stepUnits,
    );
  const ladder = [{ at: null, units }];
  const trades = [];
  const open = {};
  const month = {};

  const close = (k, px, reason, t) => {
    const p = open[k];
    const buy = p.side === "BUY";
    const gross = (buy ? px - p.entry : p.entry - px) * p.units;
    const fee = o.feePerUnit * p.units * 2;
    const net = round(gross - fee, 0);
    profit += net;
    peak = Math.max(peak, profit);
    maxDd = Math.max(maxDd, peak - profit);
    const ym = ymOf(t);
    if (!month[ym]) month[ym] = { ym, trades: 0, wins: 0, net: 0, units: p.units };
    month[ym].trades++;
    if (net > 0) month[ym].wins++;
    month[ym].net += net;
    month[ym].units = Math.max(month[ym].units, p.units);
    trades.push({
      strat: k,
      side: p.side,
      openedAt: p.openedAt,
      closedAt: t,
      entry: p.entry,
      exit: px,
      sl: p.sl,
      units: p.units,
      pips: round((buy ? px - p.entry : p.entry - px) / PIP, 1),
      net,
      reason,
    });
    delete open[k];
    const u = unitsNow();
    if (u !== units) {
      units = u;
      ladder.push({ at: t, units, profit: round(profit, 0) });
    }
  };

  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    if (b.t < from) continue;
    const m = jstMin(b.t);
    // 1) 決済（時刻 → 損切り）
    for (const k of Object.keys(open)) {
      const p = open[k];
      const s = STRATS[k];
      const buy = p.side === "BUY";
      if (b.t - p.openedAt >= (s.exitHm - s.entryHm) * MIN)
        close(k, buy ? b.o : b.o + spread, "時刻で決済", b.t);
      else if (p.sl !== null && (buy ? b.l <= p.sl : b.h + spread >= p.sl))
        close(k, p.sl, "損切り", b.t + 5 * MIN);
    }
    // 2) エントリー
    for (const k of strats) {
      const s = STRATS[k];
      if (open[k] || m !== s.entryHm) continue;
      if (s.days === "fix" && !isFixDay(b.t)) continue;
      const buy = s.side === "BUY";
      const entry = buy ? b.o + spread : b.o;
      const dist =
        o.slMode === "atr"
          ? (a[i - 1] || 0) * o.slValue
          : o.slMode === "pips"
            ? o.slValue * PIP
            : null;
      const sl = dist ? (buy ? entry - dist : entry + dist) : null;
      open[k] = {
        side: s.side,
        entry,
        sl,
        units,
        openedAt: b.t,
        slPips: dist ? round(dist / PIP, 1) : null,
      };
    }
  }
  const last = bars.at(-1);
  for (const k of Object.keys(open))
    close(k, open[k].side === "BUY" ? last.c : last.c + spread, "期間終了", last.t);

  const stat = (list) => {
    let gw = 0;
    let gl = 0;
    for (const t of list) {
      if (t.net > 0) gw += t.net;
      else gl -= t.net;
    }
    const wins = list.filter((t) => t.net > 0).length;
    return {
      trades: list.length,
      winRate: list.length ? round((wins / list.length) * 100, 1) : 0,
      pf: gl > 0 ? round(gw / gl, 2) : gw > 0 ? 99 : 0,
      net: round(gw - gl, 0),
      stops: list.filter((t) => t.reason === "損切り").length,
      avgWin: wins ? round(gw / wins, 0) : 0,
      avgLoss: list.length - wins ? round(-gl / (list.length - wins), 0) : 0,
    };
  };
  const slList = trades
    .map((t) => (t.sl === null ? null : Math.abs(t.entry - t.sl) / PIP))
    .filter((x) => x !== null);
  let eq = 0;
  const curve = trades.map((t) => {
    eq += t.net;
    return { t: t.closedAt, v: round(eq, 0) };
  });
  const step = Math.max(1, Math.ceil(curve.length / 150));
  return {
    at: now,
    options: o,
    from,
    to: last.t,
    total: { ...stat(trades), maxDd: round(maxDd, 0), finalUnits: units },
    byStrat: Object.fromEntries(
      strats.map((k) => [
        k,
        { name: STRATS[k].name, ...stat(trades.filter((t) => t.strat === k)) },
      ]),
    ),
    slPips: slList.length
      ? {
          avg: round(slList.reduce((s, x) => s + x, 0) / slList.length, 1),
          min: round(Math.min(...slList), 1),
          max: round(Math.max(...slList), 1),
        }
      : null,
    ladder,
    months: Object.values(month).map((x) => ({ ...x, net: round(x.net, 0) })),
    curve: curve.filter((_, i) => i % step === 0 || i === curve.length - 1),
    recent: trades.slice(-15).reverse(),
  };
}
