import { regimeFreshness } from "./engine.js";
import { closedOnly, getRecentKlines, getTickers } from "./gmo.js";
import { atr, ema } from "./indicators.js";
import { K, acquireLock, addLog, redis } from "./redis.js";
import {
  clamp,
  hmToTs,
  jstHM,
  jstLabel,
  mergeConfig,
  pipSize,
  priceDigits,
  round,
} from "./util.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const MODES = ["TREND_UP", "TREND_DOWN", "RANGE", "NO_TRADE"];
const ALLOWS = ["LONG", "SHORT", "BOTH", "NONE"];
export const MODE_JP = {
  TREND_UP: "上昇トレンド",
  TREND_DOWN: "下降トレンド",
  RANGE: "レンジ",
  NO_TRADE: "見送り",
};

function tryParse(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

export function extractJson(text) {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const j = tryParse(fences[i][1]);
    if (j) return j;
  }
  const re = /\{\s*"mode"/g;
  let start = -1;
  let m = re.exec(text);
  while (m) {
    start = m.index;
    m = re.exec(text);
  }
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const j = tryParse(text.slice(start, end + 1));
    if (j) return j;
  }
  const a = text.indexOf("{");
  if (a >= 0 && end > a) return tryParse(text.slice(a, end + 1));
  return null;
}

async function askClaude(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY が未設定です");
  const model = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
  const headers = {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
  };
  // ワークスペースに紐づかないキーを使う場合のみ指定
  if (process.env.ANTHROPIC_WORKSPACE_ID) {
    headers["anthropic-workspace-id"] = process.env.ANTHROPIC_WORKSPACE_ID;
  }
  const messages = [{ role: "user", content: prompt }];
  let data = null;
  for (let round_ = 0; round_ < 3; round_++) {
    const r = await fetch(API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 2500,
        messages,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
      }),
    });
    data = await r.json().catch(() => null);
    if (!r.ok || !data)
      throw new Error(`Claude APIエラー: ${data?.error?.message || `HTTP ${r.status}`}`);
    if (data.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: data.content });
      continue;
    }
    break;
  }
  const text = (data?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const json = extractJson(text);
  if (!json) throw new Error("Claudeの回答からJSONを読み取れませんでした");
  return { json, model };
}

function bars(candles, digits) {
  return candles
    .map(
      (c) =>
        `${jstHM(c.t)},${c.o.toFixed(digits)},${c.h.toFixed(digits)},${c.l.toFixed(digits)},${c.c.toFixed(digits)}`,
    )
    .join("\n");
}

function buildPrompt({ cfg, now, t, h1, m5 }) {
  const sym = cfg.symbol;
  const [base, quote] = sym.split("_");
  const pip = pipSize(sym);
  const d = priceDigits(sym);
  const h1c = h1.map((c) => c.c);
  const e20 = ema(h1c, 20).at(-1);
  const e50 = ema(h1c, 50).at(-1);
  const h1atr = atr(h1, 14).at(-1);
  const m5atr = atr(m5, 14).at(-1);
  const m5last = m5.slice(-48);
  const chg4h = m5last.length ? (m5last.at(-1).c - m5last[0].o) / pip : null;
  const f = (v, dd = d) => (v === null || v === undefined ? "不明" : Number(v).toFixed(dd));
  const iv = cfg.regimeIntervalMin;

  return `あなたはFXスキャルピングBot（ペーパートレード）の「相場環境判定」担当です。発注はプログラムが行い、あなたは今後${iv}分間の取引方針だけを決めます。

# 対象
銘柄: ${base}/${quote}
現在時刻: ${jstLabel(now)}
現在レート: bid ${t.bid.toFixed(d)} / ask ${t.ask.toFixed(d)}（スプレッド ${round((t.ask - t.bid) / pip, 1)} pips）

# 1時間足（JST開始時刻,始値,高値,安値,終値）直近${Math.min(36, h1.length)}本
${bars(h1.slice(-36), d)}

# 5分足（JST開始時刻,始値,高値,安値,終値）直近${m5last.length}本
${bars(m5last, d)}

# 参考指標
1時間足 EMA20=${f(e20)} / EMA50=${f(e50)}
ATR14: 1時間足 ${h1atr ? round(h1atr / pip, 1) : "不明"} pips / 5分足 ${m5atr ? round(m5atr / pip, 1) : "不明"} pips
直近4時間の変化: ${chg4h === null ? "不明" : `${round(chg4h, 1)} pips`}

# 手順
1. web_searchで、本日と今後12時間の${base}・${quote}関連の重要経済指標（発表時刻はJSTで）と、直近の要人発言・中央銀行関連ニュースを確認する。検索は最大4回。
2. チャートと合わせて方針を決める。

# 判定ルール
- 重要指標の発表前30分〜発表後15分にかかる、急変の直後、方向感が読めない場合は NO_TRADE。
- 上昇トレンドが明確なら TREND_UP（allowはLONG）、下降が明確なら TREND_DOWN（allowはSHORT）。
- 往来相場なら RANGE（allowはBOTH。偏りがあれば片側のみ）。
- 迷ったら NO_TRADE。確信度は正直に付ける。
- max_spread_pips は通常時のスプレッドを踏まえた許容上限（例 0.8）。
- pause_until_jst は取引を止めるべき時刻があれば "HH:MM"、なければ null。
- events は今後12時間以内の重要イベント（最大6件、JST時刻）。

# 出力
最後に次のJSONだけを出力する（前置き・説明文は不要）:
{"mode":"TREND_UP|TREND_DOWN|RANGE|NO_TRADE","allow":"LONG|SHORT|BOTH|NONE","confidence":0から100の整数,"max_spread_pips":数値,"pause_until_jst":"HH:MM"またはnull,"events":[{"time_jst":"HH:MM","name":"指標名","impact":"high|medium"}],"summary":"60字以内の要約","reasons":["根拠1","根拠2"],"sources_note":"確認した情報の出所を簡潔に"}`;
}

