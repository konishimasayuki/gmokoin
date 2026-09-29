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
import { K, acquireLock, addLog, redis } from "./redis.js";
import { SYMBOLS, businessDate, mergeConfig, pipSize, priceDigits, round } from "./util.js";

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
};

const SESSION_SETS = [
  { tokyo: true, london: false, ny: false },
  { tokyo: false, london: true, ny: false },
  { tokyo: false, london: false, ny: true },
  { tokyo: true, london: true, ny: false },
  { tokyo: true, london: false, ny: true },
  { tokyo: true, london: true, ny: true },
];

function grid() {
  const out = [];
  for (const tf of [1, 5])
    for (const sessions of SESSION_SETS)
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
                  slMinPips: tf === 5 ? 3 : 2,
                  slMaxPips: tf === 5 ? 15 : 8,
                  htfFilter,
                  timeStopMin,
                  minAtrPips: tf === 5 ? 1.0 : 0.4,
                  maxAtrPips: tf === 5 ? 15 : 6,
                });
  return out;
}

export function describe(p) {
  const ses = [p.sessions.tokyo && "東京", p.sessions.london && "ロンドン", p.sessions.ny && "NY"]
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

export async function optimizeSymbol(symbol, { now = Date.now() } = {}) {
  const ok = await acquireLock(`${K.optimizeLock}:${symbol}`, 290);
  if (!ok) throw new Error(`${symbol}は検証中です`);
  try {
    const base = mergeConfig(await redis.get(K.config));
    const pip = pipSize(symbol);
    const digits = priceDigits(symbol);
    const spread = (DEFAULT_SPREAD[symbol] || 0.5) * pip;
    const { conv } = await marketContext(symbol);
    const candles = await loadCandles(symbol, TOTAL_DAYS, now);
    if (candles.length < 20000) {
      const r = { symbol, at: now, error: "過去データが不足しています" };
      await redis.set(K.optSymbol(symbol), r, { ex: 60 * 60 * 24 * 3 });
      return r;
    }
    const prep = prepare(candles);
    const fromTs = Math.max(now - TOTAL_DAYS * DAY, candles[60].t);
    const testFrom = now - TEST_DAYS * DAY;
    const env = { spread, conv, pip, digits };
    const sim = (cfg, a, b, extra = {}) =>
      simulate(prep, cfg, { ...env, fromTs: a, toTs: b, ...extra });

    // 1. 前半で選ぶ
    const scored = [];
    for (const p of grid()) {
      const cfg = { ...base, ...p };
      const m = metricsOf(sim(cfg, fromTs, testFrom), cfg);
      const s = score(m);
      if (s > 0) scored.push({ p, train: m, s });
    }
    scored.sort((a, b) => b.s - a.s);

    const rng = rngOf(`${businessDate(now)}:${symbol}`);
    const candidates = scored.slice(0, 10).map(({ p, train }) => {
      const cfg = { ...base, ...p };
      const test = metricsOf(sim(cfg, testFrom, now), cfg);
      const fullTrades = sim(cfg, fromTs, now);
      const full = metricsOf(fullTrades, cfg);
      const weeks = randomWeeks(fullTrades, fromTs, now, rng);
      const mc = monteCarlo(fullTrades, rng);
      const stress = metricsOf(sim(cfg, fromTs, now, { spread: spread * 2, slip: 0.2 * pip }), cfg);
      const nb = neighborsOf(p).map((q) =>
        metricsOf(sim({ ...base, ...q }, fromTs, now), { ...base, ...q }),
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
      };
      const passed = Object.values(checks).filter(Boolean).length;
      return {
        params: p,
        label: describe(p),
        train,
        test,
        full,
        weeks,
        mc,
        stress,
        neighbors: { ok: nbOk, total: nb.length },
        checks,
        passed,
        pass: passed === 5,
        robust: round(Math.min(train.pf, test.pf, stress.pf) * (1 - mc.lossProb), 3),
      };
    });
    candidates.sort(
      (a, b) => Number(b.pass) - Number(a.pass) || b.passed - a.passed || b.robust - a.robust,
    );
    const current = metricsOf(sim(base, fromTs, now), base);
    const result = {
      symbol,
      at: now,
      days: round((now - fromTs) / DAY, 0),
      spreadPips: round(spread / pip, 2),
      tested: grid().length,
      positiveTrain: scored.length,
      best: candidates[0] || null,
      others: candidates
        .slice(1, 3)
        .map((c) => ({ label: c.label, passed: c.passed, test: c.test })),
      current,
    };
    await redis.set(K.optSymbol(symbol), result, { ex: 60 * 60 * 24 * 3 });
    return result;
  } finally {
    await redis.del(`${K.optimizeLock}:${symbol}`);
  }
}

// 全銘柄の結果を集めて採用を決める
export async function finalizeOptimize({ apply = false, now = Date.now() } = {}) {
  const rows = await redis.mget(...SYMBOLS.map((s) => K.optSymbol(s)));
  const results = SYMBOLS.map((s, i) => rows[i] || { symbol: s, error: "未検証" }).map((r) =>
    r.at && now - r.at > RESULT_TTL ? { ...r, stale: true } : r,
  );
  const passing = results.filter((r) => !r.stale && r.best?.pass);
  passing.sort((a, b) => b.best.robust - a.best.robust || b.best.test.net - a.best.test.net);
  const pick = passing[0]
    ? { symbol: passing[0].symbol, params: passing[0].best.params, label: passing[0].best.label }
    : null;

  let applied = null;
  const cfg = mergeConfig(await redis.get(K.config));
  if (apply && cfg.symbolMode === "auto") {
    const pos = await redis.get(K.position);
    if (pos) applied = { status: "skipped", why: "ポジション保有中のため、決済後に切り替えます" };
    else if (pick) {
      await redis.set(K.config, {
        ...cfg,
        ...pick.params,
        symbol: pick.symbol,
        autoBlocked: false,
        autoPickAt: now,
      });
      if (pick.symbol !== cfg.symbol) await redis.del(K.regime, K.lastSignal);
      await addLog(
        `AIおまかせ：${pick.symbol.replace("_", "/")}を選択（5段階の検証に合格・${pick.label}）`,
        "regime",
      );
      applied = { status: "applied", symbol: pick.symbol };
    } else {
      await redis.set(K.config, { ...cfg, autoBlocked: true, autoPickAt: now });
      await addLog(
        "AIおまかせ：5段階の検証に合格した銘柄・設定がないため、新規エントリーを止めます",
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
    results,
    pick,
    applied,
    note: "相場判定はClaudeではなく1時間足の機械判定で代用。ランダム検証の週と引き直しは日替わりで変わります。",
  };
  await redis.set(K.optimizeLast, out, { ex: 60 * 60 * 24 * 30 });
  return out;
}

export { SYMBOLS };
