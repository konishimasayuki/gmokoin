import { useState } from "react";
import { api } from "../api.js";
import { mdhm, tone, yen } from "../format.js";
import Spark from "./Spark.jsx";
import { Card, Empty, Metric } from "./ui.jsx";

const SL_OPTIONS = [
  ["atr:2", "ATR×2（今の設定）"],
  ["atr:1.5", "ATR×1.5"],
  ["atr:3", "ATR×3"],
  ["pips:10", "10pips"],
  ["pips:15", "15pips"],
  ["pips:20", "20pips"],
  ["pips:30", "30pips"],
  ["none:0", "損切りなし（時刻で決済のみ）"],
];
const man = (u) => `${(u / 10000).toLocaleString("ja-JP")}万通貨`;
const d = (ts) =>
  ts ? new Date(ts + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, "/") : "開始時";

function text(r) {
  const o = r.options;
  const y = (v) => `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString("ja-JP")}円`;
  const lines = [
    `【資金シミュレーション】${d(r.from)}〜${d(r.to)}（${o.years}年）`,
    `開始${man(o.startUnits)}・利益${o.stepYen / 10000}万円ごとに+${man(o.stepUnits)}（上限${man(o.maxUnits)}）・損切り${o.slMode === "none" ? "なし" : o.slMode === "atr" ? `ATR×${o.slValue}` : `${o.slValue}pips`}・スプレッド${o.spreadPips}pips`,
    `合計 ${y(r.total.net)} ${r.total.trades}回 勝率${r.total.winRate}% PF${r.total.pf} 最大DD-${r.total.maxDd.toLocaleString("ja-JP")}円 損切り${r.total.stops}回 最終${man(r.total.finalUnits)}`,
    ...Object.values(r.byStrat).map(
      (s) => ` ${s.name}：${y(s.net)} ${s.trades}回 勝率${s.winRate}% PF${s.pf} 損切り${s.stops}回`,
    ),
    r.slPips
      ? `損切り幅 平均${r.slPips.avg}pips（${r.slPips.min}〜${r.slPips.max}）`
      : "損切りなし",
    "■ 数量の変化",
    ...r.ladder.map(
      (l) =>
        ` ${d(l.at)} → ${man(l.units)}${l.profit !== undefined ? `（累計${y(l.profit)}）` : ""}`,
    ),
    "■ 月ごと",
    ...r.months.map((m) => ` ${m.ym} ${m.trades}回 ${y(m.net)}（最大${man(m.units)}）`),
  ];
  return lines.join("\n");
}

