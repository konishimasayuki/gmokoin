import { useState } from "react";
import { SIDE_JP, hm, mdhm, pips, symbolLabel, tone, yen } from "../format.js";
import Spark from "./Spark.jsx";
import { Badge, Card, Empty, Metric } from "./ui.jsx";

function Breakdown({ title, rows }) {
  if (!rows?.length) return null;
  return (
    <>
      <h3>{title}</h3>
      <table className="tbl">
        <thead>
          <tr>
            <th>区分</th>
            <th>回数</th>
            <th>勝率</th>
            <th>損益</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td className="num">{r.trades}</td>
              <td className="num">{r.winRate}%</td>
              <td className={`num ${tone(r.net)}`}>{yen(r.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Overall({ snap }) {
  const s = snap?.stats || { net: 0, trades: 0, wins: 0, grossWin: 0, grossLoss: 0, fees: 0 };
  const pf = s.grossLoss > 0 ? (s.grossWin / s.grossLoss).toFixed(2) : s.grossWin > 0 ? "∞" : "—";
  return (
    <Card title="累計成績（ペーパー）">
      <div className="metrics">
        <Metric label="損益" value={yen(s.net)} tone={tone(s.net)} />
        <Metric
          label="取引"
          value={`${s.trades}回`}
          sub={s.trades ? `勝率${Math.round((s.wins / s.trades) * 100)}%` : "—"}
        />
        <Metric
          label="PF"
          value={pf}
          sub={`手数料 ${Math.round(s.fees).toLocaleString("ja-JP")}円`}
        />
      </div>
      <p className="hint">
        PF（プロフィットファクター）は総利益÷総損失。1.0を超えると勝ち越し、実弾に進む目安は1.2以上です。
      </p>
    </Card>
  );
}

function Reports({ reports, loading, onReport, onAdopt, lock }) {
  const [openId, setOpenId] = useState(null);
  const latest = reports?.[0];
  const current = reports?.find((r) => r.id === openId) || latest;
  return (
    <Card
      title="振り返りレポート"
      action={
        <div className="btns">
          <button
            type="button"
            className="ghost"
            onClick={() => onReport("daily")}
            disabled={loading.report}
          >
            日次
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => onReport("weekly")}
            disabled={loading.report}
          >
            週次
          </button>
        </div>
      }
    >
      {loading.report && <p className="hint">反省会担当が取引を分析しています…</p>}
      {!current ? (
        <Empty>まだレポートはありません。「日次」か「週次」を押すと作成します。</Empty>
      ) : (
        <>
          {reports.length > 1 && (
            <div className="chips">
              {reports.map((r) => (
                <button
                  type="button"
                  key={r.id}
                  className={`chip ${r.id === current.id ? "on" : ""}`}
                  onClick={() => setOpenId(r.id)}
                >
                  {r.kind === "weekly" ? "週" : "日"} {r.label}
                </button>
              ))}
            </div>
          )}
          <div className="report-head">
            <span className={`grade g-${current.grade}`}>{current.grade}</span>
            <div>
              <b>{current.headline}</b>
              <small>
                {current.label}・{current.stats.trades}回・{yen(current.stats.net)}
              </small>
            </div>
          </div>
          <p className="summary">{current.summary}</p>
          {current.good?.length > 0 && <h3>良かった点</h3>}
          <ul className="reasons">
            {current.good?.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          {current.bad?.length > 0 && <h3>悪かった点</h3>}
          <ul className="reasons">
            {current.bad?.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          {current.patterns?.length > 0 && <h3>負けパターン</h3>}
          <ul className="reasons">
            {current.patterns?.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          {current.rule_checks?.length > 0 && <h3>ルールと介入のチェック</h3>}
          <ul className="reasons">
            {current.rule_checks?.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          {current.suggestions?.length > 0 && (
            <>
              <h3>設定の変更案</h3>
              {lock?.locked && (
                <p className="notice soft">{lock.why}、リスクを増やす変更は今日はロック中です。</p>
              )}
              {current.suggestions.map((s) => (
                <div key={s.key} className="suggest">
                  <div>
                    <b>{s.label}</b>
                    <span className="num">
                      {String(s.current)} → {String(s.proposed)}
                    </span>
                    <small>{s.reason}</small>
                  </div>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => onAdopt(s.key, s.proposed)}
                  >
                    採用
                  </button>
                </div>
              ))}
            </>
          )}
          <Breakdown title="時間帯別" rows={current.stats.bySession} />
          <Breakdown title="セットアップ別" rows={current.stats.bySetup} />
        </>
      )}
    </Card>
  );
}

const CHECKS = [
  ["split", "前半60日で選び、後半30日でも勝てたか"],
  ["weeks", "ランダムな40週で、7割以上の週が勝ちか"],
  ["mc", "1000回の引き直しで、マイナスの確率が25%以下か"],
  ["stress", "スプレッド2倍＋約定のズレでも負けないか"],
  ["neighbors", "設定を少しズラしても勝てるか"],
  ["dd", "含み損込みの最大ドローダウンが資金の30%以下か"],
];

const STRAT = { scalp: "スキャル", grid: "リピート" };

// Claudeに貼り付けて分析してもらうための要約テキスト
function exportText(result) {
  const y = (v) => `${v > 0 ? "+" : ""}${Math.round(v || 0).toLocaleString("ja-JP")}円`;
  const line = (b) =>
    b?.checks
      ? [
          `${STRAT[b.strategy] || "スキャル"} ${b.passed}/${Object.keys(b.checks).length}${b.pass ? " 合格" : ""}「${b.label}」`,
          `  学習PF ${b.train.pf}(${b.train.trades}回) / 後半PF ${b.test.pf}(${b.test.trades}回・${y(b.test.net)})`,
          `  全期間 ${y(b.full?.net)} ${b.full?.trades}回 勝率${b.full?.winRate}% 含み損込みDD -${Math.round(b.full?.mtmDd ?? b.full?.maxDd ?? 0).toLocaleString("ja-JP")}円${b.full?.worstAdded ? "（最悪ケース1回を加算済み）" : ""}`,
          `  勝ち週${Math.round(b.weeks.winShare * 100)}%(${b.weeks.counted}週) / マイナス確率${Math.round(b.mc.lossProb * 100)}% 最悪時-${(b.mc.dd95 || 0).toLocaleString("ja-JP")}円 / 悪条件PF ${b.stress.pf} / 設定ブレ ${b.neighbors.ok}/${b.neighbors.total}`,
          `  ✕: ${
            Object.entries(b.checks)
              .filter(([, v]) => !v)
              .map(([k]) => k)
              .join(",") || "なし"
          }`,
        ].join("\n")
      : "  候補なし";
  const out = [
    `【自動選定の検証結果】${new Date(result.at).toLocaleString("ja-JP")}・${result.totalDays}日（後半${result.testDays}日）`,
    `採用（スキャル）: ${result.portfolio?.map((p) => symbolLabel(p.symbol)).join("・") || "なし"}`,
    result.combined
      ? `  組み合わせ ${y(result.combined.net)} PF${result.combined.pf} ${result.combined.trades}回 DD-${(result.combined.mtmDd ?? result.combined.maxDd).toLocaleString("ja-JP")}円`
      : "",
    `リピート合格: ${result.gridSymbols?.map((s) => symbolLabel(s)).join("・") || "なし"}`,
    result.combinedGrid
      ? `  組み合わせ ${y(result.combinedGrid.net)} PF${result.combinedGrid.pf} ${result.combinedGrid.trades}回 DD-${(result.combinedGrid.mtmDd ?? result.combinedGrid.maxDd).toLocaleString("ja-JP")}円`
      : "",
  ];
  for (const r of result.results) {
    out.push(
      `■ ${symbolLabel(r.symbol)}${r.error ? `：${r.error}` : ""}${r.stale ? "（古い結果）" : ""}`,
    );
    if (r.error) continue;
    out.push(` [スキャル] ${line(r.bestScalp || (r.best?.strategy !== "grid" ? r.best : null))}`);
    out.push(` [リピート] ${line(r.bestGrid)}`);
    if (r.current)
      out.push(`  いまの設定: PF ${r.current.pf}(${r.current.trades}回・${y(r.current.net)})`);
  }
  return out.filter(Boolean).join("\n");
}

function CopyButton({ text, label = "結果をコピー（Claudeに貼る用）" }) {
  const [state, setState] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("コピーしました。チャットに貼り付けてください");
    } catch {
      setState("コピーできませんでした。下の文字を長押しで選択してください");
    }
  };
  return (
    <div className="copy-box">
      <button type="button" className="ghost wide" onClick={copy}>
        {label}
      </button>
      {state && <p className="hint">{state}</p>}
      {state.startsWith("コピーできません") && <textarea readOnly value={text} rows={8} />}
    </div>
  );
}

function checkValue(key, b) {
  if (key === "split") return `後半 PF ${b.test.pf}（${b.test.trades}回・${yen(b.test.net)}）`;
  if (key === "weeks")
    return `勝ち週 ${Math.round(b.weeks.winShare * 100)}%（${b.weeks.counted}週）`;
  if (key === "mc")
    return `マイナス確率 ${Math.round(b.mc.lossProb * 100)}%・最悪時 -${b.mc.dd95.toLocaleString("ja-JP")}円`;
  if (key === "stress") return `PF ${b.stress.pf}（${yen(b.stress.net)}）`;
  if (key === "neighbors") return `${b.neighbors.total}通り中 ${b.neighbors.ok}通りでプラス`;
  return `最大 -${(b.full?.mtmDd ?? b.full?.maxDd ?? 0).toLocaleString("ja-JP")}円`;
}

function Optimize({ result: raw, loading, onRun, onUse, auto, progress }) {
  // 旧バージョンの結果（5段階チェックなし）は表示しない
  const result = raw?.rule?.weekWin ? raw : null;
  const inPort = (sym) =>
    result?.portfolio
      ? result.portfolio.some((p) => p.symbol === sym)
      : result?.pick?.symbol === sym;
  return (
    <Card title="AIによる銘柄・設定の自動選定">
      <p className="hint">
        FX6銘柄と仮想通貨5銘柄で、スキャルピング約580通り＋リピート72通りの設定を90日分のデータで試し、6段階の検証をすべて通ったものだけを採用します。ランダムな週と引き直しは日替わりです。
      </p>
      <button type="button" className="primary" onClick={onRun} disabled={loading.optimize}>
        {loading.optimize ? "検証中…" : auto ? "いま選び直す" : "全銘柄で検証する"}
      </button>
      {progress && (
        <div className="progress">
          <div style={{ width: `${((progress.i - 1) / progress.total) * 100}%` }} />
          <span>
            {progress.i}/{progress.total} {symbolLabel(progress.symbol)}{" "}
            を検証中（初回はデータ取得で数分かかります）
          </span>
        </div>
      )}
      {result && (
        <>
          <p className="meta">
            {mdhm(result.at)} 実行
            {result.applied?.status === "applied" && "・合格した銘柄をすべて採用しました"}
            {result.applied?.status === "blocked" && "・合格なしのため取引を止めています"}
          </p>
          {result.portfolio?.length > 0 && result.combined && (
            <div className="port-box">
              <b>採用：{result.portfolio.map((p) => symbolLabel(p.symbol)).join("・")}</b>
              <small>組み合わせた場合の{result.totalDays}日間（概算）</small>
              <div className="metrics">
                <Metric
                  label="損益"
                  value={yen(result.combined.net)}
                  tone={tone(result.combined.net)}
                  sub={`${result.combined.trades}回`}
                />
                <Metric
                  label="PF"
                  value={result.combined.pf}
                  sub={`勝率${result.combined.winRate}%`}
                />
                <Metric
                  label="最大DD（含み損込み）"
                  value={`${(result.combined.mtmDd ?? result.combined.maxDd).toLocaleString("ja-JP")}円`}
                  sub={`マイナス確率${Math.round(result.combined.mc.lossProb * 100)}%`}
                />
              </div>
              <Spark points={result.combined.curve} height={90} />
            </div>
          )}
          {result.combinedGrid && (
            <div className="port-box grid-box">
              <b>リピートで合格：{result.gridSymbols.map((x) => symbolLabel(x)).join("・")}</b>
              <small>組み合わせた場合の{result.totalDays}日間（概算・24時間稼働が前提）</small>
              <div className="metrics">
                <Metric
                  label="損益"
                  value={yen(result.combinedGrid.net)}
                  tone={tone(result.combinedGrid.net)}
                  sub={`${result.combinedGrid.trades}回`}
                />
                <Metric
                  label="PF"
                  value={result.combinedGrid.pf}
                  sub={`勝率${result.combinedGrid.winRate}%`}
                />
                <Metric
                  label="最大DD（含み損込み）"
                  value={`${(result.combinedGrid.mtmDd ?? result.combinedGrid.maxDd).toLocaleString("ja-JP")}円`}
                  sub={`マイナス確率${Math.round(result.combinedGrid.mc.lossProb * 100)}%`}
                />
              </div>
              <Spark points={result.combinedGrid.curve} height={90} />
            </div>
          )}
          <div className="opt-list">
            {result.results.map((r) => {
              const b = r.best?.checks ? r.best : null;
              const alt = b?.strategy === "grid" ? r.bestScalp : r.bestGrid;
              const other = alt?.checks ? alt : null;
              return (
                <div key={r.symbol} className={`opt ${inPort(r.symbol) ? "picked" : ""}`}>
                  <div className="opt-head">
                    <b>{symbolLabel(r.symbol)}</b>
                    {r.error ? (
                      <Badge>{r.error}</Badge>
                    ) : b?.pass ? (
                      <Badge tone="buy">合格</Badge>
                    ) : (
                      <Badge tone="sell">
                        {b ? `${b.passed}/${Object.keys(b.checks).length}` : "不合格"}
                      </Badge>
                    )}
                    {b && <Badge>{STRAT[b.strategy] || "スキャル"}</Badge>}
                    {inPort(r.symbol) && <Badge tone="brass">採用</Badge>}
                    {r.stale && <Badge>古い結果</Badge>}
                  </div>
                  {b ? (
                    <>
                      <small>{b.label}</small>
                      <ul className="checks">
                        {CHECKS.filter(([k]) => k in b.checks).map(([k, label]) => (
                          <li key={k} className={b.checks[k] ? "ok" : "ng"}>
                            <span className="mark" aria-hidden="true">
                              {b.checks[k] ? "✓" : "✕"}
                            </span>
                            <span>
                              {label}
                              <small className="num">{checkValue(k, b)}</small>
                            </span>
                          </li>
                        ))}
                      </ul>
                      {other && (
                        <small className="meta">
                          もう一方（{STRAT[other.strategy]}）：{other.passed}/
                          {Object.keys(other.checks).length}
                          ・後半 PF {other.test.pf}（{yen(other.test.net)}）
                        </small>
                      )}
                      {b.strategy === "grid" && b.pass && (
                        <small className="meta">
                          リピートは24時間稼働にしてから運用できます（今は検証のみ）。
                        </small>
                      )}
                      {!auto && b.pass && b.strategy !== "grid" && (
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => onUse(r.symbol, b.params)}
                        >
                          この銘柄と設定を使う
                        </button>
                      )}
                    </>
                  ) : (
                    !r.error && <small>前半60日でプラスになる設定が見つかりませんでした</small>
                  )}
                  {r.current && (
                    <small className="meta">
                      いまの設定だと PF {r.current.pf}（{r.current.trades}回・{yen(r.current.net)}）
                    </small>
                  )}
                </div>
              );
            })}
          </div>
          <p className="hint">{result.note}</p>
          <CopyButton text={exportText(result)} />
        </>
      )}
    </Card>
  );
}

function Backtest({ result, loading, onRun, symbol }) {
  const [days, setDays] = useState(5);
  const [spread, setSpread] = useState("");
  const m = result?.metrics;
  return (
    <Card title={`バックテスト${symbol ? `（${symbolLabel(symbol)}）` : ""}`}>
      <p className="hint">
        ホームで選んでいる銘柄を、その銘柄の設定で過去の1分足に当てて再生します。相場判定はClaudeの代わりに機械的な判定を使います。
      </p>
      <div className="bt-form">
        <label>
          <span>期間</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[5, 20, 60, 90].map((n) => (
              <option key={n} value={n}>
                {n}日
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>想定スプレッド</span>
          <input
            inputMode="decimal"
            placeholder="自動"
            value={spread}
            onChange={(e) => setSpread(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="primary"
          onClick={() => onRun(days, spread)}
          disabled={loading.backtest}
        >
          {loading.backtest ? "計算中…" : "実行"}
        </button>
      </div>
      {!result ? (
        <Empty>まだ実行していません。</Empty>
      ) : (
        <>
          <p className="meta">
            {mdhm(result.at)} 実行・{result.days}日・スプレッド{result.spreadPips}
            {result.unit || "pips"}
          </p>
          <div className="metrics">
            <Metric
              label="損益"
              value={yen(m.net)}
              tone={tone(m.net)}
              sub={`手数料 ${m.fees.toLocaleString("ja-JP")}円`}
            />
            <Metric label="取引" value={`${m.trades}回`} sub={`勝率${m.winRate}%`} />
            <Metric label="PF" value={m.pf} sub={`最大DD ${m.maxDd.toLocaleString("ja-JP")}円`} />
          </div>
          <Spark points={result.curve} />
          <p className="meta">
            平均 {m.avgPips}
            {result.unit || "pips"}／勝ち平均 {yen(m.avgWin)}／負け平均 {yen(m.avgLoss)}
          </p>
          <Breakdown title="時間帯別" rows={result.bySession} />
          <Breakdown title="セットアップ別" rows={result.bySetup} />
          <Breakdown title="決済理由別" rows={result.byReason} />
          <p className="hint">{result.note}</p>
          <CopyButton text={backtestText(result)} />
        </>
      )}
    </Card>
  );
}

function backtestText(r) {
  const m = r.metrics;
  const t = (rows) =>
    (rows || []).map((x) => `${x.name} ${x.trades}回 勝率${x.winRate}% ${x.net}円`).join(" / ");
  return [
    `【バックテスト】${symbolLabel(r.symbol)} ${r.days}日 スプレッド${r.spreadPips}${r.unit || "pips"}`,
    `損益${m.net}円 ${m.trades}回 勝率${m.winRate}% PF${m.pf} 最大DD${m.maxDd}円 平均${m.avgPips} 勝ち平均${m.avgWin} 負け平均${m.avgLoss} 手数料${m.fees}円`,
    `設定: ${JSON.stringify(r.config)}`,
    `時間帯: ${t(r.bySession)}`,
    `セットアップ: ${t(r.bySetup)}`,
    `決済理由: ${t(r.byReason)}`,
  ].join("\n");
}

function History({ trades, logs }) {
  return (
    <>
      <Card title="取引履歴">
        {trades.length === 0 ? (
          <Empty>まだ取引はありません。</Empty>
        ) : (
          <ul className="trades">
            {trades.map((t) => (
              <li key={t.id}>
                <span className="meta num">{mdhm(t.closedAt)}</span>
                <b className={t.side === "BUY" ? "up" : "down"}>{SIDE_JP[t.side]}</b>
                <span className="grow">
                  {t.symbol ? `${symbolLabel(t.symbol)}・` : ""}
                  {t.setup}
                  <small>{t.reason}</small>
                </span>
                <b className={`num ${tone(t.net)}`}>
                  {pips(t.pips)}
                  <small>{yen(t.net)}</small>
                </b>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="動作ログ">
        <ul className="logs">
          {logs.map((l) => (
            <li key={`${l.t}${l.msg}`} className={l.level}>
              <span className="meta num">{hm(l.t)}</span>
              <span>{l.msg}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

const TABS = [
  ["overall", "成績"],
  ["report", "レポート"],
  ["backtest", "検証"],
  ["history", "履歴"],
];

export default function Results(props) {
  const [tab, setTab] = useState(props.initialTab || "overall");
  return (
    <>
      <div className="seg" role="tablist">
        {TABS.map(([k, label]) => (
          <button
            type="button"
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "overall" && (
        <>
          <Overall snap={props.snap} />
          {props.reports?.[0] && (
            <Card title="最新レポート">
              <div className="report-head">
                <span className={`grade g-${props.reports[0].grade}`}>
                  {props.reports[0].grade}
                </span>
                <div>
                  <b>{props.reports[0].headline}</b>
                  <small>{props.reports[0].label}</small>
                </div>
              </div>
              <p className="summary">{props.reports[0].summary}</p>
              <Badge tone="brass">詳しくはレポートタブ</Badge>
            </Card>
          )}
        </>
      )}
      {tab === "report" && <Reports {...props} />}
      {tab === "backtest" && (
        <>
          <Optimize
            result={props.optimize}
            loading={props.loading}
            onRun={props.onOptimize}
            onUse={props.onUseCombo}
            auto={props.snap?.config?.symbolMode === "auto"}
            progress={props.optProgress}
          />
          <Backtest
            result={props.backtest}
            loading={props.loading}
            onRun={props.onBacktest}
            symbol={props.focus}
          />
        </>
      )}
      {tab === "history" && <History trades={props.trades} logs={props.logs} />}
    </>
  );
}
