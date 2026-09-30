import { ALLOW_JP, CRITIC_JP, MODE_JP, hm, price } from "../format.js";
import { Badge, Card, Empty } from "./ui.jsx";

function List({ items }) {
  if (!items?.length) return null;
  return (
    <ul className="reasons">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

function Team({ snap }) {
  const r = snap?.regime;
  const b = snap?.brief;
  const members = [
    {
      name: "ファンダ担当",
      role: "指標・ニュースの事実確認",
      state: b ? `${hm(b.at)} 作成` : "未作成",
      ok: Boolean(b),
    },
    {
      name: "議長",
      role: "チャートとファンダを統合",
      state: r
        ? `${MODE_JP[r.chairMode || r.mode]}（${r.chairConfidence ?? r.confidence}%）`
        : "未判定",
      ok: Boolean(r && !r.error),
    },
    {
      name: "反論役",
      role: "弱点と見落としを指摘",
      state: r?.critic ? CRITIC_JP[r.critic.verdict] : r ? "出番なし（見送り）" : "—",
      ok: Boolean(r?.critic),
    },
    {
      name: "リスク管理",
      role: "固定ルールで最終チェック",
      state: snap?.decision?.state === "blocked" ? "ブロック中" : "監視中",
      ok: snap?.decision?.state !== "blocked",
    },
  ];
  return (
    <div className="team">
      {members.map((m) => (
        <div key={m.name} className={`member ${m.ok ? "ok" : ""}`}>
          <b>{m.name}</b>
          <small>{m.role}</small>
          <span>{m.state}</span>
        </div>
      ))}
    </div>
  );
}

function Ladder({ levels, digits, mid }) {
  if (!levels) return <Empty>水平線マップはまだありません。</Empty>;
  const rows = [...levels.weekly.above, ...levels.daily.above].map((l) => ({ ...l, pos: "above" }));
  const rowsB = [...levels.weekly.below, ...levels.daily.below].map((l) => ({
    ...l,
    pos: "below",
  }));
  const pip = levels.unit === "bp" ? levels.price * 0.0001 : digits === 3 ? 0.01 : 0.0001;
  const all = [...rows, ...rowsB].sort((a, b) => b.price - a.price);
  const uniq = all.filter((l, i) => i === 0 || Math.abs(l.price - all[i - 1].price) > pip / 2);
  let inserted = false;
  const out = [];
  for (const l of uniq) {
    if (!inserted && mid && l.price < mid) {
      out.push({ now: true, price: mid });
      inserted = true;
    }
    out.push(l);
  }
  if (!inserted && mid) out.push({ now: true, price: mid });
  return (
    <div className="ladder">
      {out.map((l) =>
        l.now ? (
          <div key="now" className="rung now">
            <b className="num">{price(l.price, digits)}</b>
            <span>いまここ</span>
          </div>
        ) : (
          <div key={`${l.frame}${l.price}`} className={`rung ${l.pos}`}>
            <b className="num">{price(l.price, digits)}</b>
            <Badge tone={l.frame === "週足" ? "brass" : ""}>{l.frame}</Badge>
            <span className="dots" aria-label={`反発${l.touches}回`}>
              {"●".repeat(Math.min(l.touches, 6))}
            </span>
            <small className="num">
              {mid
                ? `${l.price > mid ? "+" : ""}${((l.price - mid) / pip).toFixed(0)}${levels.unit || "pips"}`
                : ""}
            </small>
          </div>
        ),
      )}
    </div>
  );
}

export default function Brain({ snap, loading, onRegime, onBrief, onLevels }) {
  const r = snap?.regime;
  const b = snap?.brief;
  const lv = snap?.levels;
  const d = snap?.digits ?? 3;
  const mid = snap?.market ? (snap.market.bid + snap.market.ask) / 2 : null;

  return (
    <>
      <Card title="AIチーム">
        <Team snap={snap} />
        <p className="hint">
          ファンダ担当が朝に材料を整理し、議長が15分ごとに方針を決め、反論役がそれを突きます。最後はプログラムのルールが売買を判断します。
        </p>
      </Card>

      <Card
        title="議長の判定"
        action={
          <button type="button" className="ghost" onClick={onRegime} disabled={loading.regime}>
            {loading.regime ? "判定中…" : "今すぐ再判定"}
          </button>
        }
      >
        {!r ? (
          <Empty>
            {loading.regime ? "チャートとニュースを確認しています…" : "まだ判定がありません。"}
          </Empty>
        ) : (
          <>
            <div className={`mode mode-${r.mode}`}>
              <b>{MODE_JP[r.mode]}</b>
              <span>
                {ALLOW_JP[r.allow]}・確信度 {r.confidence}%
                {r.chairMode && r.chairMode !== r.mode ? `（議長は${MODE_JP[r.chairMode]}）` : ""}
              </span>
            </div>
            {r.summary && <p className="summary">{r.summary}</p>}
            {r.technical?.length > 0 && <h3>テクニカル</h3>}
            <List items={r.technical} />
            {r.fundamental?.length > 0 && <h3>ファンダメンタル</h3>}
            <List items={r.fundamental} />
            {r.reasons?.length > 0 && <h3>総合</h3>}
            <List items={r.reasons} />
            {r.events?.length > 0 && (
              <div className="events">
                {r.events.map((e) => (
                  <div key={`${e.time_jst}${e.name}`} className={`event ${e.impact}`}>
                    <b className="num">{e.time_jst}</b>
                    <span>{e.name}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="meta">
              {hm(r.at)} 判定{snap?.regimeStale ? "（更新待ち）" : ""}
              {r.pauseUntilTs ? `・${hm(r.pauseUntilTs)}まで停止` : ""}
            </p>
          </>
        )}
      </Card>

      <Card title="反論役のチェック">
        {!r?.critic ? (
          <Empty>議長が「見送り」のときは出番がありません。</Empty>
        ) : (
          <>
            <p className="critic-line">
              <Badge
                tone={
                  r.critic.verdict === "VETO"
                    ? "sell"
                    : r.critic.verdict === "WEAKEN"
                      ? "brass"
                      : "buy"
                }
              >
                {CRITIC_JP[r.critic.verdict]}
              </Badge>
              <span>
                {r.critic.summary}
                {r.critic.confidence_delta ? `（確信度${r.critic.confidence_delta}）` : ""}
              </span>
            </p>
            {r.critic.objections?.length > 0 && <h3>反論</h3>}
            <List items={r.critic.objections} />
            {r.critic.missed_risks?.length > 0 && <h3>見落としリスク</h3>}
            <List items={r.critic.missed_risks} />
          </>
        )}
      </Card>

      <Card
        title="本日のブリーフ"
        action={
          <button type="button" className="ghost" onClick={onBrief} disabled={loading.brief}>
            {loading.brief ? "作成中…" : b ? "作り直す" : "作成"}
          </button>
        }
      >
        {!b ? (
          <Empty>
            {loading.brief ? "指標とニュースを調べています…" : "本日のブリーフはまだありません。"}
          </Empty>
        ) : (
          <>
            <p className="summary">{b.summary}</p>
            {b.caution && <p className="notice soft">注意：{b.caution}</p>}
            {b.events?.length > 0 && <h3>本日の指標</h3>}
            <div className="events">
              {b.events.map((e) => (
                <div key={`${e.time_jst}${e.name}`} className={`event ${e.impact}`}>
                  <b className="num">{e.time_jst}</b>
                  <span>
                    {e.name}
                    <small>
                      予想 {e.forecast || "—"}／前回 {e.previous || "—"}
                      {e.typical_reaction ? `・${e.typical_reaction}` : ""}
                    </small>
                  </span>
                </div>
              ))}
            </div>
            {b.news?.length > 0 && <h3>ニュース（事実確認済み）</h3>}
            <ul className="news">
              {b.news.map((n) => (
                <li key={n.fact}>
                  <Badge
                    tone={n.status === "確認済み" ? "buy" : n.status === "未確認" ? "" : "sell"}
                  >
                    {n.status}
                  </Badge>
                  <span>
                    {n.fact}
                    {n.source && <small>{n.source}</small>}
                  </span>
                </li>
              ))}
            </ul>
            {b.week_events?.length > 0 && <h3>今週の予定</h3>}
            <div className="events">
              {b.week_events.map((e) => (
                <div key={`${e.day}${e.time_jst}${e.name}`} className={`event ${e.impact}`}>
                  <b className="num">{e.day}</b>
                  <span>
                    {e.time_jst} {e.name}
                  </span>
                </div>
              ))}
            </div>
            <p className="meta">{hm(b.at)} 作成</p>
          </>
        )}
      </Card>

      <Card
        title="水平線マップ"
        action={
          <button type="button" className="ghost" onClick={onLevels} disabled={loading.levels}>
            {loading.levels ? "計算中…" : "更新"}
          </button>
        }
      >
        {lv && (
          <div className="zone">
            <div>
              <span>週足の流れ</span>
              <b
                className={
                  lv.weekly.trend === "上昇" ? "up" : lv.weekly.trend === "下降" ? "down" : ""
                }
              >
                {lv.weekly.trend}
              </b>
            </div>
            <div>
              <span>過去2年での位置</span>
              <b>{lv.weekly.zone}</b>
              <div className="zonebar">
                <i
                  style={{ left: `${Math.min(100, Math.max(0, lv.weekly.positionPct ?? 50))}%` }}
                />
              </div>
              <small className="num">
                {price(lv.weekly.rangeLow, d)}〜{price(lv.weekly.rangeHigh, d)}
              </small>
            </div>
          </div>
        )}
        <Ladder levels={lv} digits={d} mid={mid} />
        <p className="hint">
          ●の数は反発した回数です。利確までの間に強い線があると、エントリーを見送ります。
        </p>
      </Card>
    </>
  );
}
