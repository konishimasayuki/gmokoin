// 反省会担当：日次・週次の振り返りレポート
import { arr, askClaude } from "./claude.js";
import { K, acquireLock, getLogs, getTrades, redis } from "./redis.js";
import { SESSION_LABEL, sessionOf } from "./strategy.js";
import {
  BOOLEAN_KEYS,
  NUMERIC_LIMITS,
  businessDate,
  jstLabel,
  mergeConfig,
  round,
} from "./util.js";

const DAY = 24 * 3600 * 1000;

const SYSTEM = `あなたはFX自動売買システムの「反省会担当」です。取引記録を客観的に分析し、負けパターンと改善案を出します。
- 感想ではなく数字で語る。サンプルが少ない場合は「判断には件数が足りない」と正直に言う。
- ルールの変更提案は、根拠となる数字（時間帯・セットアップ別の成績など）を必ず添える。1回に提案するのは最大3つ。
- 手動決済や設定変更など、人の介入があればその影響も指摘する。
- ユーザーはチャートに詳しくないので、専門用語は短く言い換える。`;

const LABELS = {
  units: "取引数量",
  maxTradesPerDay: "1日の最大取引回数",
  dailyLossLimit: "1日の損失上限",
  slAtrMult: "損切り幅（ATR倍率）",
  slMinPips: "損切り幅の下限",
  slMaxPips: "損切り幅の上限",
  rr: "利確幅（損切りの倍率）",
  timeStopMin: "最長保有時間",
  maxSpreadPips: "許容スプレッド",
  minAtrPips: "最低ATR",
  maxAtrPips: "最大ATR",
  eventBufferMin: "指標前後の停止",
  cooldownSec: "決済後の待機",
  beTriggerR: "建値ストップの発動",
  lossStreakMax: "連敗ストップ回数",
  lossStreakPauseMin: "連敗ストップ時間",
  riskPct: "1回のリスク%",
  htfFilter: "5分足フィルター",
  beOn: "建値ストップ",
  levelFilter: "水平線フィルター",
};

function breakdown(trades, keyFn) {
  const g = {};
  for (const t of trades) {
    const k = keyFn(t) || "不明";
    g[k] ||= { trades: 0, wins: 0, net: 0, pips: 0 };
    g[k].trades++;
    if (t.net > 0) g[k].wins++;
    g[k].net += t.net;
    g[k].pips += t.pips;
  }
  return Object.entries(g).map(([name, v]) => ({
    name,
    trades: v.trades,
    winRate: round((v.wins / v.trades) * 100, 0),
    net: round(v.net, 0),
    avgPips: round(v.pips / v.trades, 2),
  }));
}

function periodOf(kind, now) {
  const bdToday = businessDate(now);
  if (kind === "weekly") {
    return { key: `w${bdToday}`, from: now - 7 * DAY, to: now, label: "直近7日" };
  }
  // 日次：今日（取引日）
  const y = Number(bdToday.slice(0, 4));
  const m = Number(bdToday.slice(4, 6));
  const d = Number(bdToday.slice(6, 8));
  const from = Date.UTC(y, m - 1, d) - 9 * 3600 * 1000 + 6 * 3600 * 1000;
  return { key: bdToday, from, to: from + DAY, label: `${m}/${d}の取引日` };
}

