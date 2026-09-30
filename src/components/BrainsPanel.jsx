import { useState } from "react";
import { MODE_JP, hm, mdhm, symbolLabel, tone, yen } from "../format.js";
import { Badge, Card, Empty } from "./ui.jsx";

const STATUS = { active: ["使用中", "buy"], shadow: ["影で比較中", "brass"], off: ["", ""] };

function sumStats(a, b) {
  const x = a || {};
  const y = b || {};
  const n = (k) => (x[k] || 0) + (y[k] || 0);
  const trades = n("trades");
  return {
    trades,
    net: n("net"),
    winRate: trades ? Math.round((n("wins") / trades) * 100) : null,
    pf:
      n("grossLoss") > 0
        ? (n("grossWin") / n("grossLoss")).toFixed(2)
        : n("grossWin") > 0
          ? "∞"
          : "—",
  };
}

function Detail({ b, models, onClose, intervals }) {
  return (
    <div
      className="sheet-backdrop"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <section
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => {}}
        aria-label={b.name}
      >
        <div className="sheet-head">
          <h2>{b.name}</h2>
          <button type="button" className="ghost" onClick={onClose}>
            閉じる
          </button>
        </div>
        <p className="summary">{b.summary}</p>

        <h3>考え方</h3>
        <ul className="reasons">
          {b.thinks.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>

        <h3>見ているデータ</h3>
        <div className="chips">
          {b.data.map((d) => (
            <span key={d} className="chip on">
              {d}
            </span>
          ))}
        </div>

        <h3>動き方</h3>
        <div className="kv">
          <span>種類</span>
          <b>{b.kind === "ai" ? "AI（Claude）" : "ルール（Claude不要）"}</b>
          {b.kind === "ai" && (
            <>
              <span>モデル</span>
              <b>
                {models[b.model]?.label}（{models[b.model]?.note}）
              </b>
            </>
          )}
          <span>判定の間隔</span>
          <b>
            {b.kind === "ai"
              ? `使用中は${intervals.active}分ごと／影は${intervals.shadow}分ごと`
              : "価格チェックのたび（無料）"}
          </b>
          <span>料金</span>
          <b>{b.cost}</b>
          <span>過去データで検証</span>
          <b>{b.backtest ? "できる（6段階の検証）" : "できない（影の運用で比べる）"}</b>
        </div>
        <p className="hint">
          売買のタイミング・損切り・利確・安全装置は、どの脳でも同じルールが担当します。脳が決めるのは「その銘柄を今、買いで狙うか・売りで狙うか・休むか」です。
        </p>

        {b.system && (
          <details className="prompt">
            <summary>AIへの指示（プロンプト全文）</summary>
            <pre>{b.system}</pre>
          </details>
        )}

        <h3>直近の判断</h3>
        {b.log?.length ? (
          <ul className="blog">
            {b.log.map((l) => (
              <li key={l.at}>
                <span className="meta num">{mdhm(l.at)}</span>
                <div>
                  {l.summary && <p className="summary">{l.summary}</p>}
                  {Object.entries(l.symbols || {}).map(([s, v]) => (
                    <p key={s} className="meta">
                      {symbolLabel(s)}：{MODE_JP[v.mode]}
                      {v.mode !== "NO_TRADE" ? `（${v.confidence}%）` : ""}
                      {v.summary ? `・${v.summary}` : ""}
                    </p>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>
            {b.kind === "ai"
              ? "まだ判断していません。"
              : "ルール型は判断を記録せず、毎回その場で計算します。"}
          </Empty>
        )}

        {b.shadowTrades?.length > 0 && (
          <>
            <h3>影の運用での取引（直近）</h3>
            <ul className="trades">
              {b.shadowTrades.map((t) => (
                <li key={`${t.symbol}${t.closedAt}`}>
                  <span className="meta num">{mdhm(t.closedAt)}</span>
                  <span className="grow">
                    {symbolLabel(t.symbol)}・{t.setup}
                    <small>{t.reason}</small>
                  </span>
                  <b className={`num ${tone(t.net)}`}>{yen(t.net)}</b>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

export default function BrainsPanel({ data, onSetActive, onToggleShadow, onModel, busy }) {
  const [open, setOpen] = useState(null);
  if (!data)
    return (
      <Card title="脳みそ">
        <Empty>読み込み中…</Empty>
      </Card>
    );
  const { brains, models, aiAvailable } = data;
  const active = brains.find((b) => b.id === data.active);
  const ranked = brains
    .map((b) => ({ b, s: sumStats(b.liveStats, b.shadowStats) }))
    .filter((x) => x.s.trades > 0)
    .sort((a, b) => b.s.net - a.s.net);
  const intervals = { active: data.regimeIntervalMin, shadow: data.shadowIntervalMin };
  const current = brains.find((b) => b.id === open);

  return (
    <>
      <Card
        title="使っている脳"
        className="brain-hero"
        action={
          <button type="button" className="ghost" onClick={() => setOpen(active.id)}>
            中身を見る
          </button>
        }
      >
        <div className="brain-name">
          <b>{active.name}</b>
          <Badge tone={active.kind === "ai" ? "brass" : ""}>{active.tag}</Badge>
          {active.kind === "ai" && <Badge>{models[active.model]?.label}</Badge>}
        </div>
        <p className="summary">{active.summary}</p>
        {!aiAvailable && (
          <p className="hint">Claude APIがまだつながっていないので、ルール型の脳だけ使えます。</p>
        )}
      </Card>

      <Card title="成績の比較">
        {ranked.length === 0 ? (
          <Empty>
            まだ比較できる取引がありません。稼働中にすると、使用中の脳と影の脳の成績がここに並びます。
          </Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>脳</th>
                <th>回数</th>
                <th>勝率</th>
                <th>PF</th>
                <th>損益</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map(({ b, s }) => (
                <tr key={b.id}>
                  <td>{b.name}</td>
                  <td className="num">{s.trades}</td>
                  <td className="num">{s.winRate ?? "—"}%</td>
                  <td className="num">{s.pf}</td>
                  <td className={`num ${tone(s.net)}`}>{yen(s.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">
          本番で使った分と、影で仮想売買した分の合計です。影の脳は注文を出さず「この脳の判断で売買していたら」を記録します（最大3つ）。
        </p>
      </Card>

      <Card title="脳みその一覧">
        <div className="brains">
          {brains.map((b) => {
            const needAi = b.kind === "ai" && !aiAvailable;
            const [st, stTone] = STATUS[b.status];
            const s = sumStats(b.liveStats, b.shadowStats);
            return (
              <div key={b.id} className={`brain ${b.status} ${b.disabled ? "disabled" : ""}`}>
                <div className="brain-name">
                  <b>{b.name}</b>
                  <Badge tone={b.kind === "ai" ? "brass" : ""}>{b.tag}</Badge>
                  {st && <Badge tone={stTone}>{st}</Badge>}
                  {b.disabled && <Badge>準備中</Badge>}
                </div>
                <p className="meta">{b.summary}</p>
                {s.trades > 0 && (
                  <p className="meta num">
                    {s.trades}回・勝率{s.winRate}%・
                    <span className={tone(s.net)}>{yen(s.net)}</span>
                  </p>
                )}
                {b.kind === "ai" && !b.disabled && (
                  <div className="seg small">
                    {Object.entries(models).map(([k, m]) => (
                      <button
                        type="button"
                        key={k}
                        aria-selected={b.model === k}
                        onClick={() => onModel(b.id, k)}
                        disabled={busy}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="btns">
                  <button type="button" className="ghost" onClick={() => setOpen(b.id)}>
                    中身を見る
                  </button>
                  {!b.disabled && b.status !== "active" && (
                    <button
                      type="button"
                      className="ghost"
                      disabled={needAi || busy}
                      onClick={() => onSetActive(b.id)}
                    >
                      これを使う
                    </button>
                  )}
                  {!b.disabled && b.status !== "active" && (
                    <button
                      type="button"
                      className="ghost"
                      disabled={needAi || busy}
                      onClick={() => onToggleShadow(b.id)}
                    >
                      {b.status === "shadow" ? "影をやめる" : "影で比較"}
                    </button>
                  )}
                </div>
                {needAi && !b.disabled && <p className="hint">Claude APIをつなぐと使えます</p>}
              </div>
            );
          })}
        </div>
      </Card>

      {current && (
        <Detail b={current} models={models} intervals={intervals} onClose={() => setOpen(null)} />
      )}
      <p className="meta">{data.at ? `${hm(data.at)} 更新` : ""}</p>
    </>
  );
}
