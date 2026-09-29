import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import Chart from "./components/Chart.jsx";
import Settings from "./components/Settings.jsx";
import {
  ALLOW_JP,
  MODE_JP,
  SIDE_JP,
  hm,
  mdhm,
  pips,
  price,
  symbolLabel,
  tone,
  yen,
} from "./format.js";

function Login({ onDone }) {
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      await api.post("/api/login", { passcode: pass });
      onDone();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login">
      <h1>FXスキャル・ペーパー</h1>
      <p className="hint">GMOコインのリアル価格で仮想売買します。実際の注文は出ません。</p>
      <input
        type="password"
        value={pass}
        placeholder="パスコード"
        onChange={(e) => setPass(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      {err && <p className="notice">{err}</p>}
      <button type="button" className="primary" onClick={submit} disabled={busy || !pass}>
        {busy ? "確認中…" : "ログイン"}
      </button>
    </main>
  );
}

function Regime({ regime, stale, loading, onRefresh }) {
  const mode = regime?.mode || null;
  return (
    <section className="card regime">
      <div className="card-head">
        <h2>Claudeの相場判定</h2>
        <button type="button" className="ghost" onClick={onRefresh} disabled={loading}>
          {loading ? "判定中…" : "今すぐ再判定"}
        </button>
      </div>
      {!regime ? (
        <p className="hint">
          {loading ? "Claudeがニュースとチャートを確認しています…" : "まだ判定がありません。"}
        </p>
      ) : (
        <>
          <div className={`mode mode-${mode}`}>
            <b>{MODE_JP[mode]}</b>
            <span>
              {ALLOW_JP[regime.allow]}・確信度 {regime.confidence}%
            </span>
          </div>
          {regime.summary && <p className="summary">{regime.summary}</p>}
          {regime.reasons?.length > 0 && (
            <ul className="reasons">
              {regime.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {regime.events?.length > 0 && (
            <div className="events">
              {regime.events.map((e) => (
                <div key={`${e.time_jst}${e.name}`} className={`event ${e.impact}`}>
                  <b className="num">{e.time_jst}</b>
                  <span>{e.name}</span>
                </div>
              ))}
            </div>
          )}
          <p className="meta">
            {hm(regime.at)} 判定{stale ? "（更新待ち）" : ""}
            {regime.pauseUntilTs ? `／${hm(regime.pauseUntilTs)}まで停止` : ""}
          </p>
        </>
      )}
    </section>
  );
}

function Position({ pos, digits, onClose, closing }) {
  if (!pos) {
    return (
      <section className="card">
        <h2>ポジション</h2>
        <p className="hint">ノーポジション</p>
      </section>
    );
  }
  const left = Math.max(
    0,
    Math.round((pos.openedAt + pos.timeStopMin * 60000 - Date.now()) / 60000),
  );
  return (
    <section className="card">
      <div className="card-head">
        <h2>ポジション</h2>
        <button type="button" className="ghost" onClick={onClose} disabled={closing}>
          {closing ? "決済中…" : "手動で決済"}
        </button>
      </div>
      <div className="pos-main">
        <b className={pos.side === "BUY" ? "up" : "down"}>{SIDE_JP[pos.side]}</b>
        <span>
          {pos.setup}・{pos.units.toLocaleString("ja-JP")}通貨
        </span>
      </div>
      <div className={`pnl num ${tone(pos.yen)}`}>
        {pips(pos.pips)}
        <small>pips</small> {yen(pos.yen)}
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
    </section>
  );
}

function Stats({ daily, stats, cfg }) {
  const used =
    cfg.dailyLossLimit > 0 ? Math.min(1, Math.max(0, -daily.pnl) / cfg.dailyLossLimit) : 0;
  const winRate = (w, n) => (n ? `${Math.round((w / n) * 100)}%` : "—");
  const pf =
    stats.grossLoss > 0
      ? (stats.grossWin / stats.grossLoss).toFixed(2)
      : stats.grossWin > 0
        ? "∞"
        : "—";
  return (
    <section className="card">
      <h2>成績</h2>
      <div className="stats">
        <div>
          <span>本日</span>
          <b className={`num ${tone(daily.pnl)}`}>{yen(daily.pnl)}</b>
          <small>
            {daily.trades}回・勝率{winRate(daily.wins, daily.trades)}
          </small>
        </div>
        <div>
          <span>累計</span>
          <b className={`num ${tone(stats.net)}`}>{yen(stats.net)}</b>
          <small>
            {stats.trades}回・勝率{winRate(stats.wins, stats.trades)}・PF {pf}
          </small>
        </div>
      </div>
      <div className="limit" aria-label="本日の損失上限の消化率">
        <div style={{ width: `${used * 100}%` }} />
      </div>
      <p className="meta">
        損失上限 {cfg.dailyLossLimit.toLocaleString("ja-JP")}円のうち {Math.round(used * 100)}
        %・手数料累計 {Math.round(stats.fees).toLocaleString("ja-JP")}円
      </p>
    </section>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(null);
  const [snap, setSnap] = useState(null);
  const [trades, setTrades] = useState([]);
  const [logs, setLogs] = useState([]);
  const [err, setErr] = useState("");
  const [regimeLoading, setRegimeLoading] = useState(false);
  const [closing, setClosing] = useState(false);
  const [settings, setSettings] = useState(null);
  const tickSecRef = useRef(5);
  const regimeBusy = useRef(false);

  useEffect(() => {
    api
      .get("/api/login")
      .then((r) => setAuthed(r.authed))
      .catch(() => setAuthed(false));
  }, []);

  const runRegime = useCallback(async (force) => {
    if (regimeBusy.current) return;
    regimeBusy.current = true;
    setRegimeLoading(true);
    try {
      const r = await api.post("/api/regime", { force });
      if (r.regime) setSnap((s) => (s ? { ...s, regime: r.regime, regimeStale: false } : s));
      if (r.error) setErr(`Claude判定に失敗：${r.error}`);
    } catch (e) {
      setErr(e.message);
    } finally {
      regimeBusy.current = false;
      setRegimeLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authed) return undefined;
    let alive = true;
    let busy = false;
    let timer = null;
    let n = 0;
    const loop = async () => {
      if (!alive || busy) return;
      busy = true;
      clearTimeout(timer);
      try {
        if (document.visibilityState === "visible") {
          const full = n % 6 === 0;
          const s = await api.post(`/api/tick${full ? "?full=1" : ""}`);
          if (!alive) return;
          setSnap(s);
          setErr("");
          if (s.trades) setTrades(s.trades);
          if (s.logs) setLogs(s.logs);
          tickSecRef.current = s.config?.tickSec || 5;
          if (s.regimeStale && s.config?.running) runRegime(false);
          n++;
        }
      } catch (e) {
        if (e.status === 401) setAuthed(false);
        else setErr(e.message);
      } finally {
        busy = false;
        if (alive) timer = setTimeout(loop, tickSecRef.current * 1000);
      }
    };
    loop();
    const onVis = () => {
      if (document.visibilityState === "visible") loop();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [authed, runRegime]);

  const toggleRunning = async () => {
    if (!snap) return;
    try {
      const out = await api.post("/api/config", { running: !snap.config.running });
      setSnap((s) => ({ ...s, config: out.config }));
      if (out.config.running && (!snap.regime || snap.regimeStale)) runRegime(false);
    } catch (e) {
      setErr(e.message);
    }
  };

  const closeNow = async () => {
    if (!window.confirm("このポジションを今のレートで決済しますか？")) return;
    setClosing(true);
    try {
      await api.post("/api/close");
      const s = await api.post("/api/tick?full=1");
      setSnap(s);
      if (s.trades) setTrades(s.trades);
      if (s.logs) setLogs(s.logs);
    } catch (e) {
      setErr(e.message);
    } finally {
      setClosing(false);
    }
  };

  const openSettings = async () => {
    try {
      const out = await api.get("/api/config");
      setSettings(out);
    } catch (e) {
      setErr(e.message);
    }
  };

  const logout = async () => {
    await api.del("/api/login").catch(() => {});
    setAuthed(false);
    setSnap(null);
  };

  if (authed === null) return <main className="login">読み込み中…</main>;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  const cfg = snap?.config;
  const m = snap?.market;
  const d = snap?.digits ?? 3;
  const running = Boolean(cfg?.running);

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>FXスキャル・ペーパー</h1>
          <p className="meta">GMOコイン実レート・仮想売買</p>
        </div>
        <button
          type="button"
          className={`run ${running ? "on" : ""}`}
          onClick={toggleRunning}
          disabled={!snap}
        >
          {running ? "稼働中" : "停止中"}
        </button>
      </header>

      {err && <p className="notice">{err}</p>}

      <section className="quote">
        <div className="sym">{symbolLabel(snap?.symbol)}</div>
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
          スプレッド {m ? `${m.spreadPips}pips` : "—"}・
          {m?.status === "OPEN" ? "取引時間中" : "クローズ中"}
          {snap?.watch?.rsi7 != null ? `・RSI7 ${snap.watch.rsi7}` : ""}
          {snap?.watch?.atrPips != null ? `・ATR ${snap.watch.atrPips}pips` : ""}
        </div>
      </section>

      <Chart chart={snap?.chart} position={snap?.position} bid={m?.bid} digits={d} />

      <p className={`decision ${snap?.decision?.state || ""}`}>
        {snap?.decision?.text || "接続中…"}
      </p>

      <div className="grid">
        <Position pos={snap?.position} digits={d} onClose={closeNow} closing={closing} />
        <Regime
          regime={snap?.regime}
          stale={snap?.regimeStale}
          loading={regimeLoading}
          onRefresh={() => runRegime(true)}
        />
        {snap && <Stats daily={snap.daily} stats={snap.stats} cfg={cfg} />}

        <section className="card">
          <h2>取引履歴</h2>
          {trades.length === 0 ? (
            <p className="hint">
              まだ取引はありません。稼働中にするとシグナルが出たところで仮想エントリーします。
            </p>
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
        </section>

        <section className="card">
          <h2>動作ログ</h2>
          <ul className="logs">
            {logs.map((l) => (
              <li key={`${l.t}${l.msg}`} className={l.level}>
                <span className="meta num">{hm(l.t)}</span>
                <span>{l.msg}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <footer className="foot">
        <button type="button" className="ghost" onClick={openSettings}>
          設定
        </button>
        <button type="button" className="ghost" onClick={logout}>
          ログアウト
        </button>
        <p className="hint">
          この画面を開いている間だけ動きます。閉じていた間の損切り・利確は、再開時に1分足で判定します。ペーパートレード専用で、実際の注文は出ません。
        </p>
      </footer>

      {settings && (
        <Settings
          config={settings.config}
          symbols={settings.symbols}
          hasPosition={Boolean(snap?.position)}
          onClose={() => setSettings(null)}
          onSaved={(c) => setSnap((s) => (s ? { ...s, config: c } : s))}
        />
      )}
    </div>
  );
}