export default function FundSim() {
  const [form, setForm] = useState({
    years: 1,
    startUnits: 10000,
    stepMan: 10,
    maxMan: 10,
    sl: "atr:2",
    spreadPips: 0.2,
    useMain: true,
    useAdd: true,
  });
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      const [slMode, slValue] = form.sl.split(":");
      const r = await api.post("/api/fundsim", {
        years: form.years,
        startUnits: form.startUnits,
        stepYen: Number(form.stepMan) * 10000,
        stepUnits: 10000,
        maxUnits: Number(form.maxMan) * 10000,
        slMode,
        slValue: Number(slValue),
        spreadPips: Number(form.spreadPips),
        useMain: form.useMain,
        useAdd: form.useAdd,
      });
      setRes(r.result);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text(res));
      setCopied("コピーしました");
    } catch {
      setCopied("コピーできませんでした");
    }
  };

  return (
    <Card title="資金シミュレーション（ドル円・本命＋追加候補）">
      <p className="hint">
        本命＝毎営業日8:00に買い→9:55に決済。追加候補＝ゴトー日と月末の9:55に売り→12:00に決済。過去の5分足で、1万通貨から始めて利益に応じて数量を増やした場合を再生します。
      </p>
      <div className="form-grid">
        <label>
          期間
          <select value={form.years} onChange={(e) => set("years", Number(e.target.value))}>
            <option value={0.5}>半年</option>
            <option value={1}>1年</option>
            <option value={2}>2年</option>
          </select>
        </label>
        <label>
          開始の数量
          <select
            value={form.startUnits}
            onChange={(e) => set("startUnits", Number(e.target.value))}
          >
            <option value={10000}>1万通貨</option>
            <option value={20000}>2万通貨</option>
            <option value={30000}>3万通貨</option>
          </select>
        </label>
        <label>
          利益◯万円ごとに＋1万通貨
          <input
            type="number"
            min="0"
            step="1"
            value={form.stepMan}
            onChange={(e) => set("stepMan", e.target.value)}
          />
        </label>
        <label>
          数量の上限（万通貨）
          <input
            type="number"
            min="1"
            step="1"
            value={form.maxMan}
            onChange={(e) => set("maxMan", e.target.value)}
          />
        </label>
        <label>
          損切り
          <select value={form.sl} onChange={(e) => set("sl", e.target.value)}>
            {SL_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          想定スプレッド（pips）
          <input
            type="number"
            min="0"
            step="0.1"
            value={form.spreadPips}
            onChange={(e) => set("spreadPips", e.target.value)}
          />
        </label>
      </div>
      <div className="chips">
        <button
          type="button"
          className={`chip ${form.useMain ? "on" : ""}`}
          onClick={() => set("useMain", !form.useMain)}
        >
          本命
        </button>
        <button
          type="button"
          className={`chip ${form.useAdd ? "on" : ""}`}
          onClick={() => set("useAdd", !form.useAdd)}
        >
          追加候補
        </button>
      </div>
      <p className="hint">
        「0万円ごと」にすると数量を増やしません。利益が減ると数量も戻ります。手数料（往復0.4pips相当）込み。
      </p>
      <button
        type="button"
        className="primary wide"
        onClick={run}
        disabled={busy || (!form.useMain && !form.useAdd)}
      >
        {busy ? "計算中…" : "シミュレーション"}
      </button>
      {err && <p className="hint">{err}</p>}
      {!res ? (
        <Empty>条件を選んで「シミュレーション」を押してください。</Empty>
      ) : (
        <>
          <p className="meta">
            {d(res.from)}〜{d(res.to)}
          </p>
          <div className="metrics">
            <Metric
              label="損益"
              value={yen(res.total.net)}
              tone={tone(res.total.net)}
              sub={`${res.total.trades}回・勝率${res.total.winRate}%`}
            />
            <Metric
              label="最大DD"
              value={`${res.total.maxDd.toLocaleString("ja-JP")}円`}
              sub={`PF ${res.total.pf}`}
            />
            <Metric
              label="最終の数量"
              value={man(res.total.finalUnits)}
              sub={`損切り${res.total.stops}回`}
            />
          </div>
          <Spark points={res.curve} height={100} />
          <table className="tbl">
            <thead>
              <tr>
                <th>手法</th>
                <th>回数</th>
                <th>勝率</th>
                <th>PF</th>
                <th>損益</th>
              </tr>
            </thead>
            <tbody>
              {Object.values(res.byStrat).map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td className="num">{s.trades}</td>
                  <td className="num">{s.winRate}%</td>
                  <td className="num">{s.pf}</td>
                  <td className={`num ${tone(s.net)}`}>{yen(s.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="meta">
            {res.slPips
              ? `損切り幅：平均${res.slPips.avg}pips（${res.slPips.min}〜${res.slPips.max}pips）。1万通貨なら1pips＝100円。`
              : "損切りなし（決済は時刻だけ）"}
          </p>
          <h3>数量の変化</h3>
          <ul className="reasons">
            {res.ladder.map((l) => (
              <li key={`${l.at}-${l.units}`}>
                {d(l.at)} → {man(l.units)}
                {l.profit !== undefined ? `（累計 ${yen(l.profit)}）` : ""}
              </li>
            ))}
          </ul>
          <h3>月ごと</h3>
          <table className="tbl">
            <thead>
              <tr>
                <th>月</th>
                <th>回数</th>
                <th>損益</th>
                <th>数量</th>
              </tr>
            </thead>
            <tbody>
              {res.months.map((m) => (
                <tr key={m.ym}>
                  <td>{m.ym}</td>
                  <td className="num">{m.trades}</td>
                  <td className={`num ${tone(m.net)}`}>{yen(m.net)}</td>
                  <td className="num">{man(m.units)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>直近の取引</h3>
          <ul className="trades">
            {res.recent.map((t) => (
              <li key={`${t.strat}${t.openedAt}`}>
                <span className="meta num">{mdhm(t.openedAt)}</span>
                <span className="grow">
                  {t.strat === "main" ? "本命・買い" : "追加・売り"} {man(t.units)}
                  <small>{t.reason}</small>
                </span>
                <b className={`num ${tone(t.net)}`}>{yen(t.net)}</b>
              </li>
            ))}
          </ul>
          <button type="button" className="ghost wide" onClick={copy}>
            結果をコピー
          </button>
          {copied && <p className="hint">{copied}</p>}
        </>
      )}
    </Card>
  );
}
