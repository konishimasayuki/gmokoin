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

const STRAT = { scalp: "スキャル", grid: "リピート", ww: "クロユキWW" };

// Claudeに貼り付けて分析してもらうための要約テキスト
function exportText(result) {
  if (result.mode === "ww" && result.pools)
    return Object.values(result.pools)
      .filter(Boolean)
      .map((p) => wwText(p, p.days, p.testDays))
      .join("\n\n");
  if (result.mode === "ww" && result.wwPool)
    return wwText(result.wwPool, result.totalDays, result.testDays);
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
    out.push(
      ` [スキャル] ${line(r.bestScalp !== undefined ? r.bestScalp : r.best?.strategy ? null : r.best)}`,
    );
    out.push(` [リピート] ${line(r.bestGrid)}`);
    out.push(` [クロユキWW] ${line(r.bestWW)}`);
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

const METHOD_NAME = {
  ww: "クロユキWW",
  oshi: "クロユキ押し戻り",
  flag: "クロユキフラッグW",
  sat: "クロユキサテライト",
  gotobi: "仲値（ゴトー日）",
  tokyo: "東京の朝（5年・1時間足）",
  trend: "4時間足トレンドフォロー",
};
const fmtT = (ts) => (ts ? mdhm(ts) : "—");
const fp = (v, sym) =>
  v == null ? "—" : Number(v).toFixed(isCryptoSym(sym) ? 0 : sym?.endsWith("JPY") ? 3 : 5);
const isCryptoSym = (s) => ["BTC_JPY", "ETH_JPY", "XRP_JPY", "BCH_JPY", "LTC_JPY"].includes(s);

function wwText(pool, days, testDays) {
  const y = (v) => `${v > 0 ? "+" : ""}${Math.round(v || 0).toLocaleString("ja-JP")}円`;
  const out = [
    `【${METHOD_NAME[pool.method || "ww"]} 全銘柄まとめ】${days}日（後半${testDays}日）・${pool.symbols}銘柄`,
    `採用設定: ${pool.label} → ${pool.passed}/6${pool.pass ? " 合格" : ""}`,
    `学習 PF${pool.train.pf}(${pool.train.trades}回) / 後半 PF${pool.test.pf}(${pool.test.trades}回・${y(pool.test.net)})`,
    `全期間 ${y(pool.full.net)} ${pool.full.trades}回 勝率${pool.full.winRate}% DD-${Math.round(pool.full.mtmDd).toLocaleString("ja-JP")}円`,
    `勝ち週${Math.round(pool.weeks.winShare * 100)}%(${pool.weeks.counted}週) / マイナス確率${Math.round(pool.mc.lossProb * 100)}% / 悪条件PF ${pool.stress.pf} / 設定ブレ ${pool.neighbors.ok}/${pool.neighbors.total}`,
    `✕: ${
      Object.entries(pool.checks)
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(",") || "なし"
    }`,
    pool.byYear ? "■ 年ごと" : "",
    ...(pool.byYear || []).map(
      (b) => ` ${b.year}年 ${b.trades}回 勝率${b.winRate}% PF${b.pf} ${y(b.net)}`,
    ),
    "■ 銘柄別",
    ...pool.bySymbol.map(
      (b) => ` ${symbolLabel(b.symbol)} ${b.trades}回 勝率${b.winRate}% PF${b.pf} ${y(b.net)}`,
    ),
    "■ ほかの設定（全銘柄まとめ）",
    ...pool.others.map(
      (o) =>
        ` ${o.label}：${o.trades}回 勝率${o.winRate}% PF${o.pf} ${y(o.net)}${o.test ? `（前 PF${o.train.pf}・${o.train.trades}回 ／ 直近 PF${o.test.pf}・${o.test.trades}回・${y(o.test.net)}）` : ""}${o.byYear && o.byYear.length > 2 ? ` 年別PF ${o.byYear.map((b) => `${String(b.year).slice(2)}年${b.pf}`).join(" ")}` : ""}`,
    ),
  ];
  return out.filter(Boolean).join("\n");
}

function wwTradesText(pool) {
  const out = [`【${METHOD_NAME[pool.method || "ww"]} 取引一覧（新しい順・日本時間）】`];
  const hasW = pool.sample.some((t) => t.ww);
  out.push(
    hasW
      ? "銘柄 売買 エントリー時刻 / A・B・C・D（時刻 価格）/ ネック / 入 損切 利確 / 結果"
      : "銘柄 売買 エントリー時刻 / 入 損切 決済 / 決済時刻 / 結果",
  );
  for (const t of pool.sample) {
    const w = t.ww;
    const side = t.side === "BUY" ? "買い" : "売り";
    const res = `${t.reason} ${t.net > 0 ? "+" : ""}${t.net}円`;
    if (!w) {
      out.push(
        `${symbolLabel(t.symbol)} ${side} ${fmtT(t.openedAt)} / 入${fp(t.entry, t.symbol)} 損${fp(t.sl, t.symbol)} 決済${fp(t.exit, t.symbol)} / ${fmtT(t.closedAt)} / ${res}`,
      );
      continue;
    }
    const pt = (x) => (x ? `${fmtT(x[0])} ${fp(x[1], t.symbol)}` : "—");
    const touch =
      t.method === "flag"
        ? `チャネル 下${Math.floor(w.touches / 10)}点・上${w.touches % 10}点`
        : `反応${w.touches}点`;
    out.push(
      `${symbolLabel(t.symbol)} ${side} ${fmtT(t.openedAt)} / A ${pt(w.A)} B ${pt(w.B)} C ${pt(w.C)} D ${pt(w.D)} / ネック${fp(w.miniNeck, t.symbol)} ${touch} / 入${fp(t.entry, t.symbol)} 損${fp(t.sl, t.symbol)} 利${fp(t.tp, t.symbol)} / ${res}`,
    );
  }
  return out.join("\n");
}

function WWPool({ pool, days, testDays }) {
  if (!pool) return <p className="hint">まだ全銘柄の結果がそろっていません。</p>;
  return (
    <div className="port-box ww-pool">
      <div className="opt-head">
        <b>
          {METHOD_NAME[pool.method || "ww"]}：全銘柄まとめて（{pool.symbols}銘柄）
        </b>
        {pool.pass ? <Badge tone="buy">合格</Badge> : <Badge tone="sell">{pool.passed}/6</Badge>}
      </div>
      <small>{pool.label}</small>
      <div className="metrics">
        <Metric
          label="損益"
          value={yen(pool.full.net)}
          tone={tone(pool.full.net)}
          sub={`${pool.full.trades}回`}
        />
        <Metric label="勝率" value={`${pool.full.winRate}%`} sub={`PF ${pool.full.pf}`} />
        <Metric
          label="最大DD"
          value={`${Math.round(pool.full.mtmDd).toLocaleString("ja-JP")}円`}
          sub="含み損込み"
        />
      </div>
      <Spark points={pool.curve} height={90} />
      {pool.live && (
        <p className="meta">
          運用予定の2ペア（{pool.live.pairs.map((x) => symbolLabel(x)).join("・")}）：前の1年{" "}
          {pool.live.train.trades}回・勝率
          {pool.live.train.winRate}%・{yen(pool.live.train.net)} ／ 直近1年 {pool.live.test.trades}
          回・勝率
          {pool.live.test.winRate}%・{yen(pool.live.test.net)}
        </p>
      )}
      <ul className="checks">
        {CHECKS.filter(([k]) => k in pool.checks).map(([k, label]) => (
          <li key={k} className={pool.checks[k] ? "ok" : "ng"}>
            <span className="mark" aria-hidden="true">
              {pool.checks[k] ? "✓" : "✕"}
            </span>
            <span>
              {k === "split"
                ? `前半${days - testDays}日で選び、後半${testDays}日でも勝てたか`
                : label}
              <small className="num">{checkValue(k, pool)}</small>
            </span>
          </li>
        ))}
      </ul>
      <table className="tbl">
        <thead>
          <tr>
            <th>銘柄</th>
            <th>回数</th>
            <th>勝率</th>
            <th>損益</th>
          </tr>
        </thead>
        <tbody>
          {pool.bySymbol.map((b) => (
            <tr key={b.symbol}>
              <td>{symbolLabel(b.symbol)}</td>
              <td className="num">{b.trades}</td>
              <td className="num">{b.winRate}%</td>
              <td className={`num ${tone(b.net)}`}>{yen(b.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <CopyButton text={wwText(pool, days, testDays)} label="結果をコピー" />
      <CopyButton text={wwTradesText(pool)} label="取引一覧をコピー（TradingViewで確認用）" />
    </div>
  );
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
        いまはクロユキ式（WW・押し戻り・フラッグW・サテライト）と、勝てる理由がある2手法（仲値・4時間足トレンドフォロー）を、主要FX6銘柄（ドル円・ユーロ円・ポンド円・豪ドル円・ユーロドル・ポンドドル）で検証しています。手法ごとに4〜16通りの設定を試し、全銘柄をまとめた成績で6段階の検証をします（サテライトは90日分の1分足で前60日・直近30日、ほかは2年分の5分足・15分足で前の1年・直近1年）。
      </p>
      <button type="button" className="primary" onClick={onRun} disabled={loading.optimize}>
        {loading.optimize ? "検証中…" : auto ? "いま選び直す" : "全銘柄で検証する"}
      </button>
      {progress && (
        <div className="progress">
          <div style={{ width: `${((progress.i - 1) / progress.total) * 100}%` }} />
          <span>
            {progress.i}/{progress.total} {symbolLabel(progress.symbol)} を検証中
            {progress.bg ? "（サーバーで進めています。画面を閉じても続きます）" : ""}
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
          {result.mode === "ww" &&
            (result.pools
              ? Object.entries(result.pools).map(([k, pool]) =>
                  pool ? (
                    <WWPool key={k} pool={pool} days={pool.days} testDays={pool.testDays} />
                  ) : (
                    <p key={k} className="hint">
                      {METHOD_NAME[k]}：この期間に条件を満たす形がありませんでした。
                    </p>
                  ),
                )
              : result.wwPool && (
                  <WWPool pool={result.wwPool} days={result.totalDays} testDays={result.testDays} />
                ))}
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
          {result.combinedWW && (
            <div className="port-box ww-box">
              <b>クロユキWWで合格：{result.wwSymbols.map((x) => symbolLabel(x)).join("・")}</b>
              <small>組み合わせた場合の{result.totalDays}日間（概算・検証のみ）</small>
              <div className="metrics">
                <Metric
                  label="損益"
                  value={yen(result.combinedWW.net)}
                  tone={tone(result.combinedWW.net)}
                  sub={`${result.combinedWW.trades}回`}
                />
                <Metric
                  label="PF"
                  value={result.combinedWW.pf}
                  sub={`勝率${result.combinedWW.winRate}%`}
                />
                <Metric
                  label="最大DD（含み損込み）"
                  value={`${(result.combinedWW.mtmDd ?? result.combinedWW.maxDd).toLocaleString("ja-JP")}円`}
                  sub={`マイナス確率${Math.round(result.combinedWW.mc.lossProb * 100)}%`}
                />
              </div>
              <Spark points={result.combinedWW.curve} height={90} />
            </div>
          )}
          <div className="opt-list">
            {result.results.map((r) => {
              const b = r.best?.checks ? r.best : null;
              const others = [r.bestScalp, r.bestGrid, r.bestWW].filter(
                (x) => x?.checks && x.strategy !== b?.strategy,
              );
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
                              {k === "split" && result.mode === "ww"
                                ? `前半${result.totalDays - result.testDays}日で選び、後半${result.testDays}日でも勝てたか`
                                : label}
                              <small className="num">{checkValue(k, b)}</small>
                            </span>
                          </li>
                        ))}
                      </ul>
                      {others.map((o) => (
                        <small className="meta" key={o.strategy}>
                          {STRAT[o.strategy]}：{o.passed}/{Object.keys(o.checks).length}
                          ・後半 PF {o.test.pf}（{o.test.trades}回・{yen(o.test.net)}）
                        </small>
                      ))}
                      {b.strategy === "grid" && b.pass && (
                        <small className="meta">
                          リピートは24時間稼働にしてから運用できます（今は検証のみ）。
                        </small>
                      )}
                      {b.strategy === "ww" && b.pass && (
                        <small className="meta">
                          クロユキWWは検証のみです。運用に組み込むのは次の段階です。
                        </small>
                      )}
                      {!auto && b.pass && b.strategy === "scalp" && (
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
