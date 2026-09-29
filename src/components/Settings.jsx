import { useState } from "react";
import { api } from "../api.js";
import { symbolLabel } from "../format.js";

const GROUPS = [
  {
    title: "取引",
    fields: [
      ["units", "取引数量（通貨）", 1000],
      ["maxTradesPerDay", "1日の最大取引回数", 1],
      ["dailyLossLimit", "1日の損失上限（円）", 500],
      ["cooldownSec", "決済後の待機（秒）", 10],
    ],
  },
  {
    title: "損切り・利確",
    fields: [
      ["slAtrMult", "損切り幅（ATRの倍率）", 0.1],
      ["slMinPips", "損切り幅の下限（pips）", 0.5],
      ["slMaxPips", "損切り幅の上限（pips）", 0.5],
      ["rr", "利確幅（損切り幅の倍率）", 0.1],
      ["timeStopMin", "最長保有時間（分）", 1],
    ],
  },
  {
    title: "フィルター",
    fields: [
      ["maxSpreadPips", "許容スプレッド（pips）", 0.1],
      ["minAtrPips", "最低ATR（pips）", 0.1],
      ["maxAtrPips", "最大ATR（pips）", 0.5],
      ["eventBufferMin", "指標前後の停止（分）", 5],
    ],
  },
  {
    title: "Claude・動作",
    fields: [
      ["regimeIntervalMin", "相場判定の間隔（分）", 5],
      ["tickSec", "価格チェック間隔（秒）", 1],
      ["feePerUnit", "API手数料（円/通貨・片道）", 0.001],
    ],
  },
];

export default function Settings({ config, symbols, hasPosition, onClose, onSaved }) {
  const [form, setForm] = useState({ ...config });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [resetText, setResetText] = useState("");

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    setMsg("");
    try {
      const out = await api.post("/api/config", form);
      onSaved(out.config);
      onClose();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setMsg("");
    try {
      await api.post("/api/reset", { confirm: resetText });
      setResetText("");
      setMsg("リセットしました");
    } catch (e) {
      setMsg(e.message);
    }
  };

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
        aria-label="設定"
      >
        <div className="sheet-head">
          <h2>設定</h2>
          <button type="button" className="ghost" onClick={onClose}>
            閉じる
          </button>
        </div>

        <label className="field">
          <span>銘柄</span>
          <select
            value={form.symbol}
            disabled={hasPosition}
            onChange={(e) => set("symbol", e.target.value)}
          >
            {symbols.map((s) => (
              <option key={s} value={s}>
                {symbolLabel(s)}
              </option>
            ))}
          </select>
        </label>
        {hasPosition && <p className="hint">ポジション保有中は銘柄を変更できません。</p>}

        {GROUPS.map((g) => (
          <fieldset key={g.title}>
            <legend>{g.title}</legend>
            {g.fields.map(([k, label, step]) => (
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
          </fieldset>
        ))}

        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(form.feeOn)}
            onChange={(e) => set("feeOn", e.target.checked)}
          />
          損益にAPI手数料を含める（往復分）
        </label>

        {msg && <p className="notice">{msg}</p>}
        <button type="button" className="primary" onClick={save} disabled={saving}>
          {saving ? "保存中…" : "設定を保存"}
        </button>

        <fieldset className="danger">
          <legend>ペーパー口座のリセット</legend>
          <p className="hint">
            取引履歴・損益・ポジションを消します。確認のため RESET と入力してください。
          </p>
          <div className="row">
            <input
              value={resetText}
              onChange={(e) => setResetText(e.target.value)}
              placeholder="RESET"
            />
            <button
              type="button"
              className="ghost"
              disabled={resetText !== "RESET"}
              onClick={reset}
            >
              リセット
            </button>
          </div>
        </fieldset>
      </section>
    </div>
  );
}
