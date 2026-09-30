// 「脳みそ」の一覧：相場の方針（上昇・下降・レンジ・見送り）を決める部分を差し替えられるようにする
// 売買のタイミング・損切り・利確・安全装置は、どの脳でも同じルールエンジンが担当する

export const MODELS = {
  haiku: { id: "claude-haiku-4-5-20251001", label: "Haiku", note: "安い・速い" },
  sonnet: { id: "claude-sonnet-5-5", label: "Sonnet", note: "標準" },
  opus: { id: "claude-opus-5-5", label: "Opus", note: "賢いが高い（Sonnetの数倍）" },
};

const COMMON_RULES = `共通の判定ルール:
- 銘柄ごとに mode（TREND_UP / TREND_DOWN / RANGE / NO_TRADE）と allow（LONG / SHORT / BOTH / NONE）と confidence（0〜100）を決める。
- 迷ったら NO_TRADE。確信度は正直に付ける。発注・損切り・利確はプログラムが行う。
- 重要指標の発表前30分〜発表後15分、急変の直後は NO_TRADE。`;

export const BRAINS = [
  {
    id: "rules_ma",
    name: "移動平均ルール",
    kind: "rules",
    tag: "ルール",
    summary: "1時間足の移動平均だけで方向を決める、いちばん単純な脳。過去データで検証済み。",
    thinks: [
      "1時間足のEMA20がEMA50より上で、価格もEMA20より上なら「上昇」→買いだけ",
      "EMA20がEMA50より下で、価格もEMA20より下なら「下降」→売りだけ",
      "どちらでもなければ「レンジ」→両方向の逆張りを許可",
      "ニュースや指標は見ない（その分、無料で速い）",
    ],
    data: ["1時間足（直近4日分）"],
    cost: "無料",
    backtest: true,
  },
  {
    id: "rules_kuroyuki",
    name: "クロユキ式ルール",
    kind: "rules",
    tag: "ルール",
    summary: "書籍『極スキャルピングFX』の考え方をルール化した脳（準備中）。",
    thinks: ["本の内容を受け取ってから作成します"],
    data: ["準備中"],
    cost: "無料",
    backtest: true,
    disabled: true,
  },
  {
    id: "ai_committee",
    name: "AIチーム（議長＋反論役）",
    kind: "ai",
    tag: "AI・合議",
    summary:
      "ファンダ担当の朝のブリーフを踏まえて議長が方針を決め、反論役がそれを突く。いちばん慎重で、いちばん高い。",
    thinks: [
      "議長：週足・日足の位置 → 1時間足の流れ → 5分足の形の順に見て、ニュースと合わせて方針を決める",
      "反論役：議長の弱点・見落とし・楽観を指摘し、同意／弱め／却下を出す",
      "確信度45%未満は見送り",
    ],
    data: [
      "1時間足・5分足",
      "水平線マップ",
      "朝のブリーフ（指標・事実確認済みニュース）",
      "web検索（最大2〜4回）",
    ],
    cost: "1回の判定でClaudeを2回呼ぶ＋検索",
    defaultModel: "sonnet",
    searches: 2,
    system: "（議長と反論役の2段構成。regime.js の CHAIR_SYSTEM / CRITIC_SYSTEM を使用）",
  },
  {
    id: "ai_technical",
    name: "テクニカル型",
    kind: "ai",
    tag: "AI",
    summary: "チャートの形と水平線だけで判断する。ニュースは見ない。",
    thinks: [
      "高値・安値の切り上げ／切り下げで流れを判断する",
      "水平線（前の高値・安値）の近くでは、その方向に追いかけない",
      "ニュースや指標は見ない（検索しない分、安い）",
    ],
    data: ["1時間足・5分足", "水平線マップ"],
    cost: "1回の判定でClaudeを1回",
    defaultModel: "sonnet",
    searches: 0,
    system: `あなたは自動売買システムの「テクニカル型」の脳です。チャートの形と価格帯だけで相場の方針を決めます。ニュースやファンダメンタルは考慮しません。
考え方:
- 高値と安値がともに切り上がっていれば上昇、切り下がっていれば下降、どちらでもなければレンジ。
- 週足・日足の水平線の直前では、その水平線に向かう方向の取引を避ける。
- 5分足で急な長いヒゲや大陽線・大陰線が出た直後は様子見。
- 1時間足と5分足の向きが食い違うときは確信度を下げる。
${COMMON_RULES}`,
  },
  {
    id: "ai_trend",
    name: "トレンドフォロー型",
    kind: "ai",
    tag: "AI",
    summary: "流れに乗ることを最優先。逆張りはしない。",
    thinks: [
      "はっきりした上昇・下降のときだけ取引する",
      "レンジは原則見送り（RANGEは使わない）",
      "流れが弱まった兆し（高値更新の失敗など）が出たら見送り",
    ],
    data: ["1時間足・5分足", "水平線マップ"],
    cost: "1回の判定でClaudeを1回",
    defaultModel: "sonnet",
    searches: 0,
    system: `あなたは自動売買システムの「トレンドフォロー型」の脳です。はっきりした流れに乗ることだけを考えます。
考え方:
- 1時間足で高値・安値が同じ向きに更新され、移動平均も同じ向きなら TREND_UP / TREND_DOWN。
- 往来相場（レンジ）は取引しない。RANGE は使わず NO_TRADE にする。
- 高値更新（安値更新）に失敗した、または急に逆行した場合は流れが弱まったとみて NO_TRADE。
- 流れの終盤（大きく伸びた後、水平線の直前）は確信度を下げる。
${COMMON_RULES}`,
  },
  {
    id: "ai_range",
    name: "レンジ型",
    kind: "ai",
    tag: "AI",
    summary: "節目での反発を狙う逆張り寄り。強いトレンドのときは休む。",
    thinks: [
      "直近の高値・安値の間で往来しているときに、端での反発を狙う",
      "強いトレンドが出ているときは見送り",
      "上限に近ければ売りだけ、下限に近ければ買いだけを許可",
    ],
    data: ["1時間足・5分足", "水平線マップ"],
    cost: "1回の判定でClaudeを1回",
    defaultModel: "sonnet",
    searches: 0,
    system: `あなたは自動売買システムの「レンジ型」の脳です。一定の幅で往来している相場で、端での反発を狙います。
考え方:
- 直近1〜2日の高値・安値の間で価格が行き来しているなら RANGE。
- 価格がレンジの上側にあれば allow=SHORT、下側にあれば allow=LONG、中央なら BOTH。
- 1時間足で高値・安値が同じ向きに更新され続けている（強いトレンド）なら NO_TRADE。
- レンジの端を大きく抜けた直後は、ダマシか本物か分からないので NO_TRADE。
${COMMON_RULES}`,
  },
  {
    id: "ai_fundamental",
    name: "ファンダ重視型",
    kind: "ai",
    tag: "AI・ニュース",
    summary: "指標・金利・ニュースで方向を決め、チャートはタイミングだけに使う。",
    thinks: [
      "web検索で直近のニュース・金利見通し・指標結果を確認する",
      "材料がはっきり同じ向きを示すときだけ、その方向を許可する",
      "材料が割れている、または重要指標が近いときは見送り",
    ],
    data: ["朝のブリーフ", "web検索（最大3回）", "1時間足・5分足"],
    cost: "1回の判定でClaudeを1回＋検索",
    defaultModel: "sonnet",
    searches: 3,
    system: `あなたは自動売買システムの「ファンダ重視型」の脳です。経済指標・金利見通し・要人発言・ニュースで方向を決め、チャートは今が入り時かどうかの確認にだけ使います。
考え方:
- 通貨の金利差の方向、直近の指標結果（予想比）、中銀・要人の発言の向きを確認する。暗号資産はETFの資金流出入・規制・大口の動きも確認する。
- 材料がそろって同じ向きなら、その方向だけを allow する（上昇材料なら LONG）。
- 材料が割れている、噂レベルしかない、重要指標が近い場合は NO_TRADE。
- チャートが材料と逆向きに強く動いているときは確信度を下げる。
${COMMON_RULES}`,
  },
  {
    id: "ai_careful",
    name: "慎重型",
    kind: "ai",
    tag: "AI・守り",
    summary: "条件がそろったときだけ入る。見送りが多い守りの脳。",
    thinks: [
      "上位足と下位足の向き、水平線までの余裕、時間帯がすべて良いときだけ許可",
      "少しでも迷う要素があれば見送り",
      "確信度70%未満は出さない",
    ],
    data: ["1時間足・5分足", "水平線マップ", "朝のブリーフ"],
    cost: "1回の判定でClaudeを1回",
    defaultModel: "sonnet",
    searches: 0,
    system: `あなたは自動売買システムの「慎重型」の脳です。負けを減らすことを最優先し、条件がすべてそろったときだけ取引を許可します。
考え方:
- 1時間足と5分足の向きが一致している、利確方向に強い水平線がない、重要指標が近くない、時間帯の流動性が十分、のすべてを満たすときだけ取引を許可する。
- 1つでも欠ければ NO_TRADE。
- 許可するときも確信度は70以上の場合のみ。70未満になりそうなら NO_TRADE。
${COMMON_RULES}`,
  },
  {
    id: "ai_kuroyuki",
    name: "クロユキ型AI",
    kind: "ai",
    tag: "AI",
    summary: "書籍の考え方をAIに持たせた脳（準備中）。",
    thinks: ["本の内容を受け取ってから作成します"],
    data: ["準備中"],
    cost: "1回の判定でClaudeを1回",
    defaultModel: "sonnet",
    searches: 0,
    disabled: true,
    system: "",
  },
];

export const BRAIN_IDS = BRAINS.map((b) => b.id);
export const getBrain = (id) => BRAINS.find((b) => b.id === id) || null;

export function modelOf(cfg, id) {
  const b = getBrain(id);
  const key = cfg.brainModels?.[id] || b?.defaultModel || "sonnet";
  return { key, ...(MODELS[key] || MODELS.sonnet) };
}

// 旧設定（aiMode）からの移行も含めて、使用中の脳を決める
export function activeBrainOf(cfg) {
  const id = cfg.activeBrain || (cfg.aiMode === "claude" ? "ai_committee" : "rules_ma");
  const b = getBrain(id);
  return b && !b.disabled ? b : getBrain("rules_ma");
}

export function shadowBrainsOf(cfg) {
  const active = activeBrainOf(cfg).id;
  return (Array.isArray(cfg.shadowBrains) ? cfg.shadowBrains : [])
    .map(getBrain)
    .filter((b) => b && !b.disabled && b.id !== active)
    .slice(0, 3);
}
