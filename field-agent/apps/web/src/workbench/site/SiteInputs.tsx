import { useEffect, useState } from "react";
import { ASSUMPTION_PREFIX, localBoxToPlan, toMillimetres, SITE_FRAME_FIELD, siteFrameFor, type PackageInputs, type SiteFrame, type SiteYSide } from "@field-agent/core";
import type { Snapshot } from "../api.js";
import { lengthInput, lengthText, parseLength } from "../format.js";
import { BOX_KEYS, boxGaps, findFact, inScope, isConfirmed, isTestAssumption, readBox, siteFrameOf, upsertFacts, type Callouts, type Fact } from "../model.js";
import { MEASURED, patchClearing, type Act, type Unit } from "../inputs.js";
import { Badge, Button, Field } from "../ui.js";

interface Common { s: Snapshot; act: Act; busy: string; unit: Unit; setNotice: (t: string) => void }

/**
 * Site geometry for a discrepancy: a local frame pinned to one span, the obstacle and work boundary
 * as boxes in that frame, and the clearance and pipe OD the planner needs. Each value says whether it
 * was measured on site or is a fictional test assumption; confirming a value never changes which.
 */
type Basis = "measured" | "assumption";
const ASSUMED = `${ASSUMPTION_PREFIX} fictional software-test value, not a field observation`;
const sourceFor = (basis: Basis, note: string) => {
  const n = note.trim();
  return basis === "assumption" ? (n ? `${ASSUMED}. ${n}` : ASSUMED) : (n ? `${MEASURED}: ${n}` : MEASURED);
};
const basisOf = (f: Fact | undefined): Basis => isTestAssumption(f) ? "assumption" : "measured";
const noteOf = (f: Fact | undefined) => {
  const d = f?.source.description ?? "";
  if (d.startsWith(ASSUMED)) return d.slice(ASSUMED.length).replace(/^\.\s*/, "");
  if (d.startsWith(`${MEASURED}: `)) return d.slice(MEASURED.length + 2);
  return "";
};

function BasisPicker({ basis, onChange, name }: { basis: Basis; onChange: (b: Basis) => void; name: string }) {
  return <div className="fa-chips" role="radiogroup" aria-label="Basis">
    {([["measured", "Measured on site"], ["assumption", "Test assumption (fictional)"]] as const).map(([v, l]) =>
      <label key={v} className={`fa-chip ${basis === v ? "is-on" : ""}`}><input type="radio" name={name} checked={basis === v} onChange={() => onChange(v)} />{l}</label>)}
  </div>;
}

function statusBadge(facts: Array<Fact | undefined>) {
  const present = facts.filter(f => f && f.value !== null);
  if (!present.length) return <Badge tone="amber">Not entered</Badge>;
  const assumption = present.some(f => isTestAssumption(f));
  const all = present.length === facts.length && facts.every(isConfirmed);
  return <span className="fa-badges">
    {assumption && <Badge tone="sample" title="Fictional value for testing the software, not a field observation">Test assumption</Badge>}
    {all ? <Badge tone="green">{assumption ? "Confirmed for testing" : "Measured and confirmed"}</Badge>
      : present.length < facts.length ? <Badge tone="amber">Incomplete</Badge> : <Badge tone="amber">Entered, not confirmed</Badge>}
  </span>;
}

// ---------------------------------------------------------------- the local frame

