// 勝てる「理由」がある2つの手法
//  1) 仲値・ゴトー日：輸入企業のドル買い（仲値9:55に向けて）という実際の資金の流れを狙う
//  2) 4時間足のトレンドフォロー：ブレイクに乗って伸ばす。保有が長いのでコストの比率が小さい
import { atr, sma } from "./indicators.js";
import { SESSION_LABEL, sessionOf, sizeUnits } from "./strategy.js";
import { MIN_UNITS, feeOf, isCrypto, pnlYen, round } from "./util.js";

const MIN = 60000;
const jst = (ts) => {
  const d = new Date(ts + 9 * 3600000);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth(),
    day: d.getUTCDate(),
    wd: d.getUTCDay(),
    m: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
};
const riskCfg = (cfg) => ({
  ...cfg,
  sizingMode: "risk",
  riskPct: cfg.sizingMode === "risk" ? cfg.riskPct : 0.5,
  maxUnits: Math.max(cfg.maxUnits || 0, 3000000),
});

// 損失額固定でロットを決める。最小数量（1万通貨）に届かない時は、1回の損失が資金の2%以内なら1万通貨で入る
function unitsFor({ scfg, equity, slDist, conv, symbol, price }) {
  const size = sizeUnits({ cfg: scfg, equity, slDist, conv, symbol, price });
  // レバレッジ25倍（FX）を超えないように抑える
  const cap = Math.floor((equity * 25) / (price * conv) / 1000) * 1000;
  if (size.units) return Math.min(size.units, cap);
  if (isCrypto(symbol)) return 0;
  const risk = slDist * conv * MIN_UNITS;
  return risk <= equity * 0.02 ? MIN_UNITS : 0;
}

// ---------- 1) 仲値・ゴトー日 ----------
const GOTOBI = new Set([5, 10, 15, 20, 25, 30]);
// 5・10日（土日なら前の金曜）と月末（最終営業日）
export function isFixDay(ts) {
  const p = jst(ts);
  if (p.wd === 0 || p.wd === 6) return false;
  const last = new Date(Date.UTC(p.y, p.mo + 1, 0)).getUTCDate();
  const isBizLast = (() => {
    for (let d = last; d > p.day; d--) {
      const wd = new Date(Date.UTC(p.y, p.mo, d)).getUTCDay();
      if (wd !== 0 && wd !== 6) return false;
    }
    return true;
  })();
  if (GOTOBI.has(p.day) || isBizLast) return true;
  if (p.wd === 5) return [1, 2].some((k) => p.day + k <= last && GOTOBI.has(p.day + k));
  return false;
}

export function gotobiCombos() {
  const out = [];
  // 仲値前に買う（8:00/8:30/9:00に入って9:55に決済）
  for (const entryHm of [480, 510, 540])
    for (const days of ["fix", "all"])
      out.push({
        strategy: "flow",
        method: "gotobi",
        combo: "before",
        entryHm,
        exitHm: 595,
        side: "BUY",
        days,
        slAtr: 2,
      });
  // 仲値後に売る（9:55に入って11:00/12:00に決済）
  for (const exitHm of [660, 720])
    for (const days of ["fix", "all"])
      out.push({
        strategy: "flow",
        method: "gotobi",
        combo: "after",
        entryHm: 595,
        exitHm,
        side: "SELL",
        days,
        slAtr: 2,
      });
  return out;
}

const hm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
export function gotobiLabel(p) {
  return `仲値${p.combo === "before" ? "前の買い" : "後の売り"}・${hm(p.entryHm)}に入り${hm(p.exitHm)}に決済・${p.days === "fix" ? "ゴトー日と月末だけ" : "毎営業日"}・損切りATR${p.slAtr}倍`;
}

export function simulateGotobi(bars, p, env) {
  const { spread, conv, pip, fromTs, toTs, slip = 0, symbol, cfg } = env;
  const a = atr(bars, 12 * 14); // 5分足でおよそ1時間足14本ぶん
  const scfg = riskCfg(cfg);
  const trades = [];
  let equity = cfg.paperBalance;
  let pos = null;
  let realized = 0;
  let peak = 0;
  let mtmDd = 0;
  const buy = p.side === "BUY";
  const close = (exit, reason, t) => {
    const dir = buy ? 1 : -1;
    const fee = feeOf(symbol, pos.units, cfg);
    const net = round(pnlYen(p.side, pos.entry, exit, pos.units, conv) - fee, 0);
    trades.push({
      side: p.side,
      setup: gotobiLabel(p),
      session: SESSION_LABEL[sessionOf(pos.openedAt)] || "その他",
      units: pos.units,
      entry: pos.entry,
      exit,
      reason,
      openedAt: pos.openedAt,
      closedAt: t,
      pips: round((dir * (exit - pos.entry)) / pip, 1),
      net,
      fee,
      sl: pos.sl,
      tp: null,
    });
    equity += net;
    realized += net;
    pos = null;
  };
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    if (b.t >= toTs) break;
    const q = jst(b.t);
    if (pos) {
      if (buy ? b.l <= pos.sl : b.h + spread >= pos.sl)
        close(buy ? pos.sl - slip : pos.sl + slip, "損切り", b.t + 5 * MIN);
      else if (q.m >= p.exitHm || b.t - pos.openedAt > 6 * 3600000)
        close(buy ? b.o : b.o + spread, "時刻で決済", b.t);
    }
    if (!pos && b.t >= fromTs && q.m === p.entryHm && (p.days === "all" || isFixDay(b.t))) {
      const entry = buy ? b.o + spread + slip : b.o - slip;
      const slDist = (a[i - 1] || 0) * p.slAtr;
      if (!(slDist > spread * 3)) continue;
      const sl = buy ? entry - slDist : entry + slDist;
      const units = unitsFor({ scfg, equity, slDist, conv, symbol, price: entry });
      if (!units) continue;
      pos = { entry, sl, units, openedAt: b.t };
      if (buy ? b.l <= sl : b.h + spread >= sl) close(sl, "損切り", b.t + 5 * MIN);
    }
    let eq = realized;
    if (pos) eq += pnlYen(p.side, pos.entry, buy ? b.c : b.c + spread, pos.units, conv);
    if (eq > peak) peak = eq;
    if (peak - eq > mtmDd) mtmDd = peak - eq;
  }
  if (pos) close(bars.at(-1).c, "期間終了で時価評価", bars.at(-1).t);
  return { trades, mtmDd: round(mtmDd, 0) };
}

