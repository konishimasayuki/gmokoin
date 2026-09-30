// 15分ごとの相場判定：議長（テクニカル＋統合）→ 反論役
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

const CHAIR_SYSTEM = `あなたはFXスキャルピング自動売買システムの「議長」です。テクニカル担当として相場の形を読み、ファンダ担当のブリーフと水平線マップを統合して、今後の取引方針を1つに決めます。
前提知識:
- 時間帯の癖：東京は実需中心で仲値(9:55)前後にドル買いが出やすい。ロンドン序盤(16-18時)は方向が出やすい。NY(21時以降)は指標で急変しやすい。早朝(5-8時)はスプレッドが広がるので取引しない。
- 五十日（5・10日）は仲値に向けたドル需要が出やすい。
- 月曜早朝は窓開け、金曜NY後半は手仕舞いで動きが荒れやすい。
- ドル円は財務省・日銀の介入警戒水準付近で上値が重くなる。ポンドは急変しやすい。
- 週足・日足の水平線付近は反発・もみ合いが起きやすく、スキャルでは直前での逆張りの的になりやすい。
- 重要指標の前後、要人発言中、薄商いは「やらない場面」。
原則: 迷ったら見送り。確信度は正直に付ける。発注はプログラムが行う。`;

const CRITIC_SYSTEM = `あなたはFX自動売買システムの「反論役」です。議長が出した取引方針の弱点・見落とし・楽観を指摘するのが仕事です。
- 議長に同調しない。根拠の薄さ、逆方向のシナリオ、直近の水平線、指標やニュースのリスク、時間帯の悪さを具体的に突く。
- ただし根拠のない反対はしない。問題がなければ AGREE でよい。
- 判定: AGREE（問題なし）/ WEAKEN（弱める＝確信度を下げる、片方向に絞る）/ VETO（取引すべきでない）。`;

function bars(candles, d) {
  return candles
    .map(
      (c) =>
        `${jstHM(c.t)},${c.o.toFixed(d)},${c.h.toFixed(d)},${c.l.toFixed(d)},${c.c.toFixed(d)}`,
    )
    .join("\n");
}

function marketBlock({ cfg, now, t, h1, m5, levels, brief }) {
  const sym = cfg.symbol;
  const [base, quote] = sym.split("_");
  const pip = pipSize(sym, (t.bid + t.ask) / 2);
  const u = isCrypto(sym) ? "bp（価格の0.01%）" : "pips";
  const d = priceDigits(sym);
  const h1c = h1.map((c) => c.c);
  const e20 = ema(h1c, 20).at(-1);
  const e50 = ema(h1c, 50).at(-1);
  const h1atr = atr(h1, 14).at(-1);
  const m5atr = atr(m5, 14).at(-1);
  const m5last = m5.slice(-48);
  const chg4h = m5last.length ? (m5last.at(-1).c - m5last[0].o) / pip : null;
  const f = (v) => (v === null || v === undefined ? "不明" : Number(v).toFixed(d));
  return `# 対象
銘柄: ${base}/${quote}
現在時刻: ${jstLabel(now)}
現在レート: bid ${t.bid.toFixed(d)} / ask ${t.ask.toFixed(d)}（スプレッド ${round((t.ask - t.bid) / pip, 1)} ${u}）

# 水平線マップ（プログラムで計算済み）
${levelsSummaryText(levels)}

# 本日のブリーフ（ファンダ担当・事実確認済み）
${briefText(brief)}

# 1時間足（JST開始,始,高,安,終）直近${Math.min(36, h1.length)}本
${bars(h1.slice(-36), d)}

# 5分足 直近${m5last.length}本
${bars(m5last, d)}

# 参考指標
1時間足 EMA20=${f(e20)} / EMA50=${f(e50)}
ATR14: 1時間足 ${h1atr ? round(h1atr / pip, 1) : "不明"} ${u} / 5分足 ${m5atr ? round(m5atr / pip, 1) : "不明"} ${u}
直近4時間の変化: ${chg4h === null ? "不明" : `${round(chg4h, 1)} ${u}`}${isCrypto(sym) ? "\n※暗号資産（取引所レバレッジ、最大2倍）。24時間365日取引され、経済指標よりも米国株・金利・ETF資金流出入・規制・大口の動きに反応しやすい。max_spread_pips は bp 単位で答える。" : ""}`;
}