const num = (v: number) => String(Math.round(Math.abs(v) * 1e4) / 1e4);
/** "12544.2133 − Y" from a constant and coefficients on X and Y. */
function affine(c: number, terms: Array<[number, string]>) {
  const parts: string[] = [];
  if (Math.abs(c) >= 5e-5) parts.push(`${c < 0 ? "−" : ""}${num(c)}`);
  for (const [k, name] of terms) {
    if (Math.abs(k) < 1e-9) continue;
    const mag = Math.abs(Math.abs(k) - 1) < 1e-9 ? name : `${num(k)}·${name}`;
    parts.push(parts.length ? `${k < 0 ? "−" : "+"} ${mag}` : `${k < 0 ? "−" : ""}${mag}`);
  }
  return parts.join(" ") || "0";
}
/** Plan and drawing coordinates of a local point, as formulas a reviewer can check by hand. */
export function frameFormulas(frame: SiteFrame, rotationDeg: number | null) {
  const plan = `Plan (mm) = (${affine(frame.origin.x, [[frame.x.x, "X"], [frame.y.x, "Y"]])}, ${affine(frame.origin.y, [[frame.x.y, "X"], [frame.y.y, "Y"]])}, ${affine(frame.origin.z, [[1, "Z"]])})`;
  if (rotationDeg === null) return { plan, drawing: null };
  // Plan = R(rotation)·(u, −v), where (u, v) are sheet millimetres from the frame origin with Y down the sheet.
  const r = rotationDeg * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  const toSheet = (p: { x: number; y: number }) => ({ u: cos * p.x + sin * p.y, v: -(-sin * p.x + cos * p.y) });
  const o = toSheet(frame.origin), ax = toSheet(frame.x), ay = toSheet(frame.y);
  const clean = (v: number) => Math.abs(v) < 1e-12 ? 0 : v;
  return { plan, drawing: `Drawing XY (mm from the sheet origin, Y down the sheet) = (${affine(clean(o.u), [[clean(ax.u), "X"], [clean(ay.u), "Y"]])}, ${affine(clean(o.v), [[clean(ax.v), "X"], [clean(ay.v), "Y"]])})` };
}

