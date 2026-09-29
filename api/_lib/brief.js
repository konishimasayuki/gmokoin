// 毎朝のブリーフ：ファンダ担当＋事実確認担当
import { arr, askClaude } from "./claude.js";
import { K, acquireLock, addLog, redis } from "./redis.js";
import { businessDate, businessHmToTs, jstLabel, mergeConfig } from "./util.js";

const SYSTEM = `あなたはFX自動売買システムの「ファンダメンタル担当」兼「事実確認担当」です。
- 役割は、今日の取引に影響する経済指標とニュースを、事実ベースで整理すること。売買の指示は出さない。
- 検索で確認できた事実と、推測・噂を必ず区別する。確認できないものは「未確認」とする。
- 見出しだけの誇張や、古いニュースの再掲に注意する。日付を必ず確認する。
- 指標の典型的な値動き（予想比上振れならどちらに動きやすいか等）は一般論として簡潔に。
- 時刻はすべて日本時間(JST)の "HH:MM"。`;

function prompt({ symbol, now, bd }) {
  const [base, quote] = symbol.split("_");
  return `# 対象
銘柄: ${base}/${quote}
現在: ${jstLabel(now)}（取引日 ${bd}、日本時間6:00区切り）

# やること
1. web_searchで、今日（取引日内）と今週の ${base}・${quote} 関連の重要経済指標を調べる（発表時刻JST、予想、前回）。
2. 直近24時間の要人発言・中銀・地政学などのニュースを調べ、事実関係を確認する。
3. 各ニュースを「確認済み／未確認／誇張の可能性」に分類する。

# 出力（JSONのみ）
{"summary":"今日の地合いを80字以内で","events":[{"time_jst":"HH:MM","name":"指標名","currency":"USD","impact":"high|medium","forecast":"予想","previous":"前回","typical_reaction":"上振れ時の典型的な反応"}],"week_events":[{"day":"10/2(木)","time_jst":"HH:MM","name":"指標名","impact":"high|medium"}],"news":[{"fact":"事実だけを簡潔に","source":"出所","status":"確認済み|未確認|誇張の可能性"}],"caution":"特に注意すべき点"}`;
}

export function briefStale(brief, now) {
  return !brief || brief.bd !== businessDate(now);
}

export async function runBrief({ force = false } = {}) {
  const now = Date.now();
  const bd = businessDate(now);
  const cfg = mergeConfig(await redis.get(K.config));
  const key = K.brief(cfg.symbol, bd);
  const cur = await redis.get(key);
  if (cur && !force) return { brief: cur, skipped: true };
  const ok = await acquireLock(K.briefLock, 200);
  if (!ok) return { brief: cur, busy: true };
  try {
    const { json, model } = await askClaude({
      system: SYSTEM,
      prompt: prompt({ symbol: cfg.symbol, now, bd }),
      searches: 5,
      maxTokens: 3000,
    });
    const events = (Array.isArray(json.events) ? json.events : []).slice(0, 10).map((e) => ({
      time_jst: String(e?.time_jst || ""),
      name: String(e?.name || "").slice(0, 60),
      currency: String(e?.currency || "").slice(0, 6),
      impact: e?.impact === "high" ? "high" : "medium",
      forecast: String(e?.forecast ?? "").slice(0, 30),
      previous: String(e?.previous ?? "").slice(0, 30),
      typical_reaction: String(e?.typical_reaction || "").slice(0, 100),
      ts: businessHmToTs(e?.time_jst, bd),
    }));
    const brief = {
      symbol: cfg.symbol,
      bd,
      at: now,
      model,
      summary: String(json.summary || "").slice(0, 160),
      caution: String(json.caution || "").slice(0, 160),
      events: events.filter((e) => e.ts),
      week_events: (Array.isArray(json.week_events) ? json.week_events : [])
        .slice(0, 12)
        .map((e) => ({
          day: String(e?.day || "").slice(0, 16),
          time_jst: String(e?.time_jst || "").slice(0, 5),
          name: String(e?.name || "").slice(0, 60),
          impact: e?.impact === "high" ? "high" : "medium",
        })),
      news: (Array.isArray(json.news) ? json.news : []).slice(0, 8).map((n) => ({
        fact: String(n?.fact || "").slice(0, 160),
        source: String(n?.source || "").slice(0, 60),
        status: ["確認済み", "未確認", "誇張の可能性"].includes(n?.status) ? n.status : "未確認",
      })),
    };
    await redis.set(key, brief, { ex: 60 * 60 * 36 });
    await addLog(`本日のブリーフを作成（重要指標${brief.events.length}件）`, "regime");
    return { brief };
  } finally {
    await redis.del(K.briefLock);
  }
}

export function briefText(brief) {
  if (!brief) return "（本日のブリーフなし。必要なら自分で検索して確認すること）";
  const ev =
    brief.events
      .map((e) => `${e.time_jst} ${e.name}（${e.impact}、予想${e.forecast || "-"}）`)
      .join("\n") || "なし";
  const news = brief.news
    .filter((n) => n.status === "確認済み")
    .map((n) => `- ${n.fact}`)
    .join("\n");
  return `要約: ${brief.summary}
注意点: ${brief.caution || "なし"}
本日の指標:
${ev}
確認済みニュース:
${news || "なし"}
${arr(brief.news.filter((n) => n.status !== "確認済み").map((n) => `（${n.status}）${n.fact}`)).join("\n")}`;
}
