// 相場判定：監視中の全銘柄を、議長1回・反論役1回でまとめて判定する（APIの呼び出し回数を増やさない）
import { briefText } from "./brief.js";
import { arr, askClaude } from "./claude.js";
import { regimeFreshness } from "./engine.js";
import { closedOnly, getRecentKlines, getTickers } from "./gmo.js";
import { atr, ema } from "./indicators.js";
import { ensureLevels, levelsSummaryText } from "./levels.js";
import { K, acquireLock, addLog, redis } from "./redis.js";
import {
  businessDate,
  clamp,
  hmToTs,
  isCrypto,
  jstHM,
  jstLabel,
  mergeConfig,
  pipSize,
  portfolioOf,
  priceDigits,
  round,
} from "./util.js";

const MODES = ["TREND_UP", "TREND_DOWN", "RANGE", "NO_TRADE"];
const ALLOWS = ["LONG", "SHORT", "BOTH", "NONE"];
export const MODE_JP = {
  TREND_UP: "上昇トレンド",
  TREND_DOWN: "下降トレンド",
  RANGE: "レンジ",
  NO_TRADE: "見送り",
};

const CHAIR_SYSTEM = `あなたは自動売買システムの「議長」です。テクニカル担当として各銘柄の相場の形を読み、ファンダ担当のブリーフと水平線マップを統合して、銘柄ごとの取引方針を決めます。
前提知識（FX）:
- 東京は実需中心で仲値(9:55)前後にドル買いが出やすい。ロンドン序盤(16-18時)は方向が出やすい。NY(21時以降)は指標で急変しやすい。早朝(5-8時)はスプレッドが広がる。
- 五十日（5・10日）は仲値に向けたドル需要が出やすい。月曜早朝は窓開け、金曜NY後半は手仕舞いで荒れやすい。
- ドル円は介入警戒水準付近で上値が重くなる。ポンドは急変しやすい。円クロスは同じ方向に動きやすい。
前提知識（暗号資産）:
- 24時間365日動く。米国株・米金利・ドル、ETFの資金流出入、規制、ハッキング、大口の送金に反応しやすい。週末は薄商いで急変しやすい。
共通:
- 週足・日足の水平線付近は反発・もみ合いが起きやすい。重要指標の前後、要人発言中、薄商いは「やらない場面」。
原則: 迷ったら見送り。確信度は正直に付ける。銘柄ごとに独立して判断する。発注はプログラムが行う。`;

const CRITIC_SYSTEM = `あなたは自動売買システムの「反論役」です。議長が出した銘柄ごとの方針の弱点・見落とし・楽観を指摘するのが仕事です。
- 議長に同調しない。根拠の薄さ、逆方向のシナリオ、近すぎる水平線、指標やニュースのリスク、時間帯の悪さ、銘柄どうしの偏り（円売りが重なる等）を具体的に突く。
- ただし根拠のない反対はしない。問題がなければ AGREE でよい。
- 判定: AGREE（問題なし）/ WEAKEN（確信度を下げる、片方向に絞る）/ VETO（取引すべきでない）。`;

function bars(candles, d) {
  return candles
    .map(
      (c) =>
        `${jstHM(c.t)},${c.o.toFixed(d)},${c.h.toFixed(d)},${c.l.toFixed(d)},${c.c.toFixed(d)}`,
    )
    .join("\n");
}

function symbolBlock({ symbol, t, h1, m5, levels }) {
  const pip = pipSize(symbol, (t.bid + t.ask) / 2);
  const u = isCrypto(symbol) ? "bp" : "pips";
  const d = priceDigits(symbol);
  const h1c = h1.map((c) => c.c);
  const e20 = ema(h1c, 20).at(-1);
  const e50 = ema(h1c, 50).at(-1);
  const h1atr = atr(h1, 14).at(-1);
  const m5atr = atr(m5, 14).at(-1);
  const m5last = m5.slice(-24);
  const chg2h = m5last.length ? (m5last.at(-1).c - m5last[0].o) / pip : null;
  const f = (v) => (v === null || v === undefined ? "不明" : Number(v).toFixed(d));
  return `## ${symbol}（${isCrypto(symbol) ? "暗号資産・単位bp=価格の0.01%" : "FX・単位pips"}）
レート bid ${t.bid.toFixed(d)} / ask ${t.ask.toFixed(d)}（スプレッド ${round((t.ask - t.bid) / pip, 1)} ${u}）
1時間足 EMA20=${f(e20)} / EMA50=${f(e50)}、ATR14: 1時間足 ${h1atr ? round(h1atr / pip, 1) : "不明"} ${u} / 5分足 ${m5atr ? round(m5atr / pip, 1) : "不明"} ${u}、直近2時間 ${chg2h === null ? "不明" : `${round(chg2h, 1)} ${u}`}
水平線: ${levelsSummaryText(levels).replace(/\n/g, " ／ ")}
1時間足 直近18本（JST開始,始,高,安,終）
${bars(h1.slice(-18), d)}
5分足 直近24本
${bars(m5last, d)}`;
}