export async function runReport({ kind = "daily" } = {}) {
  const now = Date.now();
  const k = kind === "weekly" ? "weekly" : "daily";
  const per = periodOf(k, now);
  const ok = await acquireLock(K.reportLock, 150);
  if (!ok) throw new Error("レポート作成中です。少し待ってください");
  try {
    const [cfgRaw, all, logs] = await Promise.all([
      redis.get(K.config),
      getTrades(500),
      getLogs(100),
    ]);
    const cfg = mergeConfig(cfgRaw);
    const trades = all.filter((t) => t.closedAt >= per.from && t.closedAt < per.to);
    const n = trades.length;
    const wins = trades.filter((t) => t.net > 0).length;
    const net = round(
      trades.reduce((s, t) => s + t.net, 0),
      0,
    );
    const manual = trades.filter((t) => t.reason === "手動決済").length;
    const configLogs = logs
      .filter((l) => l.t >= per.from && /設定|銘柄|開始|停止/.test(l.msg))
      .map((l) => l.msg);
    const stats = {
      trades: n,
      winRate: n ? round((wins / n) * 100, 0) : 0,
      net,
      manual,
      bySession: breakdown(trades, (t) => SESSION_LABEL[t.session || sessionOf(t.openedAt)]),
      bySetup: breakdown(trades, (t) => t.setup),
      byReason: breakdown(trades, (t) => t.reason),
    };

    let body;
    if (n === 0) {
      body = {
        headline: "取引なし",
        grade: "-",
        summary: "この期間は取引がありませんでした。見送り理由は動作ログを確認してください。",
        good: [],
        bad: [],
        patterns: [],
        rule_checks: [],
        suggestions: [],
      };
    } else {
      const list = trades
        .slice(0, 150)
        .map(
          (t) =>
            `${jstLabel(t.openedAt).slice(11, 22)} ${t.side} ${t.setup} ${SESSION_LABEL[t.session] || ""} 判定:${t.regimeMode || "-"}(${t.regimeConfidence ?? "-"}%) ${t.reason} ${t.pips}pips ${t.net}円`,
        )
        .join("\n");
      const editable = Object.keys(LABELS)
        .map((key) => `${key}（${LABELS[key]}）=${cfg[key]}`)
        .join(", ");
      const prompt = `# 期間
${per.label}（${k === "weekly" ? "週次" : "日次"}）銘柄 ${cfg.symbol.replace("_", "/")}

# 集計
${JSON.stringify(stats)}

# 取引一覧（新しい順）
${list}

# 人の介入・設定変更ログ
${configLogs.join("\n") || "なし"}

# 現在の設定（変更提案はこのキーだけ）
${editable}

# 出力（JSONのみ）
{"headline":"一言で20字以内","grade":"A|B|C|D|E","summary":"100字以内","good":["良かった点"],"bad":["悪かった点"],"patterns":["共通する負けパターン"],"rule_checks":["ルール通りだったか・介入の影響"],"suggestions":[{"key":"設定キー","proposed":値,"reason":"数字の根拠"}]}`;
      const { json } = await askClaude({ system: SYSTEM, prompt, maxTokens: 2500 });
      const suggestions = (Array.isArray(json.suggestions) ? json.suggestions : [])
        .filter((s) => LABELS[s?.key])
        .slice(0, 3)
        .map((s) => {
          const isBool = BOOLEAN_KEYS.includes(s.key);
          let proposed = isBool ? Boolean(s.proposed) : Number(s.proposed);
          if (!isBool) {
            const [lo, hi] = NUMERIC_LIMITS[s.key] || [
              Number.NEGATIVE_INFINITY,
              Number.POSITIVE_INFINITY,
            ];
            if (!Number.isFinite(proposed)) return null;
            proposed = Math.min(hi, Math.max(lo, proposed));
          }
          return {
            key: s.key,
            label: LABELS[s.key],
            current: cfg[s.key],
            proposed,
            reason: String(s.reason || "").slice(0, 160),
          };
        })
        .filter(Boolean);
      body = {
        headline: String(json.headline || "").slice(0, 40),
        grade: ["A", "B", "C", "D", "E"].includes(json.grade) ? json.grade : "C",
        summary: String(json.summary || "").slice(0, 200),
        good: arr(json.good, 4),
        bad: arr(json.bad, 4),
        patterns: arr(json.patterns, 4),
        rule_checks: arr(json.rule_checks, 4),
        suggestions,
      };
    }
    const report = {
      id: `${k}:${per.key}`,
      kind: k,
      key: per.key,
      label: per.label,
      at: now,
      stats,
      ...body,
    };
    await redis
      .pipeline()
      .set(K.report(k, per.key), report, { ex: 60 * 60 * 24 * 90 })
      .lrem(K.reportIds, 0, report.id)
      .lpush(K.reportIds, report.id)
      .ltrim(K.reportIds, 0, 59)
      .exec();
    return { report };
  } finally {
    await redis.del(K.reportLock);
  }
}

export async function listReports(n = 10) {
  const ids = await redis.lrange(K.reportIds, 0, n - 1);
  if (!ids.length) return [];
  const rows = await redis.mget(
    ...ids.map((id) => {
      const [kind, key] = String(id).split(":");
      return K.report(kind, key);
    }),
  );
  return rows.filter(Boolean);
}
