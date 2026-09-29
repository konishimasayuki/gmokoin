// 自動最適化：全銘柄×設定の組み合わせを過去データで試し、
// 前半(学習)で選んだ設定が後半(検証)でも通用したものだけを採用する
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
import { SYMBOLS, mergeConfig, pipSize, priceDigits, round } from "./util.js";

const TOTAL_DAYS = 20;
const TEST_DAYS = 6;

const SESSION_SETS = [
  { tokyo: true, london: false, ny: false },
  { tokyo: false, london: true, ny: false },
  { tokyo: false, london: false, ny: true },
  { tokyo: true, london: true, ny: false },
  { tokyo: true, london: false, ny: true },
  { tokyo: true, london: true, ny: true },
];

export const PASS_RULE = { trainPf: 1.15, testPf: 1.1, minTrain: 15, minTest: 5 };

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

const score = (m) =>
  m.trades < PASS_RULE.minTrain || m.net <= 0 ? -1 : m.pf * Math.min(1, m.trades / 40);

export function describe(p) {
  const ses = [p.sessions.tokyo && "東京", p.sessions.london && "ロンドン", p.sessions.ny && "NY"]
    .filter(Boolean)
    .join("・");
  return `${p.signalTf}分足・${ses}・利確${p.rr}倍・損切りATR${p.slAtrMult}倍・${p.beOn ? "建値あり" : "建値なし"}・${p.htfFilter ? "上位足フィルターあり" : "フィルターなし"}・最長${p.timeStopMin}分`;
}

async function optimizeSymbol(symbol, base, now) {
  const pip = pipSize(symbol);
  const digits = priceDigits(symbol);
  const spread = (DEFAULT_SPREAD[symbol] || 0.5) * pip;
  const { conv } = await marketContext(symbol);
  const candles = await loadCandles(symbol, TOTAL_DAYS, now);
  if (candles.length < 3000) return { symbol, error: "過去データ不足" };
  const prep = prepare(candles);
  const trainFrom = now - TOTAL_DAYS * DAY;
  const testFrom = now - TEST_DAYS * DAY;
  const env = { spread, conv, pip, digits };

  const scored = [];
  for (const p of grid()) {
    const cfg = { ...base, ...p };
    const m = metricsOf(simulate(prep, cfg, { ...env, fromTs: trainFrom, toTs: testFrom }), cfg);
    const s = score(m);
    if (s > 0) scored.push({ p, train: m, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const top = scored.slice(0, 8).map((x) => {
    const cfg = { ...base, ...x.p };
    const test = metricsOf(simulate(prep, cfg, { ...env, fromTs: testFrom, toTs: now }), cfg);
    const pass =
      x.train.pf >= PASS_RULE.trainPf &&
      test.trades >= PASS_RULE.minTest &&
      test.pf >= PASS_RULE.testPf &&
      test.net > 0;
    return {
      params: x.p,
      label: describe(x.p),
      train: x.train,
      test,
      pass,
      robust: Math.min(x.train.pf, test.pf),
    };
  });
  top.sort((a, b) => Number(b.pass) - Number(a.pass) || b.robust - a.robust);

  // 比較用：いまの設定
  const current = metricsOf(simulate(prep, base, { ...env, fromTs: trainFrom, toTs: now }), base);
  return {
    symbol,
    spreadPips: round(spread / pip, 2),
    tested: scored.length,
    best: top[0] || null,
    top: top.slice(0, 3),
    current,
  };
}

export async function runOptimize({ apply = false, symbols } = {}) {
  const now = Date.now();
  const ok = await acquireLock(K.optimizeLock, 290);
  if (!ok) throw new Error("最適化を実行中です。少し待ってください");
  try {
    const base = mergeConfig(await redis.get(K.config));
    const list = (symbols?.length ? symbols : SYMBOLS).filter((s) => SYMBOLS.includes(s));
    const results = [];
    for (const s of list) {
      try {
        results.push(await optimizeSymbol(s, base, now));
      } catch (e) {
        results.push({ symbol: s, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const passing = results.filter((r) => r.best?.pass);
    passing.sort((a, b) => b.best.robust - a.best.robust || b.best.test.net - a.best.test.net);
    const pick = passing[0]
      ? { symbol: passing[0].symbol, params: passing[0].best.params, label: passing[0].best.label }
      : null;

    let applied = null;
    const cfg = mergeConfig(await redis.get(K.config));
    if (apply && cfg.symbolMode === "auto") {
      const pos = await redis.get(K.position);
      if (pos) {
        applied = { status: "skipped", why: "ポジション保有中のため、決済後に切り替えます" };
      } else if (pick) {
        const next = {
          ...cfg,
          ...pick.params,
          symbol: pick.symbol,
          autoBlocked: false,
          autoPickAt: now,
        };
        await redis.set(K.config, next);
        if (pick.symbol !== cfg.symbol) await redis.del(K.regime, K.lastSignal);
        await addLog(
          `AIおまかせ：${pick.symbol.replace("_", "/")}を選択（${pick.label}）`,
          "regime",
        );
        applied = { status: "applied", symbol: pick.symbol };
      } else {
        await redis.set(K.config, { ...cfg, autoBlocked: true, autoPickAt: now });
        await addLog(
          "AIおまかせ：検証に合格した銘柄・設定がないため、新規エントリーを止めます",
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
      note: "前半14日で設定を選び、後半6日で通用したかを確認。相場判定はClaudeではなく機械判定で代用。",
    };
    await redis.set(K.optimizeLast, out, { ex: 60 * 60 * 24 * 30 });
    return out;
  } finally {
    await redis.del(K.optimizeLock);
  }
}
