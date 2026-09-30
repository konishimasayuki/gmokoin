// 自動選定 v2：90日分のデータで、5段階の検証を通った銘柄・設定だけを採用する
//  1. 前半60日で設定を選び、後半30日で通用するか（未来を見ないテスト）
//  2. ランダムに選んだ40週で、勝ち越す週が7割以上か
//  3. 取引結果を1000回ランダムに引き直して、マイナスになる確率が25%以下か
//  4. スプレッド2倍＋約定のズレでも負けないか
//  5. 設定を少しズラしても勝てるか（6通り中4通り以上）
import {
  DAY,
  DEFAULT_SPREAD,
  loadCandles,
  marketContext,
  metricsOf,
  prepare,
  simulate,
} from "./backtest.js";
import { simulateGrid } from "./grid.js";
import { K, acquireLock, addLog, redis } from "./redis.js";
import {
  ASSET_DEFAULTS,
  SYMBOLS,
  assetOf,
  businessDate,
  isCrypto,
  mergeConfig,
  pipSize,
  priceDigits,
  round,
} from "./util.js";

export const TOTAL_DAYS = 90;
export const TEST_DAYS = 30;
const WEEK = 7 * DAY;
const RESULT_TTL = 6 * 3600 * 1000;

export const PASS_RULE = {
  trainPf: 1.15,
  minTrain: 30,
  testPf: 1.1,
  minTest: 10,
  weekWin: 0.7,
  minWeeks: 10,
  mcLoss: 0.25,
  stressPf: 1.0,
  neighbors: 4,
  ddCapPct: 30, // 含み損込みの最大ドローダウンが資金の30%以下
};

const S = (tokyo, london, ny, other = false) => ({ tokyo, london, ny, other });
const FX_SESSION_SETS = [
  S(true, false, false),
  S(false, true, false),
  S(false, false, true),
  S(true, true, false),
  S(true, false, true),
  S(true, true, true),
];
// 仮想通貨は24時間動くので「早朝・その他」も候補に入れる
const CRYPTO_SESSION_SETS = [
  S(true, true, true, true),
  S(true, true, true, false),
  S(false, true, true, false),
  S(true, false, false, true),
  S(false, false, true, true),
  S(true, false, false, false),
];

// 値幅の単位は FX=pips、仮想通貨=bp（価格の0.01%）
const LIMITS = {
  fx: {
    1: { slMin: 2, slMax: 8, minAtr: 0.4, maxAtr: 6 },
    5: { slMin: 3, slMax: 15, minAtr: 1.0, maxAtr: 15 },
  },
  crypto: {
    1: { slMin: 5, slMax: 60, minAtr: 2, maxAtr: 60 },
    5: { slMin: 10, slMax: 150, minAtr: 4, maxAtr: 150 },
  },
};

function grid(symbol) {
  const crypto = isCrypto(symbol);
  const sets = crypto ? CRYPTO_SESSION_SETS : FX_SESSION_SETS;
  const lim = crypto ? LIMITS.crypto : LIMITS.fx;
  const out = [];
  for (const tf of [1, 5])
    for (const sessions of sets)
      for (const beOn of [false, true])
        for (const rr of [1.0, 1.5, 2.0])
          for (const slAtrMult of [1.5, 2.5])
            for (const htfFilter of [true, false])
              for (const timeStopMin of tf === 5 ? [60, 120] : [20, 45])
                out.push({
                  signalTf: tf,
                  sessions,
                  beOn,
                  beTriggerR: 1.0,
                  rr,
                  slAtrMult,
                  slMinPips: lim[tf].slMin,
                  slMaxPips: lim[tf].slMax,
                  htfFilter,
                  timeStopMin,
                  minAtrPips: lim[tf].minAtr,
                  maxAtrPips: lim[tf].maxAtr,
                });
  return out;
}