function chairPrompt(block, cfg, hasBrief) {
  return `${block}

# 手順
1. ${hasBrief ? "ブリーフ作成後の最新ニュースだけ、必要ならweb_searchで確認する（最大2回）。" : "web_searchで本日の重要指標と直近ニュースを確認する（最大4回）。"}
2. 週足・日足の位置 → 1時間足の流れ → 5分足の形 の順に見て、今後${cfg.regimeIntervalMin}分間の方針を決める。

# 判定ルール
- 重要指標の発表前30分〜発表後15分、急変直後、方向感が読めない場合は NO_TRADE。
- 上昇が明確なら TREND_UP（allow=LONG）、下降が明確なら TREND_DOWN（allow=SHORT）、往来なら RANGE（allow=BOTH、偏りがあれば片側）。
- 強い水平線の直前では、そこへ向かう方向の取引を避ける。
- pause_until_jst は停止すべき時刻があれば "HH:MM"、なければ null。events は今後12時間以内の重要イベント（最大6件）。

# 出力（JSONのみ）
{"mode":"TREND_UP|TREND_DOWN|RANGE|NO_TRADE","allow":"LONG|SHORT|BOTH|NONE","confidence":0から100の整数,"max_spread_pips":数値,"pause_until_jst":"HH:MM"またはnull,"events":[{"time_jst":"HH:MM","name":"指標名","impact":"high|medium"}],"summary":"60字以内","technical":["テクニカル根拠"],"fundamental":["ファンダ根拠"],"reasons":["総合判断の根拠"]}`;
}

function criticPrompt(block, chair) {
  return `${block}

# 議長の方針
${JSON.stringify(
  {
    mode: chair.mode,
    allow: chair.allow,
    confidence: chair.confidence,
    summary: chair.summary,
    technical: chair.technical,
    fundamental: chair.fundamental,
    reasons: chair.reasons,
  },
  null,
  1,
)}

# やること
この方針に反論する。見落としているリスク、逆方向のシナリオ、近すぎる水平線、指標・時間帯の問題を具体的に挙げる。

# 出力（JSONのみ）
{"verdict":"AGREE|WEAKEN|VETO","confidence_delta":-50から0の整数,"allow_override":"LONG|SHORT|null","objections":["反論"],"missed_risks":["見落としリスク"],"summary":"40字以内"}`;
}

function normalizeChair(j, now) {
  const mode = MODES.includes(j?.mode) ? j.mode : "NO_TRADE";
  let allow = ALLOWS.includes(j?.allow) ? j.allow : "NONE";
  const confidence = clamp(Math.round(Number(j?.confidence) || 0), 0, 100);
  if (mode === "TREND_UP" && allow !== "NONE") allow = "LONG";
  if (mode === "TREND_DOWN" && allow !== "NONE") allow = "SHORT";
  if (mode === "NO_TRADE") allow = "NONE";
  const events = (Array.isArray(j?.events) ? j.events : []).slice(0, 8).map((e) => ({
    time_jst: String(e?.time_jst || ""),
    name: String(e?.name || "").slice(0, 60),
    impact: e?.impact === "high" ? "high" : e?.impact === "low" ? "low" : "medium",
    ts: hmToTs(e?.time_jst, now),
  }));
  const pause = j?.pause_until_jst ? hmToTs(j.pause_until_jst, now) : null;
  const sp = Number(j?.max_spread_pips);
  return {
    mode,
    allow,
    confidence,
    max_spread_pips: sp > 0 ? sp : null,
    pauseUntilTs: pause && pause > now ? pause : null,
    events: events.filter((e) => e.ts),
    summary: String(j?.summary || "").slice(0, 120),
    technical: arr(j?.technical, 5),
    fundamental: arr(j?.fundamental, 5),
    reasons: arr(j?.reasons, 5),
  };
}

