import { useEffect, useState } from "react";
import type { Fact, HeadFacts } from "@field-agent/core";
import { taskPath, write } from "./api.js";
import type { Action, TaskSnapshot } from "./types.js";
import { Badge, Button, fieldLabel, label, Section } from "./ui.js";

const fields = ["model", "installation", "mounting", "orientation", "verticalReference"] as const;
type Field = typeof fields[number];
const options: Partial<Record<Field, string[]>> = {
  installation: ["installed", "uninstalled"], mounting: ["standard", "recessed"],
  orientation: ["pendent", "upright", "sideways", "unknown"], verticalReference: ["gravity", "verified_record", "unknown"],
};

export function FactsEditor({ task, token, action, busy }: { task: TaskSnapshot; token: string; action: Action; busy: string }) {
  const [draft, setDraft] = useState<HeadFacts>(() => structuredClone(task.facts));
  const [baseRevision, setBaseRevision] = useState(task.revision);
  const [touched, setTouched] = useState<Field[]>([]);
  const dirty = touched.length > 0;
  const stale = dirty && baseRevision !== task.revision;
  const observations = task.observations.filter(o => o.targetId === task.targetId && !o.superseded);

  useEffect(() => {
    if (!dirty) { setDraft(structuredClone(task.facts)); setBaseRevision(task.revision); }
  }, [task.facts, task.revision, dirty]);

  function change(key: Field, patch: Partial<Fact>) {
    setDraft(old => ({ ...old, [key]: { ...old[key], ...patch, source: "manual" } }));
    setTouched(old => old.includes(key) ? old : [...old, key]);
  }
  function reset() { setDraft(structuredClone(task.facts)); setBaseRevision(task.revision); setTouched([]); }
  async function save() {
    const facts = Object.fromEntries(touched.map(key => [key, draft[key]]));
    await action("観測の確認を保存", () => write(token, taskPath(task.id, "/facts"), { baseRevision, facts }), () => setTouched([]));
  }

  return <Section eyebrow="OBSERVED FACTS" title="観測を確認・訂正" action={<Badge>{dirty ? "未保存の変更" : `版 ${task.revision}`}</Badge>}>
    <p className="section-intro">画像と上下の基準を確かめ、項目ごとに根拠を選んで確認します。AIが提案した値は、確認済みの観測とは分けて保存されます。</p>
    {stale && <div className="callout callout-warning" role="status">この下書きの後に仕事が更新されました。最新版を読み直してから確認してください。<Button className="button-small" onClick={reset}>下書きを破棄して読み直す</Button></div>}
    <div className="fact-table">
      <div className="fact-table-head"><span>確認項目</span><span>観測した内容</span><span>根拠の画像</span><span>人による確認</span></div>
      {fields.map(key => {
        const fact = draft[key];
        const canConfirm = fact.value !== null && fact.value !== "unknown" && fact.evidenceIds.length > 0;
        return <div className="fact-row" key={key}>
          <div className="fact-name"><strong>{label(key)}</strong><small>{task.facts[key].source === "fixture" ? "合成リプレイ" : task.facts[key].source === "model" ? "AIの候補" : "観測記録"}</small></div>
          {key === "model" ? <input aria-label={label(key)} value={fact.value ?? ""} placeholder="例：TY3231" disabled={!!busy || task.state === "cancelled"} onChange={event => change(key, { value: event.target.value || null, confirmed: false })} /> : <select aria-label={label(key)} value={fact.value ?? ""} disabled={!!busy || task.state === "cancelled"} onChange={event => change(key, { value: event.target.value || null, confirmed: false })}><option value="">未入力</option>{options[key]?.map(value => <option value={value} key={value}>{label(value)}</option>)}</select>}
          <details className="evidence-picker"><summary>{fact.evidenceIds.length ? `${fact.evidenceIds.length}件の画像を選択` : "根拠を選択"}<span aria-hidden="true">⌄</span></summary><div className="evidence-options">
            {observations.length ? observations.map((observation, index) => <label className="check-line" key={observation.id}><input type="checkbox" checked={fact.evidenceIds.includes(observation.id)} disabled={!!busy || task.state === "cancelled"} onChange={event => change(key, { confirmed: false, evidenceIds: event.target.checked ? [...fact.evidenceIds, observation.id] : fact.evidenceIds.filter(id => id !== observation.id) })} /><span>観測 {index + 1}<small>{observation.synthetic ? "合成" : "撮影"} · {observation.id}</small></span></label>) : <p className="muted">先に観測を追加してください。</p>}
          </div></details>
          <label className={`check-line confirm-check ${canConfirm ? "" : "disabled"}`}><input type="checkbox" checked={fact.confirmed && fact.source !== "model"} disabled={!!busy || !canConfirm || task.state === "cancelled"} onChange={event => change(key, { confirmed: event.target.checked })} /><span>根拠を見て確認</span></label>
        </div>;
      })}
    </div>
    <div className="form-footer"><p className="muted">画面の上側と重力方向は別です。上下を確認できなければ「不明」のまま残します。</p><div className="button-row"><Button disabled={!dirty || !!busy} onClick={reset}>変更を戻す</Button><Button className="button-primary" busy={busy === "観測の確認を保存"} disabled={!dirty || !!busy || stale || task.state === "cancelled"} onClick={() => void save()}>確認内容を保存</Button></div></div>
    {task.candidates.length > 0 && <details className="sub-details"><summary>AIの提案履歴 <span>{task.candidates.length}件</span></summary><div className="candidate-list">{[...task.candidates].reverse().map(candidate => <article key={candidate.id}><Badge tone="info">未確認の候補</Badge><p>{candidate.reason}</p><dl>{Object.entries(candidate.facts).map(([key, fact]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd>{label(fact.value)}</dd></div>)}</dl></article>)}</div></details>}
  </Section>;
}