export function SiteFrameInputs({ s, act, busy, setNotice, callouts }: Common & { callouts: Callouts }) {
  const plan = s.baselinePlan;
  const pipes = plan?.entities.filter(e => e.kind === "pipe" && inScope(s)(e.id)) ?? [];
  const saved = siteFrameOf(s);
  const initial = () => ({ span: saved?.fact.subjectIds[0] ?? s.changeRequest?.affectedEntityIds[0] ?? pipes[0]?.id ?? "", side: (saved?.fact.value === "right" ? "right" : "left") as SiteYSide });
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial()), [saved?.fact.id, saved?.fact.value, s.changeRequest?.affectedEntityIds.join(",")]);
  if (!plan || !pipes.length) return <p className="fa-muted">Trace or enter the existing run first, then pin the frame to the span the obstacle blocks.</p>;

  const preview = draft.span ? siteFrameFor(plan, draft.span, draft.side) : { reason: "Choose a span" };
  const frame = "reason" in preview ? null : preview;
  const aligned = frame ? !("reason" in localBoxToPlan(frame, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 })) : false;
  const view = s.sourceDrawing?.view;
  const formulas = frame ? frameFormulas(frame, view && plan.coordinateFrame.id === "drawing-plan" ? view.frame.rotationDeg : null) : null;
  const label = (id: string) => { const l = findFact(s, "sourceLabel", id)?.value; return `Piece ${callouts.piece.get(id) ?? id}${typeof l === "string" && l ? ` (${l})` : ""}`; };
  const endLabel = (end: "start" | "end") => {
    const pipe = plan.entities.find(e => e.id === draft.span);
    const port = end === "start" ? pipe?.ports[0] : pipe?.ports.at(-1);
    const at = port?.position;
    const labels = at ? plan.entities.filter(e => e.id !== draft.span && e.ports.some(p => p.position && Math.hypot(p.position.x - at.x, p.position.y - at.y) < 1e-6))
      .map(e => findFact(s, "sourceLabel", e.id)?.value).filter((l): l is string => typeof l === "string" && !!l) : [];
    return labels[0] ?? `its ${end}`;
  };
  const changed = !saved || saved.fact.subjectIds[0] !== draft.span || saved.fact.value !== draft.side || !isConfirmed(saved.fact);

  const save = () => act("siteFrame", async cur => {
    const hadFrame = !!siteFrameOf(cur);
    const boxes = (f: Fact) => /^(duct|workEnvelope)\./.test(f.field);
    // The same numbers mean a different place in a new frame: keep them, but ask for them to be confirmed again.
    const reopen = (f: Fact): Fact => boxes(f) && f.confirmation === "confirmed" ? { ...f, confirmation: "proposed" } : f;
    const base = { detailing: cur.detailing.filter(f => f.field !== SITE_FRAME_FIELD), siteFacts: cur.siteFacts.filter(f => f.field !== SITE_FRAME_FIELD).map(reopen) };
    const facts = upsertFacts(base, [{ field: SITE_FRAME_FIELD, subjectIds: [draft.span], value: draft.side, confirmation: "confirmed", context: "observed", source: "Site frame chosen by you in Sprink" }]);
    const reopened = cur.siteFacts.some(f => boxes(f) && f.confirmation === "confirmed");
    const patch: Partial<PackageInputs> = { ...facts };
    await patchClearing(cur, patch, setNotice);
    if (reopened) setNotice(hadFrame ? "The site frame changed. The obstacle and work boundary keep their numbers but need confirming again in the new frame." : "Boxes are now read along the span. Check the obstacle and work boundary numbers and confirm them again.");
  });

  return <div className="fa-stack">
    <Field label="Span the frame is pinned to"><select value={draft.span} onChange={e => setDraft({ ...draft, span: e.target.value })}>
      {pipes.map(p => <option key={p.id} value={p.id}>{label(p.id)}</option>)}
    </select></Field>
    <div className="fa-chips" role="radiogroup" aria-label="Y side">
      {(["left", "right"] as const).map(side => <label key={side} className={`fa-chip ${draft.side === side ? "is-on" : ""}`}>
        <input type="radio" name="site-y-side" checked={draft.side === side} onChange={() => setDraft({ ...draft, side })} />Y to the {side} of the pipe
      </label>)}
    </div>
    {frame ? <div className="fa-frame-note">
      <p>X runs along the pipe from {endLabel("start")} (X = 0) to {endLabel("end")} (X = {lengthText({ value: frame.length, unit: "mm", basis: "confirmed_inputs" }).primary}). Y is level, to the {draft.side} of X looking down{draft.side === "right" ? ", so this frame is mirrored" : ""}. Z is up, 0 at the pipe centerline.</p>
      <p className="mono small">{formulas!.plan}</p>
      {formulas!.drawing && <p className="mono small">{formulas!.drawing}</p>}
      {!aligned && <p className="fa-warn small">This span is not parallel to a plan axis, so the planner cannot use a box along it. Use Pick X axis in Plan frame along this span first.</p>}
    </div> : <p className="fa-warn small">{(preview as { reason: string }).reason}</p>}
    <div className="fa-fact-head"><span className="fa-muted small">A frame choice, not a measurement.</span>{saved ? isConfirmed(saved.fact) && saved.frame ? <Badge tone="green">Saved</Badge> : <Badge tone="amber">{saved.reason ?? "Not saved"}</Badge> : <Badge tone="neutral">Plan frame</Badge>}</div>
    <div className="fa-actions"><Button variant="primary" busy={busy === "siteFrame"} disabled={!!busy || !frame || !changed} onClick={() => void save()}>{saved ? "Save frame" : "Enter boxes along this span"}</Button></div>
  </div>;
}

// ---------------------------------------------------------------- boxes

const AXES = ["X", "Y", "Z"] as const;
/** Millimetres are shown to 0.0001 mm so a saved value such as 3197.6613 survives a re-save. */
const show = (mm: number | null, unit: Unit) => mm === null ? "" : unit === "mm" ? String(Math.round(mm * 1e4) / 1e4) : lengthInput(mm, unit);
/** An untouched field keeps its exact saved value rather than the rounded text shown for it. */
const keep = (text: string, saved: number | null, unit: Unit) => saved !== null && text === show(saved, unit) ? saved : text.trim() ? parseLength(text, unit) : null;
const unitHint = (unit: Unit) => unit === "mm" ? "Millimetres. Type 4' 2\" for feet and inches." : "Feet and inches; a bare number is inches. Type 1200 mm for millimetres.";