function applyCritic(chair, c) {
  const verdict = ["AGREE", "WEAKEN", "VETO"].includes(c?.verdict) ? c.verdict : "WEAKEN";
  const delta = clamp(Math.round(Number(c?.confidence_delta) || 0), -50, 0);
  const critic = {
    verdict,
    confidence_delta: verdict === "AGREE" ? 0 : delta,
    objections: arr(c?.objections, 5),
    missed_risks: arr(c?.missed_risks, 5),
    summary: String(c?.summary || "").slice(0, 80),
  };
  const out = { ...chair, chairMode: chair.mode, chairConfidence: chair.confidence, critic };
  if (verdict === "VETO") {
    out.mode = "NO_TRADE";
    out.allow = "NONE";
  } else if (verdict === "WEAKEN") {
    out.confidence = clamp(chair.confidence + critic.confidence_delta, 0, 100);
    if (chair.mode === "RANGE" && ["LONG", "SHORT"].includes(c?.allow_override))
      out.allow = c.allow_override;
  }
  return out;
}

export async function runRegime({ force = false } = {}) {
  const now = Date.now();
  const [stored, current] = await redis.mget(K.config, K.regime);
  const cfg = mergeConfig(stored);
  if (!force && current && !regimeFreshness(current, cfg, now).stale)
    return { regime: current, skipped: true };
  const ok = await acquireLock(K.regimeLock, 240);
  if (!ok) return { regime: current, busy: true };
  try {
    const [tickers, m5raw, h1raw, levels, brief] = await Promise.all([
      getTickers(cfg.symbol),
      getRecentKlines(cfg.symbol, "5min", now, 2),
      getRecentKlines(cfg.symbol, "1hour", now, 4),
      ensureLevels(cfg.symbol).catch(() => null),
      redis.get(K.brief(cfg.symbol, businessDate(now))),
    ]);
    const t = tickers[cfg.symbol];
    if (!t) throw new Error(`${cfg.symbol}のレートを取得できません`);
    const block = marketBlock({
      cfg,
      now,
      t,
      h1: closedOnly(h1raw, "1hour", now),
      m5: closedOnly(m5raw, "5min", now),
      levels,
      brief,
    });

    const chairRes = await askClaude({
      system: CHAIR_SYSTEM,
      prompt: chairPrompt(block, cfg, Boolean(brief)),
      searches: brief ? 2 : 4,
    });
    const chair = normalizeChair(chairRes.json, now);

    let regime;
    if (chair.mode === "NO_TRADE") {
      regime = { ...chair, chairMode: chair.mode, chairConfidence: chair.confidence, critic: null };
    } else {
      const criticRes = await askClaude({
        system: CRITIC_SYSTEM,
        prompt: criticPrompt(block, chair),
        maxTokens: 1500,
      });
      regime = applyCritic(chair, criticRes.json);
    }
    if (regime.mode !== "NO_TRADE" && regime.confidence < 45) {
      regime.mode = "NO_TRADE";
      regime.allow = "NONE";
    }
    regime = { ...regime, symbol: cfg.symbol, model: chairRes.model, at: now };
    await redis.set(K.regime, regime);
    const cv = regime.critic
      ? `・反論役${{ AGREE: "同意", WEAKEN: "弱め", VETO: "却下" }[regime.critic.verdict]}`
      : "";
    await addLog(
      `Claude判定：${MODE_JP[regime.mode]}（確信度${regime.confidence}%${cv}）${regime.summary}`,
      "regime",
    );
    return { regime };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const retryIn = Math.max(0, cfg.regimeIntervalMin - 3) * 60000;
    const fallback = {
      mode: "NO_TRADE",
      allow: "NONE",
      confidence: 0,
      max_spread_pips: null,
      pauseUntilTs: null,
      events: [],
      summary: "判定に失敗したため見送り",
      technical: [],
      fundamental: [],
      reasons: [msg],
      critic: null,
      symbol: cfg.symbol,
      model: null,
      at: now - retryIn,
      error: true,
    };
    await redis.set(K.regime, fallback);
    await addLog(`Claude判定に失敗：${msg}`, "error");
    return { regime: fallback, error: msg };
  } finally {
    await redis.del(K.regimeLock);
  }
}