function normalize(j, now, cfg, model) {
  let mode = MODES.includes(j?.mode) ? j.mode : "NO_TRADE";
  let allow = ALLOWS.includes(j?.allow) ? j.allow : "NONE";
  const confidence = clamp(Math.round(Number(j?.confidence) || 0), 0, 100);
  if (confidence < 35) mode = "NO_TRADE";
  if (mode === "NO_TRADE") allow = "NONE";
  if (mode === "TREND_UP" && allow !== "NONE") allow = "LONG";
  if (mode === "TREND_DOWN" && allow !== "NONE") allow = "SHORT";
  if (mode === "RANGE" && allow === "NONE") mode = "NO_TRADE";
  const events = (Array.isArray(j?.events) ? j.events : [])
    .slice(0, 8)
    .map((e) => ({
      time_jst: String(e?.time_jst || ""),
      name: String(e?.name || "").slice(0, 60),
      impact: e?.impact === "high" ? "high" : e?.impact === "low" ? "low" : "medium",
      ts: hmToTs(e?.time_jst, now),
    }))
    .filter((e) => e.ts);
  const pause = j?.pause_until_jst ? hmToTs(j.pause_until_jst, now) : null;
  const sp = Number(j?.max_spread_pips);
  return {
    mode,
    allow,
    confidence,
    max_spread_pips: sp > 0 ? sp : null,
    pauseUntilTs: pause && pause > now ? pause : null,
    events,
    summary: String(j?.summary || "").slice(0, 120),
    reasons: (Array.isArray(j?.reasons) ? j.reasons : [])
      .slice(0, 5)
      .map((s) => String(s).slice(0, 140)),
    sources_note: String(j?.sources_note || "").slice(0, 200),
    symbol: cfg.symbol,
    model,
    at: now,
  };
}

export async function runRegime({ force = false } = {}) {
  const now = Date.now();
  const [stored, current] = await redis.mget(K.config, K.regime);
  const cfg = mergeConfig(stored);
  if (!force && current && !regimeFreshness(current, cfg, now).stale) {
    return { regime: current, skipped: true };
  }
  const ok = await acquireLock(K.regimeLock, 150);
  if (!ok) return { regime: current, busy: true };
  try {
    const [tickers, m5raw, h1raw] = await Promise.all([
      getTickers(),
      getRecentKlines(cfg.symbol, "5min", now, 2),
      getRecentKlines(cfg.symbol, "1hour", now, 4),
    ]);
    const t = tickers[cfg.symbol];
    if (!t) throw new Error(`${cfg.symbol}のレートを取得できません`);
    const m5 = closedOnly(m5raw, "5min", now);
    const h1 = closedOnly(h1raw, "1hour", now);
    const prompt = buildPrompt({ cfg, now, t, h1, m5 });
    const { json, model } = await askClaude(prompt);
    const regime = normalize(json, now, cfg, model);
    await redis.set(K.regime, regime);
    await addLog(
      `Claude判定：${MODE_JP[regime.mode]}（確信度${regime.confidence}%）${regime.summary}`,
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
      reasons: [msg],
      sources_note: "",
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