export function SiteBoxInputs({ s, act, busy, unit, setNotice, prefix, title, help }: Common & { prefix: "duct" | "workEnvelope"; title: string; help: string }) {
  const site = siteFrameOf(s);
  const local = !!site;
  const box = readBox(s, prefix);
  const facts = BOX_KEYS.map(k => findFact(s, `${prefix}.${k}`));
  const first = facts.find(f => f?.value !== null && f?.value !== undefined);
  const photos = s.siteFacts.filter(f => f.field.startsWith("evidence.photo") && f.source.assetId);
  const [vals, setVals] = useState(() => box.values.map(v => show(v, unit)));
  const [basis, setBasis] = useState<Basis>(() => basisOf(first));
  const [note, setNote] = useState(() => noteOf(first));
  const [photo, setPhoto] = useState(() => first?.source.assetId ?? "");
  const savedKey = facts.map(f => `${f?.id}:${f?.value}:${f?.confirmation}:${f?.source.description}`).join("|");
  useEffect(() => { setVals(box.values.map(v => show(v, unit))); setBasis(basisOf(first)); setNote(noteOf(first)); setPhoto(first?.source.assetId ?? ""); }, [savedKey, unit]);

  const parsed = vals.map((v, i) => keep(v, box.values[i], unit));
  const invalid = vals.some((v, i) => v.trim() && parsed[i] === null);
  const order = AXES.map((_, i) => parsed[i] !== null && parsed[i + 3] !== null && parsed[i]! >= parsed[i + 3]!);
  const complete = parsed.every(v => v !== null);
  const sample = facts.some(f => f?.source.description.startsWith("SAMPLE"));
  const side = site?.fact.value === "right" ? "right" : "left";
  const axisLabel = local
    ? ["Along the pipe (X)", `Across, + to the ${side} (Y)`, "Up from the pipe centerline (Z)"]
    : ["East (plan X)", "North (plan Y)", "Up (plan Z)"];

  const save = (confirm: boolean) => act(`${prefix}.${confirm ? "confirm" : "save"}`, async cur => {
    const facts = upsertFacts(cur, BOX_KEYS.map((k, i) => ({
      field: `${prefix}.${k}`, value: parsed[i], unit: "mm", confirmation: confirm ? "confirmed" : "proposed", context: "observed",
      source: sourceFor(basis, note), assetId: photo || null, unknownReason: `${axisLabel[i % 3]} ${i < 3 ? "low" : "high"} face not measured yet`,
    })));
    const patch: Partial<PackageInputs> = { ...facts };
    if (prefix === "duct" && cur.changeRequest) patch.changeRequest = { ...cur.changeRequest, factIds: facts.siteFacts.filter(f => f.field.startsWith("duct.")).map(f => f.id) };
    await patchClearing(cur, patch, setNotice);
  });
  const gaps = box.values.some(v => v !== null) ? boxGaps(s, prefix, local) : [];

  return <div className="fa-stack">
    <div className="fa-fact-head"><span className="fa-muted">{help}</span>{sample ? <Badge tone="sample">Sample</Badge> : statusBadge(facts)}</div>
    <div className="fa-boxgrid">
      <span /><span className="fa-muted small">From</span><span className="fa-muted small">To</span>
      {AXES.map((a, i) => [
        <span key={`${a}l`} className="small">{axisLabel[i]}</span>,
        ...[i, i + 3].map(j => <input key={j} aria-label={`${title} ${axisLabel[i]} ${j < 3 ? "from" : "to"}`} className={`mono ${(vals[j].trim() && parsed[j] === null) || order[i] ? "is-invalid" : ""}`} value={vals[j]} placeholder="Unknown"
          onChange={e => setVals(vals.map((v, k) => k === j ? e.target.value : v))} />),
      ])}
    </div>
    <small className="fa-muted">{unitHint(unit)}</small>
    {order.some(Boolean) && <small className="fa-warn">Each "From" must be less than its "To".</small>}
    {!complete && <small className="fa-warn">Empty faces are saved as unknown, not zero.{parsed[2] === null || parsed[5] === null ? " Without the height (Z), no route can be generated around it." : ""}</small>}
    <BasisPicker basis={basis} onChange={setBasis} name={`${prefix}-basis`} />
    <div className="fa-row2">
      <Field label={basis === "assumption" ? "Why this value (optional)" : "How it was measured (optional)"}><input value={note} onChange={e => setNote(e.target.value)} placeholder={basis === "assumption" ? "e.g. FS-01 acceptance v1" : "e.g. Tape from the pipe centerline"} /></Field>
      <Field label="Evidence photo"><select value={photo} onChange={e => setPhoto(e.target.value)}>
        <option value="">None</option>{photos.map(p => <option key={p.id} value={p.source.assetId!}>{p.source.description.slice(0, 60)}</option>)}
      </select></Field>
    </div>
    {photo && <small className="fa-muted">The photo is linked as evidence. The numbers come from what you typed, never from the photo.</small>}
    {gaps.length > 0 && <ul className="fa-gaps">{gaps.map(g => <li key={g}>{g}</li>)}</ul>}
    <div className="fa-actions">
      <Button busy={busy === `${prefix}.save`} disabled={!!busy || invalid} onClick={() => void save(false)}>Save</Button>
      <Button variant="primary" busy={busy === `${prefix}.confirm`} disabled={!!busy || invalid || !complete || order.some(Boolean) || (local && !site?.frame)} onClick={() => void save(true)}>{basis === "assumption" ? "Confirm test values" : "Confirm measurement"}</Button>
    </div>
  </div>;
}