// ---------- 2) 4時間足のトレンドフォロー（ドンチャン・ブレイク＋トレーリング） ----------
export function trendCombos() {
  const out = [];
  for (const n of [20, 55])
    for (const k of [2, 3])
      for (const filter of [false, true])
        out.push({ strategy: "flow", method: "trend", combo: "4h", n, k, filter });
  return out;
}

export function trendLabel(p) {
  return `4時間足トレンドフォロー・直近${p.n}本の高値/安値ブレイク・損切りとトレーリングATR${p.k}倍${p.filter ? "・200SMAの向きに限定" : ""}`;
}

export function simulateTrend(bars, p, env) {
  const { spread, conv, pip, fromTs, toTs, slip = 0, symbol, cfg } = env;
  const a = atr(bars, 20);
  const s200 = sma(
    bars.map((b) => b.c),
    200,
  );
  const scfg = riskCfg(cfg);
  const trades = [];
  let equity = cfg.paperBalance;
  let pos = null;
  let realized = 0;
  let peak = 0;
  let mtmDd = 0;
  const close = (exit, reason, t) => {
    const buy = pos.side === "BUY";
    const dir = buy ? 1 : -1;
    const fee = feeOf(symbol, pos.units, cfg);
    const net = round(pnlYen(pos.side, pos.entry, exit, pos.units, conv) - fee, 0);
    trades.push({
      side: pos.side,
      setup: `トレンドフォロー${buy ? "買い" : "売り"}`,
      session: SESSION_LABEL[sessionOf(pos.openedAt)] || "その他",
      units: pos.units,
      entry: pos.entry,
      exit,
      reason,
      openedAt: pos.openedAt,
      closedAt: t,
      pips: round((dir * (exit - pos.entry)) / pip, 1),
      net,
      fee,
      sl: pos.initSl,
      tp: null,
    });
    equity += net;
    realized += net;
    pos = null;
  };
  let signal = null;
  for (let i = p.n + 1; i < bars.length; i++) {
    const b = bars[i];
    if (b.t >= toTs) break;
    // 前の足で出たシグナルを、この足の始値で約定
    if (!pos && signal && b.t >= fromTs) {
      const buy = signal === "BUY";
      const entry = buy ? b.o + spread + slip : b.o - slip;
      const slDist = (a[i - 1] || 0) * p.k;
      if (slDist > spread * 3) {
        const sl = buy ? entry - slDist : entry + slDist;
        const units = unitsFor({ scfg, equity, slDist, conv, symbol, price: entry });
        if (units)
          pos = {
            side: signal,
            entry,
            sl,
            initSl: sl,
            units,
            openedAt: b.t,
            best: buy ? b.o : b.o,
          };
      }
    }
    signal = null;
    if (pos) {
      const buy = pos.side === "BUY";
      if (buy ? b.l <= pos.sl : b.h + spread >= pos.sl)
        close(buy ? pos.sl - slip : pos.sl + slip, "トレーリング/損切り", b.t + 4 * 60 * MIN);
      else {
        // 足の確定後にトレーリングを引き上げる（下げる）
        pos.best = buy ? Math.max(pos.best, b.c) : Math.min(pos.best, b.c);
        const trail = buy ? pos.best - (a[i] || 0) * p.k : pos.best + (a[i] || 0) * p.k + spread;
        pos.sl = buy ? Math.max(pos.sl, trail) : Math.min(pos.sl, trail);
      }
    }
    if (!pos) {
      let hh = Number.NEGATIVE_INFINITY;
      let ll = Number.POSITIVE_INFINITY;
      for (let k = i - p.n; k < i; k++) {
        hh = Math.max(hh, bars[k].h);
        ll = Math.min(ll, bars[k].l);
      }
      const up = !p.filter || (s200[i] && s200[i - 5] && s200[i] > s200[i - 5] && b.c > s200[i]);
      const dn = !p.filter || (s200[i] && s200[i - 5] && s200[i] < s200[i - 5] && b.c < s200[i]);
      if (b.c > hh && up) signal = "BUY";
      else if (b.c < ll && dn) signal = "SELL";
    }
    let eq = realized;
    if (pos)
      eq += pnlYen(pos.side, pos.entry, pos.side === "BUY" ? b.c : b.c + spread, pos.units, conv);
    if (eq > peak) peak = eq;
    if (peak - eq > mtmDd) mtmDd = peak - eq;
  }
  if (pos)
    close(
      pos.side === "BUY" ? bars.at(-1).c : bars.at(-1).c + spread,
      "期間終了で時価評価",
      bars.at(-1).t,
    );
  return { trades, mtmDd: round(mtmDd, 0) };
}