function normalizeOne(j, now) {
  const mode = MODES.includes(j?.mode) ? j.mode : "NO_TRADE";
  let allow = ALLOWS.includes(j?.allow) ? j.allow : "NONE";
  const confidence = clamp(Math.round(Number(j?.confidence) || 0), 0, 100);
  if (mode === "TREND_UP" && allow !== "NONE") allow = "LONG";
  if (mode === "TREND_DOWN" && allow !== "NONE") allow = "SHORT";
  if (mode === "NO_TRADE") allow = "NONE";
  const pause = j?.pause_until_jst ? hmToTs(j.pause_until_jst, now) : null;
  const sp = Number(j?.max_spread_pips);
  return {
    mode,
    allow,
    confidence,
    max_spread_pips: sp > 0 ? sp : null,
    pauseUntilTs: pause && pause > now ? pause : null,
    summary: String(j?.summary || "").slice(0, 120),
    technical: arr(j?.technical, 4),
    fundamental: arr(j?.fundamental, 4),
    reasons: arr(j?.reasons, 4),
    events: [],
  };
}

function applyCritic(r, c) {
  if (!c) return { ...r, chairMode: r.mode, chairConfidence: r.confidence, critic: null };
  const verdict = ["AGREE", "WEAKEN", "VETO"].includes(c?.verdict) ? c.verdict : "WEAKEN";
  const delta = clamp(Math.round(Number(c?.confidence_delta) || 0), -50, 0);
  const critic = {
    verdict,
    confidence_delta: verdict === "AGREE" ? 0 : delta,
    objections: arr(c?.objections, 4),
    missed_risks: arr(c?.missed_risks, 4),
    summary: String(c?.summary || "").slice(0, 80),
  };
  const out = { ...r, chairMode: r.mode, chairConfidence: r.confidence, critic };
  if (verdict === "VETO") {
    out.mode = "NO_TRADE";
    out.allow = "NONE";
  } else if (verdict === "WEAKEN") {
    out.confidence = clamp(r.confidence + critic.confidence_delta, 0, 100);
    if (r.mode === "RANGE" && ["LONG", "SHORT"].includes(c?.allow_override))
      out.allow = c.allow_override;
  }
  if (out.mode !== "NO_TRADE" && out.confidence < 45) {
    out.mode = "NO_TRADE";
    out.allow = "NONE";
  }
  return out;
}

async function fetchTickersFor(symbols) {
  const needFx = symbols.some((s) => !isCrypto(s));
  const needCr = symbols.some(isCrypto);
  const [a, b] = await Promise.all([
    needFx ? getTickers() : Promise.resolve({}),
    needCr ? getTickers("BTC_JPY") : Promise.resolve({}),
  ]);
  return { ...a, ...b };
}

