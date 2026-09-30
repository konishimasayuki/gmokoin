import {
  ALLOW_JP,
  CRITIC_JP,
  MODE_JP,
  SIDE_JP,
  hm,
  pips,
  price,
  qtyLabel,
  symbolLabel,
  tone,
  yen,
} from "../format.js";
import Chart from "./Chart.jsx";
import { Badge, Card, Metric } from "./ui.jsx";

function PositionCard({ pos, digits, onClose, closing, unit }) {
  if (!pos) {
    return (
      <Card title="ポジション">
        <p className="hint">ノーポジション。条件がそろうと自動でエントリーします。</p>
      </Card>
    );
  }
  const left = Math.max(
    0,
    Math.round((pos.openedAt + pos.timeStopMin * 60000 - Date.now()) / 60000),
  );
  return (
    <Card
      title="ポジション"
      className="pos-card"
      action={
        <button type="button" className="ghost" onClick={onClose} disabled={closing}>
          {closing ? "決済中…" : "手動で決済"}
        </button>
      }
    >
      <div className="pos-main">
        <b className={pos.side === "BUY" ? "up" : "down"}>{SIDE_JP[pos.side]}</b>
        <span>
          {pos.setup}・{pos.units.toLocaleString("ja-JP")}
          {qtyLabel(pos.symbol)}
        </span>
        {pos.beMoved && <Badge tone="brass">建値ストップ</Badge>}
      </div>
      <div className={`pnl num ${tone(pos.yen)}`}>
        {pips(pos.pips)}
        <small>{unit}</small> {yen(pos.yen)}
      </div>
      <div className="levels">
        <div>
          <span>建値</span>
          <b className="num">{price(pos.entry, digits)}</b>
        </div>
        <div>
          <span>損切り</span>
          <b className="num down">{price(pos.sl, digits)}</b>
        </div>
        <div>
          <span>利確</span>
          <b className="num up">{price(pos.tp, digits)}</b>
        </div>
      </div>
      <p className="meta">
        {hm(pos.openedAt)} 約定・時間切れまで約{left}分
      </p>
    </Card>
  );
}

const MODE_SHORT = { TREND_UP: "上昇", TREND_DOWN: "下降", RANGE: "レンジ", NO_TRADE: "見送り" };

function SymbolRow({ row, active, onPick }) {
  const pos = row.position;
  return (
    <button
      type="button"
      className={`srow ${active ? "on" : ""}`}
      onClick={() => onPick(row.symbol)}
    >
      <div className="srow-top">
        <b>{symbolLabel(row.symbol)}</b>
        {row.regime && (
          <span className={`mode-chip mode-${row.regime.mode}`}>
            {MODE_SHORT[row.regime.mode]}
            {row.regime.mode !== "NO_TRADE" ? ` ${row.regime.confidence}%` : ""}
          </span>
        )}
        {!row.inPortfolio && <Badge>採用外</Badge>}
        <span className="num srow-price">{price(row.bid, row.digits)}</span>
      </div>
      <div className="srow-bottom">
        {pos ? (
          <span className={`num ${tone(pos.yen)}`}>
            {SIDE_JP[pos.side]} {pips(pos.pips)}
            {row.unit} {yen(pos.yen)}
          </span>
        ) : (
          <span className={`srow-state ${row.decision?.state || ""}`}>
            {row.decision?.text || "—"}
          </span>
        )}
      </div>
    </button>
  );
}