export function describe(p) {
  if (p.strategy === "grid") {
    const d = { long: "買い", short: "売り", auto: "買い/売り自動" }[p.dir];
    return `リピート${d}・過去${p.lookbackDays}日のレンジを${p.levels}分割・${p.tpSteps}マスで利確・想定外で全決済・最大損失 資金の${p.riskPct}%`;
  }
  const x = p.sessions;
  const ses =
    x.tokyo && x.london && x.ny && x.other
      ? "24時間"
      : [x.tokyo && "東京", x.london && "ロンドン", x.ny && "NY", x.other && "早朝"]
          .filter(Boolean)
          .join("・");
  return `${p.signalTf}分足・${ses}・利確${p.rr}倍・損切りATR${p.slAtrMult}倍・${p.beOn ? "建値あり" : "建値なし"}・${p.htfFilter ? "上位足フィルターあり" : "フィルターなし"}・最長${p.timeStopMin}分`;
}

function rngOf(seedStr) {
  let a = 0;
  for (const ch of seedStr) a = (Math.imul(a ^ ch.charCodeAt(0), 2654435761) + 1) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const score = (m) =>
  m.trades < PASS_RULE.minTrain || m.net <= 0 ? -1 : m.pf * Math.min(1, m.trades / 80);

// 2. ランダムな週
function randomWeeks(trades, fromTs, toTs, rng, n = 40) {
  let counted = 0;
  let wins = 0;
  for (let i = 0; i < n; i++) {
    const s = fromTs + rng() * Math.max(0, toTs - fromTs - WEEK);
    let net = 0;
    let cnt = 0;
    for (const t of trades) {
      if (t.openedAt >= s && t.openedAt < s + WEEK) {
        net += t.net;
        cnt++;
      }
    }
    if (cnt >= 3) {
      counted++;
      if (net > 0) wins++;
    }
  }
  return { windows: n, counted, winShare: counted ? round(wins / counted, 2) : 0 };
}

// 3. モンテカルロ（取引を引き直す）
function monteCarlo(trades, rng, runs = 1000) {
  const nets = trades.map((t) => t.net);
  const n = nets.length;
  if (!n) return { runs, lossProb: 1, dd95: 0, p5: 0 };
  let losses = 0;
  const dds = [];
  const finals = [];
  for (let r = 0; r < runs; r++) {
    let eq = 0;
    let peak = 0;
    let dd = 0;
    for (let i = 0; i < n; i++) {
      eq += nets[Math.floor(rng() * n)];
      if (eq > peak) peak = eq;
      if (peak - eq > dd) dd = peak - eq;
    }
    if (eq < 0) losses++;
    dds.push(dd);
    finals.push(eq);
  }
  dds.sort((a, b) => a - b);
  finals.sort((a, b) => a - b);
  return {
    runs,
    lossProb: round(losses / runs, 3),
    dd95: round(dds[Math.floor(runs * 0.95)], 0),
    p5: round(finals[Math.floor(runs * 0.05)], 0),
    median: round(finals[Math.floor(runs * 0.5)], 0),
  };
}

// 5. 設定のブレ
function neighborsOf(p) {
  return [
    { ...p, rr: round(p.rr - 0.25, 2) },
    { ...p, rr: round(p.rr + 0.25, 2) },
    { ...p, slAtrMult: round(p.slAtrMult - 0.3, 2) },
    { ...p, slAtrMult: round(p.slAtrMult + 0.3, 2) },
    { ...p, timeStopMin: Math.round(p.timeStopMin * 0.75) },
    { ...p, timeStopMin: Math.round(p.timeStopMin * 1.25) },
  ].filter((x) => x.rr >= 0.5 && x.slAtrMult >= 0.5);
}

// リピート（グリッド）戦略の候補
function gridCombos() {
  const out = [];
  for (const lookbackDays of [5, 10, 20])
    for (const levels of [6, 10])
      for (const tpSteps of [1, 2])
        for (const dir of ["long", "short", "auto"])
          for (const riskPct of [5, 10])
            out.push({
              strategy: "grid",
              lookbackDays,
              levels,
              tpSteps,
              dir,
              stopSteps: 1,
              riskPct,
            });
  return out;
}

function gridNeighbors(p) {
  return [
    { ...p, levels: p.levels + 2 },
    { ...p, levels: Math.max(3, p.levels - 2) },
    { ...p, lookbackDays: Math.round(p.lookbackDays * 1.5) },
    { ...p, lookbackDays: Math.max(3, Math.round(p.lookbackDays * 0.7)) },
    { ...p, riskPct: round(p.riskPct * 1.3, 1) },
    { ...p, riskPct: round(p.riskPct * 0.7, 1) },
  ];
}

export async function optimizeSymbol(symbol, { now = Date.now() } = {}) {
  const ok = await acquireLock(`${K.optimizeLock}:${symbol}`, 290);
  if (!ok) throw new Error(`${symbol}は検証中です`);
  try {
    const stored = mergeConfig(await redis.get(K.config));
    // 銘柄の種類（FX/仮想通貨）に合わせた単位の既定値で比較する
    const base =
      assetOf(symbol) === assetOf(stored.symbol)
        ? stored
        : { ...stored, ...ASSET_DEFAULTS[assetOf(symbol)] };
    const digits = priceDigits(symbol);
    const { conv } = await marketContext(symbol);
    const candles = await loadCandles(symbol, TOTAL_DAYS, now);
    if (candles.length < 20000) {
      const r = { symbol, at: now, error: "過去データが不足しています" };
      await redis.set(K.optSymbol(symbol), r, { ex: 60 * 60 * 24 * 3 });
      return r;
    }
    const pip = pipSize(symbol, candles.at(-1).c);
    const spread = (DEFAULT_SPREAD[symbol] || 0.5) * pip;
    const slip = (isCrypto(symbol) ? 2 : 0.2) * pip;
    const prep = prepare(candles);
    const fromTs = Math.max(now - TOTAL_DAYS * DAY, candles[60].t);
    const testFrom = now - TEST_DAYS * DAY;
    const env = { spread, conv, pip, digits, symbol };
    const ddCap = (base.paperBalance * PASS_RULE.ddCapPct) / 100;

    // 手法ごとの実行（trades と 含み損込みの最大DD を返す）
    const run = (p, a, b, extra = {}) => {
      if (p.strategy === "grid")
        return simulateGrid(prep, p, { ...env, cfg: base, fromTs: a, toTs: b, ...extra });
      const cfg = { ...base, ...p };
      const trades = simulate(prep, cfg, { ...env, fromTs: a, toTs: b, ...extra });
      return { trades, mtmDd: metricsOf(trades, cfg).maxDd };
    };
    const metrics = (p, a, b, extra) => {
      const r = run(p, a, b, extra);
      return { ...metricsOf(r.trades, base), mtmDd: r.mtmDd };
    };

    // 1. 前半60日で候補を選ぶ（手法ごとに上位を残す）
    const pick = (combos, n) => {
      const scored = [];
      for (const p of combos) {
        const m = metrics(p, fromTs, testFrom);
        const s = score(m);
        if (s > 0) scored.push({ p, train: m, s });
      }
      scored.sort((a, b) => b.s - a.s);
      return { top: scored.slice(0, n), positive: scored.length, tested: combos.length };
    };
    const scalpPick = pick(grid(symbol), 8);
    const gridPick = pick(gridCombos(), 5);

    const rng = rngOf(`${businessDate(now)}:${symbol}`);
    // リピートは「レンジ抜けの全決済」が期間中に起きていないと勝率100%に見えてしまう。
    // その場合は最悪ケース（設定した最大損失）を1回起きたものとして加えて評価する
    const withWorst = (p, trades) => {
      if (p.strategy !== "grid" || trades.some((t) => t.reason === "想定外ラインで全決済"))
        return trades;
      const loss = -round((base.paperBalance * p.riskPct) / 100, 0);
      return [
        ...trades,
        {
          net: loss,
          pips: 0,
          units: 0,
          fee: 0,
          openedAt: now - 1,
          closedAt: now - 1,
          reason: "最悪ケース（想定）",
        },
      ];
    };
    const evaluate = ({ p, train }) => {
      const test = metrics(p, testFrom, now);
      const fullRun = run(p, fromTs, now);
      fullRun.trades = withWorst(p, fullRun.trades);
      const full = {
        ...metricsOf(fullRun.trades, base),
        mtmDd: fullRun.mtmDd,
        worstAdded: fullRun.trades.at(-1)?.reason === "最悪ケース（想定）",
      };
      const weeks = randomWeeks(fullRun.trades, fromTs, now, rng);
      const mc = monteCarlo(fullRun.trades, rng);
      const stressRun = run(p, fromTs, now, { spread: spread * 2, slip });
      const stress = { ...metricsOf(withWorst(p, stressRun.trades), base), mtmDd: stressRun.mtmDd };
      const nb = (p.strategy === "grid" ? gridNeighbors(p) : neighborsOf(p)).map((q) =>
        metrics(q, fromTs, now),
      );
      const nbOk = nb.filter((m) => m.pf >= 1.0 && m.net > 0).length;
      const checks = {
        split:
          train.pf >= PASS_RULE.trainPf &&
          test.trades >= PASS_RULE.minTest &&
          test.pf >= PASS_RULE.testPf &&
          test.net > 0,
        weeks: weeks.counted >= PASS_RULE.minWeeks && weeks.winShare >= PASS_RULE.weekWin,
        mc: mc.lossProb <= PASS_RULE.mcLoss,
        stress: stress.pf >= PASS_RULE.stressPf && stress.net > 0,
        neighbors: nbOk >= Math.min(PASS_RULE.neighbors, nb.length),
        dd: full.mtmDd <= ddCap,
      };
      const passed = Object.values(checks).filter(Boolean).length;
      return {
        strategy: p.strategy === "grid" ? "grid" : "scalp",
        params: p,
        label: describe(p),
        train,
        test,
        full,
        nets: fullRun.trades.slice(-1500).map((t) => [t.closedAt, t.net]),
        weeks,
        mc,
        stress,
        neighbors: { ok: nbOk, total: nb.length },
        checks,
        passed,
        pass: passed === 6,
        robust: round(Math.min(train.pf, test.pf, stress.pf) * (1 - mc.lossProb), 3),
      };
    };
    const order = (a, b) =>
      Number(b.pass) - Number(a.pass) || b.passed - a.passed || b.robust - a.robust;
    const scalpC = scalpPick.top.map(evaluate).sort(order);
    const gridC = gridPick.top.map(evaluate).sort(order);
    const bestScalp = scalpC[0] || null;
    const bestGrid = gridC[0] || null;
    const best = [bestScalp, bestGrid].filter(Boolean).sort(order)[0] || null;
    const current = metricsOf(run(base, fromTs, now).trades, base);
    const slim = (c) => (c ? { ...c, nets: undefined } : null);
    const result = {
      symbol,
      at: now,
      days: round((now - fromTs) / DAY, 0),
      spreadPips: round(spread / pip, 2),
      tested: scalpPick.tested + gridPick.tested,
      unit: isCrypto(symbol) ? "bp" : "pips",
      kind: isCrypto(symbol) ? "crypto" : "fx",
      positiveTrain: scalpPick.positive + gridPick.positive,
      best: slim(best),
      bestScalp,
      bestGrid,
      current,
    };
    await redis.set(K.optSymbol(symbol), result, { ex: 60 * 60 * 24 * 3 });
    return { ...result, bestScalp: slim(bestScalp), bestGrid: slim(bestGrid) };
  } finally {
    await redis.del(`${K.optimizeLock}:${symbol}`);
  }
}

// 全銘柄の結果を集めて採用を決める
// 合格した銘柄を組み合わせたときの成績（同時に持つ制限は考慮しない概算）
function combine(list, rng) {
  const nets = list.flatMap((r) => r.best.nets || []).sort((a, b) => a[0] - b[0]);
  let eq = 0;
  let peak = 0;
  let maxDd = 0;
  let gw = 0;
  let gl = 0;
  let wins = 0;
  const curve = [];
  for (const [t, n] of nets) {
    eq += n;
    if (n > 0) {
      gw += n;
      wins++;
    } else gl -= n;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
    curve.push({ t, v: round(eq, 0) });
  }
  const step = Math.max(1, Math.ceil(curve.length / 120));
  const mc = monteCarlo(
    nets.map(([, n]) => ({ net: n })),
    rng,
  );
  const mtmDdSum = list.reduce((s, r) => s + (r.best.full?.mtmDd || 0), 0);
  return {
    trades: nets.length,
    net: round(eq, 0),
    pf: gl > 0 ? round(gw / gl, 2) : gw > 0 ? 99 : 0,
    winRate: nets.length ? round((wins / nets.length) * 100, 1) : 0,
    maxDd: round(maxDd, 0),
    // 含み損込みの最大DD（銘柄ごとの合計。同時に起きた前提の保守的な概算）
    mtmDd: round(Math.max(maxDd, mtmDdSum), 0),
    mc,
    curve: curve.filter((_, i) => i % step === 0 || i === curve.length - 1),
  };
}

// 全銘柄の結果を集めて、合格した銘柄をまとめて採用する
export async function finalizeOptimize({ apply = false, now = Date.now() } = {}) {
  const cfg = mergeConfig(await redis.get(K.config));
  const rows = await redis.mget(...SYMBOLS.map((s) => K.optSymbol(s)));
  const results = SYMBOLS.map((s, i) => rows[i] || { symbol: s, error: "未検証" }).map((r) =>
    r.at && now - r.at > RESULT_TTL ? { ...r, stale: true } : r,
  );
  // いま実際に動かせるのはスキャルピング。リピートは24時間稼働にしてから（検証結果は並べて表示）
  const scalpOf = (r) => r.bestScalp || (r.best?.strategy !== "grid" ? r.best : null);
  const passing = results.filter((r) => !r.stale && scalpOf(r)?.pass);
  passing.sort(
    (a, b) => scalpOf(b).robust - scalpOf(a).robust || scalpOf(b).test.net - scalpOf(a).test.net,
  );
  const chosen = passing.slice(0, cfg.maxSymbols);
  const portfolio = chosen.map((r) => {
    const b = scalpOf(r);
    return {
      symbol: r.symbol,
      params: b.params,
      label: b.label,
      robust: b.robust,
      test: { pf: b.test.pf, net: b.test.net, trades: b.test.trades },
    };
  });
  const combined = chosen.length
    ? combine(
        chosen.map((r) => ({ best: scalpOf(r) })),
        rngOf(`${businessDate(now)}:portfolio`),
      )
    : null;
  const gridPassing = results.filter((r) => !r.stale && r.bestGrid?.pass);
  gridPassing.sort((a, b) => b.bestGrid.robust - a.bestGrid.robust);
  const gridChosen = gridPassing.slice(0, cfg.maxSymbols);
  const combinedGrid = gridChosen.length
    ? combine(
        gridChosen.map((r) => ({ best: r.bestGrid })),
        rngOf(`${businessDate(now)}:grid`),
      )
    : null;

  let applied = null;
  if (apply && cfg.symbolMode === "auto") {
    if (portfolio.length) {
      const first = portfolio[0].symbol;
      await redis.set(K.config, {
        ...cfg,
        ...(assetOf(first) !== assetOf(cfg.symbol) ? ASSET_DEFAULTS[assetOf(first)] : {}),
        symbol: first,
        portfolio,
        autoBlocked: false,
        autoPickAt: now,
      });
      await addLog(
        `AIおまかせ：${portfolio.map((p) => p.symbol.replace("_", "/")).join("、")}の${portfolio.length}銘柄を採用（5段階の検証に合格）`,
        "regime",
      );
      applied = { status: "applied", symbols: portfolio.map((p) => p.symbol) };
    } else {
      await redis.set(K.config, { ...cfg, portfolio: [], autoBlocked: true, autoPickAt: now });
      await addLog(
        "AIおまかせ：5段階の検証に合格した銘柄がないため、新規エントリーを止めます",
        "error",
      );
      applied = { status: "blocked" };
    }
  }
  const out = {
    at: now,
    totalDays: TOTAL_DAYS,
    testDays: TEST_DAYS,
    rule: PASS_RULE,
    results: results.map((r) => ({
      ...r,
      best: r.best ? { ...r.best, nets: undefined } : r.best,
      bestScalp: r.bestScalp ? { ...r.bestScalp, nets: undefined } : r.bestScalp,
      bestGrid: r.bestGrid ? { ...r.bestGrid, nets: undefined } : r.bestGrid,
    })),
    portfolio,
    combined,
    gridSymbols: gridChosen.map((r) => r.symbol),
    combinedGrid,
    pick: portfolio[0] ? { symbol: portfolio[0].symbol } : null,
    applied,
    note: "相場判定はClaudeではなく1時間足の機械判定で代用。組み合わせの成績は、同時に持てる数の制限を考えない概算です。ランダム検証は日替わりです。",
  };
  await redis.set(K.optimizeLast, out, { ex: 60 * 60 * 24 * 30 });
  return out;
}

export { SYMBOLS };
