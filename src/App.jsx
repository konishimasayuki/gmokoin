import { useCallback, useEffect, useRef, useState } from "react";
import ErrorBoundary from "./ErrorBoundary.jsx";
import { api } from "./api.js";
import Brain from "./components/Brain.jsx";
import Home from "./components/Home.jsx";
import Results from "./components/Results.jsx";
import SettingsPage from "./components/SettingsPage.jsx";

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

const TABS = [
  ["home", "ホーム", "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"],
  [
    "brain",
    "AI頭脳",
    "M12 3a6 6 0 0 0-6 6c0 2.2 1.2 3.6 2 4.5V17h8v-3.5c.8-.9 2-2.3 2-4.5a6 6 0 0 0-6-6zM9 20h6",
  ],
  ["results", "成績", "M4 20V10M10 20V4M16 20v-7M22 20H2"],
  [
    "settings",
    "設定",
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13a7.9 7.9 0 0 0 0-2l2-1.6-2-3.4-2.4 1a8 8 0 0 0-1.7-1L15 3.5h-4l-.3 2.5a8 8 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.9 7.9 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 1.7 1l.3 2.5h4l.3-2.5a8 8 0 0 0 1.7-1l2.4 1 2-3.4z",
  ],
];

export default function App() {
  const [authed, setAuthed] = useState(null);
  const [tab, setTab] = useState("home");
  const [snap, setSnap] = useState(null);
  const [trades, setTrades] = useState([]);
  const [logs, setLogs] = useState([]);
  const [reports, setReports] = useState([]);
  const [backtest, setBacktest] = useState(null);
  const [optimize, setOptimize] = useState(null);
  const [optProgress, setOptProgress] = useState(null);
  const [lock, setLock] = useState(null);
  const [err, setErr] = useState("");
  const [toast, setToast] = useState("");
  const [closing, setClosing] = useState(false);
  const [loading, setLoading] = useState({
    regime: false,
    brief: false,
    levels: false,
    report: false,
    backtest: false,
  });
  const tickSecRef = useRef(5);
  const busyRef = useRef({});
  const autoRef = useRef({ brief: false, levels: false, optimize: false });

  const flash = (t) => {
    setToast(t);
    setTimeout(() => setToast(""), 2600);
  };

  const mergeSnap = useCallback((s) => {
    setSnap((prev) => ({
      ...s,
      levels: "levels" in s ? s.levels : prev?.levels,
      brief: "brief" in s ? s.brief : prev?.brief,
    }));
    if (s.trades) setTrades(s.trades);
    if (s.logs) setLogs(s.logs);
  }, []);

  // 時間のかかるAI処理は重複実行しない
  const runJob = useCallback(async (key, fn) => {
    if (busyRef.current[key]) return null;
    busyRef.current[key] = true;
    setLoading((l) => ({ ...l, [key]: true }));
    try {
      return await fn();
    } catch (e) {
      setErr(e.message);
      return null;
    } finally {
      busyRef.current[key] = false;
      setLoading((l) => ({ ...l, [key]: false }));
    }
  }, []);

  const runRegime = useCallback(
    (force) =>
      runJob("regime", async () => {
        const r = await api.post("/api/regime", { force });
        if (r.regime) setSnap((s) => (s ? { ...s, regime: r.regime, regimeStale: false } : s));
        if (r.error) setErr(`AI判定に失敗：${r.error}`);
      }),
    [runJob],
  );
  const runBrief = useCallback(
    (force) =>
      runJob("brief", async () => {
        const r = await api.post("/api/brief", { force });
        if (r.brief) setSnap((s) => (s ? { ...s, brief: r.brief, briefStale: false } : s));
      }),
    [runJob],
  );
  const runLevels = useCallback(
    (force) =>
      runJob("levels", async () => {
        const r = await api.post("/api/levels", { force });
        if (r.levels) setSnap((s) => (s ? { ...s, levels: r.levels, levelsStale: false } : s));
      }),
    [runJob],
  );

  // 銘柄ごとに順番に検証（1回のリクエストを短くしてタイムアウトを避ける）
  const runOptimize = useCallback(
    (apply) =>
      runJob("optimize", async () => {
        const { symbols } = await api.get("/api/optimize");
        for (let i = 0; i < symbols.length; i++) {
          setOptProgress({ i: i + 1, total: symbols.length, symbol: symbols[i] });
          try {
            await api.post("/api/optimize", { action: "symbol", symbol: symbols[i] });
          } catch (e) {
            setErr(`${symbols[i]}の検証に失敗：${e.message}`);
          }
        }
        setOptProgress(null);
        const r = await api.post("/api/optimize", { action: "finalize", apply });
        setOptimize(r.result);
        const c = await api.get("/api/config");
        setSnap((s) => (s ? { ...s, config: c.config, optimizeStale: false } : s));
      }),
    [runJob],
  );

  useEffect(() => {
    api
      .get("/api/login")
      .then((r) => setAuthed(r.authed))
      .catch(() => setAuthed(false));
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
          const s = await api.post(`/api/tick${n % 6 === 0 ? "?full=1" : ""}`);
          if (!alive) return;
          mergeSnap(s);
          setErr("");
          tickSecRef.current = s.config?.tickSec || 5;
          if (s.config?.running) {
            if (s.briefStale && !autoRef.current.brief) {
              autoRef.current.brief = true;
              runBrief(false);
            }
            if (s.levelsStale && !autoRef.current.levels) {
              autoRef.current.levels = true;
              runLevels(false);
            }
            if (s.optimizeStale && !s.position && !autoRef.current.optimize) {
              autoRef.current.optimize = true;
              runOptimize(true);
            }
            if (s.regimeStale) runRegime(false);
          }
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
    const onVis = () => document.visibilityState === "visible" && loop();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [authed, mergeSnap, runRegime, runBrief, runLevels, runOptimize]);

  useEffect(() => {
    if (!authed || tab !== "results") return;
    api
      .get("/api/report")
      .then((r) => setReports(r.reports || []))
      .catch(() => {});
    api
      .get("/api/backtest")
      .then((r) => setBacktest(r.result))
      .catch(() => {});
    api
      .get("/api/optimize")
      .then((r) => setOptimize(r.result))
      .catch(() => {});
    api
      .get("/api/config")
      .then((r) => setLock(r.lock))
      .catch(() => {});
  }, [authed, tab]);

  const toggleRunning = async () => {
    if (!snap) return;
    try {
      const out = await api.post("/api/config", { running: !snap.config.running });
      setSnap((s) => ({ ...s, config: out.config }));
      if (out.config.running) {
        flash("自動売買を開始しました");
        if (!snap.regime || snap.regimeStale) runRegime(false);
      } else flash("自動売買を停止しました");
    } catch (e) {
      setErr(e.message);
    }
  };

  const closeNow = async () => {
    if (!window.confirm("このポジションを今のレートで決済しますか？")) return;
    setClosing(true);
    try {
      await api.post("/api/close");
      mergeSnap(await api.post("/api/tick?full=1"));
      flash("決済しました");
    } catch (e) {
      setErr(e.message);
    } finally {
      setClosing(false);
    }
  };

  const onReport = (kind) =>
    runJob("report", async () => {
      const r = await api.post("/api/report", { kind });
      if (r.report) setReports((list) => [r.report, ...list.filter((x) => x.id !== r.report.id)]);
    });

  const onBacktest = (days, spreadPips) =>
    runJob("backtest", async () => {
      const r = await api.post("/api/backtest", { days, spreadPips: spreadPips || undefined });
      setBacktest(r.result);
    });

  const onAdopt = async (key, value) => {
    try {
      const out = await api.post("/api/config", { [key]: value });
      setSnap((s) => (s ? { ...s, config: out.config } : s));
      setLock(out.lock);
      flash("設定に反映しました");
    } catch (e) {
      setErr(e.message);
    }
  };

  const onUseCombo = async (symbol, params) => {
    try {
      const out = await api.post("/api/config", { ...params, symbol });
      setSnap((s) => (s ? { ...s, config: out.config } : s));
      flash(`${symbol.replace("_", "/")}と検証済みの設定に切り替えました`);
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

  const running = Boolean(snap?.config?.running);

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
          <span className="led" aria-hidden="true" />
          {running ? "稼働中" : "停止中"}
        </button>
      </header>

      {err && (
        <button type="button" className="notice as-btn" onClick={() => setErr("")}>
          {err}
        </button>
      )}

      <main className="content">
        <ErrorBoundary resetKey={tab}>
          {tab === "home" && (
            <Home snap={snap} onClose={closeNow} closing={closing} onGo={setTab} />
          )}
          {tab === "brain" && (
            <Brain
              snap={snap}
              loading={loading}
              onRegime={() => runRegime(true)}
              onBrief={() => runBrief(true)}
              onLevels={() => runLevels(true)}
            />
          )}
          {tab === "results" && (
            <Results
              snap={snap}
              trades={trades}
              logs={logs}
              reports={reports}
              backtest={backtest}
              optimize={optimize}
              optProgress={optProgress}
              onOptimize={() => runOptimize(snap?.config?.symbolMode === "auto")}
              onUseCombo={onUseCombo}
              loading={loading}
              lock={lock}
              onReport={onReport}
              onBacktest={onBacktest}
              onAdopt={onAdopt}
            />
          )}
          {tab === "settings" && (
            <SettingsPage
              hasPosition={Boolean(snap?.position)}
              onSaved={(c) => setSnap((s) => (s ? { ...s, config: c } : s))}
              onLogout={logout}
            />
          )}
        </ErrorBoundary>
        <p className="foot-note">
          画面を開いている間だけ動きます。閉じていた間の損切り・利確は、再開時に1分足で判定します。実際の注文は出ません。
        </p>
      </main>

      {toast && <div className="toast">{toast}</div>}

      <nav className="tabbar" aria-label="メニュー">
        {TABS.map(([k, label, d]) => (
          <button
            type="button"
            key={k}
            className={tab === k ? "on" : ""}
            onClick={() => setTab(k)}
            aria-current={tab === k}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={d} />
            </svg>
            <span>{label}</span>
            {k === "home" && snap?.position && <em className="dot" />}
          </button>
        ))}
      </nav>
    </div>
  );
}
