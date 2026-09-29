import { useEffect, useState } from "react";
import { api } from "../api.js";
import { symbolLabel } from "../format.js";
import { Card, Toggle } from "./ui.jsx";

const NUM_GROUPS = [
  {
    title: "資金と数量",
    fields: [
      ["paperBalance", "仮想の口座資金（円）", 10000],
      ["units", "固定の取引数量（通貨）", 1000, "fixed"],
      ["riskPct", "1回で失ってよい資金の割合（%）", 0.1, "risk"],
      ["maxUnits", "数量の上限（通貨）", 10000, "risk"],
    ],
  },
  {
    title: "負けを小さくする",
    fields: [
      ["dailyLossLimit", "1日の損失上限（円）", 500],
      ["maxTradesPerDay", "1日の最大取引回数", 1],
      ["lossStreakMax", "何連敗で休むか", 1],
      ["lossStreakPauseMin", "連敗後に休む時間（分）", 10],
      ["cooldownSec", "決済後の待機（秒）", 10],
    ],
  },
  {
    title: "損切り・利確",
    fields: [
      ["slAtrMult", "損切り幅（値動きの何倍）", 0.1],
      ["slMinPips", "損切り幅の下限（pips）", 0.5],
      ["slMaxPips", "損切り幅の上限（pips）", 0.5],
      ["rr", "利確幅（損切り幅の何倍）", 0.1],
      ["minRr", "許容する利確倍率の下限", 0.1],
      ["beTriggerR", "建値ストップの発動（損切り幅の何倍の含み益）", 0.1],
      ["timeStopMin", "最長保有時間（分）", 1],
    ],
  },
  {
    title: "やらない場面",
    fields: [
      ["maxSpreadPips", "許容スプレッド（pips）", 0.1],
      ["minAtrPips", "値動きがこれ未満なら休む（pips）", 0.1],
      ["maxAtrPips", "値動きがこれ超なら休む（pips）", 0.5],
      ["eventBufferMin", "重要指標の前後に休む時間（分）", 5],
    ],
  },
  {
    title: "AIと動作",
    fields: [
      ["regimeIntervalMin", "AIが方針を見直す間隔（分）", 5],
      ["tickSec", "価格チェックの間隔（秒）", 1],
      ["feePerUnit", "API手数料（円/通貨・片道）", 0.001],
    ],
  },
];

export default function SettingsPage({ hasPosition, onSaved, onLogout }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [resetText, setResetText] = useState("");

  useEffect(() => {
    api
      .get("/api/config")
      .then((d) => {
        setData(d);
        setForm({ ...d.config, sessions: { ...d.config.sessions } });
      })
      .catch((e) => setMsg(e.message));
  }, []);

  if (!form) return <p className="hint">{msg || "読み込み中…"}</p>;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setSes = (k, v) => setForm((f) => ({ ...f, sessions: { ...f.sessions, [k]: v } }));

  const save = async () => {
    setSaving(true);
    setMsg("");
    try {
      const out = await api.post("/api/config", form);
      setData(out);
      setForm({ ...out.config, sessions: { ...out.config.sessions } });
      onSaved(out.config);
      setMsg("保存しました");
    } catch (e) {
      setMsg(e.message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    try {
      await api.post("/api/reset", { confirm: resetText });
      setResetText("");
      setMsg("ペーパー口座をリセットしました");
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <div className="settings">
      {data?.lock?.locked && (
        <p className="notice soft">
          {data.lock.why}、リスクを増やす変更はロック中です。減らす変更はいつでもできます。
        </p>
      )}

      <Card title="銘柄">
        <select
          value={form.symbol}
          disabled={hasPosition}
          onChange={(e) => set("symbol", e.target.value)}
        >
          {data.symbols.map((s) => (
            <option key={s} value={s}>
              {symbolLabel(s)}
            </option>
          ))}
        </select>
        {hasPosition && <p className="hint">ポジション保有中は変更できません。</p>}
      </Card>

      <Card title="取引する時間帯">
        <Toggle
          label="東京"
          hint="9:00〜15:00"
          checked={form.sessions.tokyo}
          onChange={(v) => setSes("tokyo", v)}
        />
        <Toggle
          label="ロンドン"
          hint="16:00〜21:00"
          checked={form.sessions.london}
          onChange={(v) => setSes("london", v)}
        />
        <Toggle
          label="ニューヨーク"
          hint="21:00〜翌2:00"
          checked={form.sessions.ny}
          onChange={(v) => setSes("ny", v)}
        />
        <p className="hint">
          早朝（2:00〜9:00）と15:00〜16:00は、スプレッドが広がりやすいので常に取引しません。
        </p>
      </Card>

      <Card title="安全装置">
        <Toggle
          label="5分足フィルター"
          hint="大きな流れと同じ向きのときだけ入る"
          checked={form.htfFilter}
          onChange={(v) => set("htfFilter", v)}
        />
        <Toggle
          label="建値ストップ"
          hint="含み益が出たら損切りを買値へ移す"
          checked={form.beOn}
          onChange={(v) => set("beOn", v)}
        />
        <Toggle
          label="水平線フィルター"
          hint="利確までの間に強い線があれば見送る"
          checked={form.levelFilter}
          onChange={(v) => set("levelFilter", v)}
        />
        <Toggle
          label="手数料を損益に含める"
          checked={form.feeOn}
          onChange={(v) => set("feeOn", v)}
        />
      </Card>

      <Card title="数量の決め方">
        <div className="seg">
          <button
            type="button"
            aria-selected={form.sizingMode === "fixed"}
            onClick={() => set("sizingMode", "fixed")}
          >
            固定の数量
          </button>
          <button
            type="button"
            aria-selected={form.sizingMode === "risk"}
            onClick={() => set("sizingMode", "risk")}
          >
            資金の%で自動
          </button>
        </div>
        <p className="hint">
          {form.sizingMode === "risk"
            ? "損切りになったときの損失が、資金の指定%に収まるように数量を自動で決めます。"
            : "毎回同じ数量で取引します。"}
        </p>
      </Card>

      {NUM_GROUPS.map((g) => (
        <Card key={g.title} title={g.title}>
          {g.fields
            .filter(([, , , mode]) => !mode || mode === form.sizingMode)
            .map(([k, label, step]) => (
              <label className="field" key={k}>
                <span>{label}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step={step}
                  value={form[k]}
                  onChange={(e) => set(k, e.target.value)}
                />
              </label>
            ))}
        </Card>
      ))}

      {msg && <p className="notice soft">{msg}</p>}
      <div className="save-bar">
        <button type="button" className="primary" onClick={save} disabled={saving}>
          {saving ? "保存中…" : "設定を保存"}
        </button>
      </div>

      <Card title="ペーパー口座のリセット" className="danger">
        <p className="hint">
          取引履歴・損益・ポジションを消します。確認のため RESET と入力してください。
        </p>
        <div className="row">
          <input
            value={resetText}
            onChange={(e) => setResetText(e.target.value)}
            placeholder="RESET"
          />
          <button type="button" className="ghost" disabled={resetText !== "RESET"} onClick={reset}>
            リセット
          </button>
        </div>
      </Card>

      <button type="button" className="ghost wide" onClick={onLogout}>
        ログアウト
      </button>
    </div>
  );
}
