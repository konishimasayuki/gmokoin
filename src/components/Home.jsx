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

export default function Home({ snap, onClose, closing, onGo }) {
  const m = snap?.market;
  const d = snap?.digits ?? 3;
  const r = snap?.regime;
  const cfg = snap?.config;
  const daily = snap?.daily || { pnl: 0, trades: 0, wins: 0 };
  const used =
    cfg?.dailyLossLimit > 0 ? Math.min(1, Math.max(0, -daily.pnl) / cfg.dailyLossLimit) : 0;
  const htf = snap?.watch?.htfDir;
  const unit = snap?.unit || "pips";

  return (
    <>
      <section className="quote">
        <div className="quote-top">
          <span className="sym">{symbolLabel(snap?.symbol)}</span>
          {cfg?.symbolMode === "auto" && <Badge tone="brass">AIおまかせ</Badge>}
          <Badge tone={snap?.session?.ok ? "buy" : ""}>{snap?.session?.label || "—"}</Badge>
          {m?.status !== "OPEN" && m && <Badge tone="sell">クローズ中</Badge>}
        </div>
        <div className="bidask num">
          <div>
            <span>売 bid</span>
            <b>{price(m?.bid, d)}</b>
          </div>
          <div>
            <span>買 ask</span>
            <b>{price(m?.ask, d)}</b>
          </div>
        </div>
        <div className="meta">
          スプレッド {m ? `${m.spreadPips}${unit}` : "—"}
          {snap?.watch?.tf ? `・${snap.watch.tf}分足で判断` : ""}
          {snap?.watch?.atrPips != null ? `・ATR ${snap.watch.atrPips}${unit}` : ""}
          {htf != null
            ? `・${snap.watch.tf === 5 ? 15 : 5}分足 ${htf === 1 ? "上向き" : htf === -1 ? "下向き" : "横ばい"}`
            : ""}
        </div>
      </section>

      <Chart chart={snap?.chart} position={snap?.position} bid={m?.bid} digits={d} />

      <p className={`decision ${snap?.decision?.state || ""}`}>
        {snap?.decision?.text || "接続中…"}
      </p>

      <div className="grid">
        <PositionCard
          pos={snap?.position}
          digits={d}
          onClose={onClose}
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
          {!r ? (
            <p className="hint">まだ判定がありません。稼働中にすると自動で判定します。</p>
          ) : (
            <>
              <div className={`mode mode-${r.mode}`}>
                <b>{MODE_JP[r.mode]}</b>
                <span>
                  {ALLOW_JP[r.allow]}・確信度 {r.confidence}%
                </span>
              </div>
              {r.critic && (
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
                    反論役：{CRITIC_JP[r.critic.verdict]}
                  </Badge>
                  <span>{r.critic.summary}</span>
                </p>
              )}
              {r.summary && <p className="summary">{r.summary}</p>}
              <p className="meta">{hm(r.at)} 判定</p>
            </>
          )}
        </Card>

        <Card title="今日">
          <div className="metrics">
            <Metric label="損益" value={yen(daily.pnl)} tone={tone(daily.pnl)} />
            <Metric
              label="取引"
              value={`${daily.trades}回`}
              sub={daily.trades ? `勝率${Math.round((daily.wins / daily.trades) * 100)}%` : "—"}
            />
            <Metric
              label="口座（仮想）"
              value={`${(snap?.equity ?? 0).toLocaleString("ja-JP")}円`}
            />
          </div>
          <div className="limit" aria-label="本日の損失上限の消化率">
            <div style={{ width: `${used * 100}%` }} />
          </div>
          <p className="meta">
            損失上限の{Math.round(used * 100)}%
            {snap?.streak?.losses ? `・${snap.streak.losses}連敗中` : ""}
            {snap?.pauseUntil ? `・${hm(snap.pauseUntil)}まで連敗ストップ` : ""}
          </p>
          {snap?.nearest && (
            <p className="meta">
              近い水平線：上 {snap.nearest.above ? price(snap.nearest.above.price, d) : "—"}／下{" "}
              {snap.nearest.below ? price(snap.nearest.below.price, d) : "—"}
            </p>
          )}
        </Card>
      </div>
    </>
  );
}