export async function runRegime({ force = false } = {}) {
  const now = Date.now();
  const [stored, current] = await redis.mget(K.config, K.regime);
  const cfg = mergeConfig(stored);
  if (!force && current && !regimeFreshness(current, cfg, now).stale)
    return { regime: current, skipped: true };
  const symbols = portfolioOf(cfg)
    .map((p) => p.symbol)
    .slice(0, 6);
  if (!symbols.length) return { regime: current, skipped: true, error: "監視する銘柄がありません" };
  const ok = await acquireLock(K.regimeLock, 280);
  if (!ok) return { regime: current, busy: true };
  try {
    const bd = businessDate(now);
    const [tickers, brief, ...per] = await Promise.all([
      fetchTickersFor(symbols),
      redis.get(K.brief("ALL", bd)),
      ...symbols.map((s) =>
        Promise.all([
          getRecentKlines(s, "5min", now, 2),
          getRecentKlines(s, "1hour", now, 4),
          ensureLevels(s).catch(() => null),
        ]),
      ),
    ]);
    const blocks = [];
    const live = [];
    symbols.forEach((s, i) => {
      const t = tickers[s];
      if (!t) return;
      const [m5raw, h1raw, levels] = per[i];
      live.push(s);
      blocks.push(
        symbolBlock({
          symbol: s,
          t,
          m5: closedOnly(m5raw, "5min", now),
          h1: closedOnly(h1raw, "1hour", now),
          levels,
        }),
      );
    });
    if (!live.length) throw new Error("どの銘柄もレートを取得できません");

    const common = `現在時刻: ${jstLabel(now)}
監視銘柄: ${live.join("、")}

# 本日のブリーフ（ファンダ担当・事実確認済み）
${briefText(brief)}

# 銘柄ごとのデータ
${blocks.join("\n\n")}`;

    const shape = `{"summary":"全体の地合い60字以内","events":[{"time_jst":"HH:MM","name":"指標名","currency":"USD","impact":"high|medium"}],"symbols":{${live
      .map(
        (s) =>
          `"${s}":{"mode":"TREND_UP|TREND_DOWN|RANGE|NO_TRADE","allow":"LONG|SHORT|BOTH|NONE","confidence":0-100,"max_spread_pips":数値,"pause_until_jst":"HH:MM"またはnull,"summary":"40字以内","technical":["根拠"],"fundamental":["根拠"],"reasons":["総合"]}`,
      )
      .join(",")}}}`;

    const chairPrompt = `${common}

# 手順
1. ${brief ? "ブリーフ作成後の最新ニュースだけ、必要ならweb_searchで確認する（最大2回）。" : "web_searchで本日の重要指標と直近ニュースを確認する（最大4回）。"}
2. 銘柄ごとに、週足・日足の位置 → 1時間足の流れ → 5分足の形 の順に見て、今後${cfg.regimeIntervalMin}分間の方針を決める。

# 判定ルール
- 重要指標の発表前30分〜発表後15分、急変直後、方向感が読めない場合は NO_TRADE。
- 上昇が明確なら TREND_UP（allow=LONG）、下降が明確なら TREND_DOWN（allow=SHORT）、往来なら RANGE（allow=BOTH、偏りがあれば片側）。
- 強い水平線の直前では、そこへ向かう方向の取引を避ける。
- max_spread_pips はその銘柄の単位（FXはpips、暗号資産はbp）で答える。

# 出力（JSONのみ）
${shape}`;

    const chairRes = await askClaude({
      system: CHAIR_SYSTEM,
      prompt: chairPrompt,
      searches: brief ? 2 : 4,
      maxTokens: 1200 + 700 * live.length,
    });
    const cj = chairRes.json || {};
    const globalEvents = (Array.isArray(cj.events) ? cj.events : []).slice(0, 8).map((e) => ({
      time_jst: String(e?.time_jst || ""),
      name: String(e?.name || "").slice(0, 60),
      currency: String(e?.currency || "")
        .toUpperCase()
        .slice(0, 6),
      impact: e?.impact === "high" ? "high" : "medium",
      ts: hmToTs(e?.time_jst, now),
    }));
    const chair = {};
    for (const s of live) chair[s] = normalizeOne(cj.symbols?.[s], now);

    // 反論役：取引する候補がある銘柄だけ
    const active = live.filter((s) => chair[s].mode !== "NO_TRADE");
    let cr = {};
    if (active.length) {
      const view = Object.fromEntries(
        active.map((s) => [
          s,
          {
            mode: chair[s].mode,
            allow: chair[s].allow,
            confidence: chair[s].confidence,
            summary: chair[s].summary,
            technical: chair[s].technical,
            fundamental: chair[s].fundamental,
            reasons: chair[s].reasons,
          },
        ]),
      );
      const criticPrompt = `${common}

# 議長の方針（見送り以外）
${JSON.stringify(view, null, 1)}

# やること
銘柄ごとに反論する。見落としているリスク、逆方向のシナリオ、近すぎる水平線、指標・時間帯の問題、銘柄どうしの偏りを具体的に挙げる。

# 出力（JSONのみ）
{"symbols":{${active
        .map(
          (s) =>
            `"${s}":{"verdict":"AGREE|WEAKEN|VETO","confidence_delta":-50から0,"allow_override":"LONG|SHORT|null","objections":["反論"],"missed_risks":["リスク"],"summary":"30字以内"}`,
        )
        .join(",")}}}`;
      const criticRes = await askClaude({
        system: CRITIC_SYSTEM,
        prompt: criticPrompt,
        maxTokens: 600 + 400 * active.length,
      });
      cr = criticRes.json?.symbols || {};
    }

    const out = {};
    for (const s of live)
      out[s] = applyCritic(chair[s], chair[s].mode === "NO_TRADE" ? null : cr[s]);
    const regime = {
      at: now,
      model: chairRes.model,
      summary: String(cj.summary || "").slice(0, 120),
      events: globalEvents.filter((e) => e.ts),
      symbols: out,
    };
    await redis.set(K.regime, regime);
    const go = live.filter((s) => out[s].mode !== "NO_TRADE");
    await addLog(
      `AI判定：${go.length ? go.map((s) => `${s.replace("_", "/")} ${MODE_JP[out[s].mode]}(${out[s].confidence}%)`).join("、") : "全銘柄見送り"}`,
      "regime",
    );
    return { regime };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const retryIn = Math.max(0, cfg.regimeIntervalMin - 3) * 60000;
    const fallback = {
      at: now - retryIn,
      error: true,
      summary: `判定に失敗したため見送り：${msg}`,
      events: [],
      symbols: {},
    };
    await redis.set(K.regime, fallback);
    await addLog(`AI判定に失敗：${msg}`, "error");
    return { regime: fallback, error: msg };
  } finally {
    await redis.del(K.regimeLock);
  }
}