export default function Home({ snap, onClose, closing, onGo, focus, onFocus }) {
  const cfg = snap?.config;
  const rows = snap?.rows || [];
  const cur = rows.find((r) => r.symbol === (focus || snap?.focus)) || rows[0];
  const detail = snap?.detail;
  const d = cur?.digits ?? 3;
  const unit = cur?.unit || "pips";
  const daily = snap?.daily || { pnl: 0, trades: 0, wins: 0 };
  const used =
    cfg?.dailyLossLimit > 0 ? Math.min(1, Math.max(0, -daily.pnl) / cfg.dailyLossLimit) : 0;
  const full = snap?.regime?.symbols?.[cur?.symbol] || null;
  const htf = cur?.watch?.htfDir;
  const t = snap?.totals || { open: 0, maxPositions: 0, unrealized: 0 };

  return (
    <>
      <section className="card summary-card">
        <div className="metrics">
          <Metric
            label="今日の損益"
            value={yen(daily.pnl)}
            tone={tone(daily.pnl)}
            sub={`${daily.trades}回`}
          />
          <Metric
            label="含み損益"
            value={yen(t.unrealized)}
            tone={tone(t.unrealized)}
            sub={`保有 ${t.open}/${t.maxPositions}`}
          />
          <Metric label="口座（仮想）" value={`${(snap?.equity ?? 0).toLocaleString("ja-JP")}円`} />
        </div>
        <div className="limit" aria-label="本日の損失上限の消化率">
          <div style={{ width: `${used * 100}%` }} />
        </div>
        <p className="meta">
          損失上限の{Math.round(used * 100)}%
          {snap?.streak?.losses ? `・${snap.streak.losses}連敗中` : ""}
          {snap?.pauseUntil ? `・${hm(snap.pauseUntil)}まで連敗ストップ` : ""}
          {cfg?.symbolMode === "auto"
            ? `・AIおまかせ ${rows.filter((r) => r.inPortfolio).length}銘柄`
            : ""}
        </p>
      </section>

      {rows.length === 0 ? (
        <Card title="監視中の銘柄">
          <p className="hint">
            まだ監視する銘柄がありません。成績 →
            検証で「いま選び直す」を押すと、合格した銘柄が自動で入ります。
          </p>
        </Card>
      ) : (
        <section className="srows">
          {rows.map((r) => (
            <SymbolRow key={r.symbol} row={r} active={r.symbol === cur?.symbol} onPick={onFocus} />
          ))}
        </section>
      )}

      {cur && (
        <>
          <section className="quote">
            <div className="quote-top">
              <span className="sym">{symbolLabel(cur.symbol)}</span>
              <Badge tone={cur.session?.ok ? "buy" : ""}>{cur.session?.label || "—"}</Badge>
              {cur.status !== "OPEN" && <Badge tone="sell">クローズ中</Badge>}
            </div>
            <div className="bidask num">
              <div>
                <span>売 bid</span>
                <b>{price(cur.bid, d)}</b>
              </div>
              <div>
                <span>買 ask</span>
                <b>{price(cur.ask, d)}</b>
              </div>
            </div>
            <div className="meta">
              スプレッド {cur.spreadPips ?? "—"}
              {unit}
              {cur.watch?.tf ? `・${cur.watch.tf}分足で判断` : ""}
              {cur.watch?.atrPips != null ? `・ATR ${cur.watch.atrPips}${unit}` : ""}
              {htf != null
                ? `・${cur.watch.tf === 5 ? 15 : 5}分足 ${htf === 1 ? "上向き" : htf === -1 ? "下向き" : "横ばい"}`
                : ""}
            </div>
            {cur.label && <p className="meta">検証済みの設定：{cur.label}</p>}
          </section>

          <Chart
            chart={detail?.symbol === cur.symbol ? detail.chart : null}
            position={cur.position}
            bid={cur.bid}
            digits={d}
          />

          <p className={`decision ${cur.decision?.state || ""}`}>
            {cur.decision?.text || "接続中…"}
          </p>

          <div className="grid">
            <PositionCard
              pos={cur.position}
              digits={d}
              onClose={() => onClose(cur.symbol)}
              closing={closing}
              unit={unit}
            />
            <Card
              title="AIの方針"
              action={
                <button type="button" className="ghost" onClick={() => onGo("brain")}>
                  詳しく
                </button>
              }
            >
              {!full ? (
                <p className="hint">まだ判定がありません。稼働中にすると自動で判定します。</p>
              ) : (
                <>
                  <div className={`mode mode-${full.mode}`}>
                    <b>{MODE_JP[full.mode]}</b>
                    <span>
                      {ALLOW_JP[full.allow]}・確信度 {full.confidence}%
                    </span>
                  </div>
                  {full.critic && (
                    <p className="critic-line">
                      <Badge
                        tone={
                          full.critic.verdict === "VETO"
                            ? "sell"
                            : full.critic.verdict === "WEAKEN"
                              ? "brass"
                              : "buy"
                        }
                      >
                        反論役：{CRITIC_JP[full.critic.verdict]}
                      </Badge>
                      <span>{full.critic.summary}</span>
                    </p>
                  )}
                  {full.summary && <p className="summary">{full.summary}</p>}
                  <p className="meta">{hm(snap?.regime?.at)} 判定</p>
                </>
              )}
              {detail?.symbol === cur.symbol && detail?.nearest && (
                <p className="meta">
                  近い水平線：上 {detail.nearest.above ? price(detail.nearest.above.price, d) : "—"}
                  ／下 {detail.nearest.below ? price(detail.nearest.below.price, d) : "—"}
                </p>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