// ---------------------------------------------------------------- single lengths

export function SiteLengthInput({ s, act, busy, unit, setNotice, field, subject, label, tag, help }: Common & { field: string; subject?: string; label: string; tag?: string; help: string }) {
  const f = findFact(s, field, subject);
  const savedMm = typeof f?.value === "number" ? toMillimetres(f.value, f.unit ?? "mm") : null;
  const shown = show(savedMm, unit);
  const [value, setValue] = useState(shown);
  const [basis, setBasis] = useState<Basis>(() => basisOf(f));
  const [note, setNote] = useState(() => noteOf(f));
  useEffect(() => { setValue(shown); setBasis(basisOf(f)); setNote(noteOf(f)); }, [f?.id, f?.value, f?.source.description, unit]);
  const parsed = keep(value, savedMm, unit);
  const save = (confirm: boolean) => act(`${field}.${confirm}`, cur => patchClearing(cur, upsertFacts(cur, [{
    field, subjectIds: subject ? [subject] : [], value: parsed, unit: "mm", confirmation: confirm ? "confirmed" : "proposed", context: "observed", source: sourceFor(basis, note),
  }]), setNotice));
  return <div className="fa-fact">
    <div className="fa-fact-head"><span>{label}{tag && <> <Badge tone="neutral">{tag}</Badge></>}</span>{statusBadge([f])}</div>
    <div className="fa-row2">
      <input className={`mono ${value.trim() && parsed === null ? "is-invalid" : ""}`} value={value} onChange={e => setValue(e.target.value)} aria-label={label} placeholder={unit === "mm" ? "mm" : "ft-in"} />
      <input value={note} onChange={e => setNote(e.target.value)} aria-label={`${label} note`} placeholder="Note (optional)" />
    </div>
    <BasisPicker basis={basis} onChange={setBasis} name={`${field}-${subject ?? ""}-basis`} />
    <small className="fa-muted">{help} {unitHint(unit)}</small>
    <div className="fa-actions">
      <Button busy={busy === `${field}.false`} disabled={!!busy || (!!value.trim() && parsed === null)} onClick={() => void save(false)}>Save</Button>
      <Button variant="primary" busy={busy === `${field}.true`} disabled={!!busy || parsed === null || parsed <= 0} onClick={() => void save(true)}>Confirm</Button>
    </div>
  </div>;
}
