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

function Optimize({ result, loading, onRun, onUse, auto }) {
  return (
    <Card title="AIによる銘柄・設定の自動選定">
      <p className="hint">
        全銘柄で約580通りの設定を試し、前半14日で選んだ設定が後半6日でも通用したか（PF1.1以上・プラス）を確認します。
      </p>
      <button type="button" className="primary" onClick={onRun} disabled={loading.optimize}>
        {loading.optimize
          ? "全銘柄を検証中…（1〜3分）"
          : auto
            ? "いま選び直す"
            : "全銘柄で検証する"}
      </button>
      {result && (
        <>
          <p className="meta">
            {mdhm(result.at)} 実行
            {result.applied?.status === "applied" &&
              `・${symbolLabel(result.applied.symbol)}に切り替えました`}
            {result.applied?.status === "blocked" && "・合格なしのため取引を止めています"}
            {result.applied?.status === "skipped" && `・${result.applied.why}`}
          </p>
          <div className="opt-list">
            {result.results.map((r) => (
              <div
                key={r.symbol}
                className={`opt ${result.pick?.symbol === r.symbol ? "picked" : ""}`}
              >
                <div className="opt-head">
                  <b>{symbolLabel(r.symbol)}</b>
                  {r.error ? (
                    <Badge>{r.error}</Badge>
                  ) : r.best?.pass ? (
                    <Badge tone="buy">合格</Badge>
                  ) : (
                    <Badge tone="sell">不合格</Badge>
                  )}
                  {result.pick?.symbol === r.symbol && <Badge tone="brass">採用</Badge>}
                </div>
                {r.best ? (
                  <>
                    <small>{r.best.label}</small>
                    <div className="opt-nums num">
                      <span>
                        学習 PF {r.best.train.pf}（{r.best.train.trades}回）
                      </span>
                      <span className={r.best.test.pf >= 1 ? "up" : "down"}>
                        検証 PF {r.best.test.pf}（{r.best.test.trades}回・{yen(r.best.test.net)}）
                      </span>
                    </div>
                    {!auto && r.best.pass && (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => onUse(r.symbol, r.best.params)}
                      >
                        この銘柄と設定を使う
                      </button>
                    )}
                  </>
                ) : (
                  !r.error && <small>学習期間でプラスになる設定が見つかりませんでした</small>
                )}
                {r.current && (
                  <small className="meta">
                    いまの設定だと PF {r.current.pf}（{r.current.trades}回・{yen(r.current.net)}）
                  </small>
                )}
              </div>
            ))}
          </div>
          <p className="hint">{result.note}</p>
        </>
      )}
    </Card>
  );
}

function Backtest({ result, loading, onRun }) {
  const [days, setDays] = useState(5);
  const [spread, setSpread] = useState("");
  const m = result?.metrics;
  return (
    <Card title="バックテスト">
      <p className="hint">
        過去の1分足で、今の設定のルールを再生します。相場判定はClaudeの代わりに機械的な判定を使います。
      </p>
      <div className="bt-form">
        <label>
          <span>期間</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 3, 5, 10, 20].map((n) => (
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
            {mdhm(result.at)} 実行・{result.days}日・スプレッド{result.spreadPips}pips
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
            平均 {m.avgPips}pips／勝ち平均 {yen(m.avgWin)}／負け平均 {yen(m.avgLoss)}
          </p>
          <Breakdown title="時間帯別" rows={result.bySession} />
          <Breakdown title="セットアップ別" rows={result.bySetup} />
          <Breakdown title="決済理由別" rows={result.byReason} />
          <p className="hint">{result.note}</p>
        </>
      )}
    </Card>
  );
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
          />
          <Backtest result={props.backtest} loading={props.loading} onRun={props.onBacktest} />
        </>
      )}
      {tab === "history" && <History trades={props.trades} logs={props.logs} />}
    </>
  );
}
