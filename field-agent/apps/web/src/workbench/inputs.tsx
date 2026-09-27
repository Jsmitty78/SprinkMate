import { useEffect, useMemo, useState } from "react";
import type { PackageInputs } from "@field-agent/core";
import { api, type Snapshot } from "./api.js";
import { lengthInput, lengthText, parseLength, toMetres } from "./format.js";
import {
  showCpvcInputs, showSfInputs, activeDetailingPlan, BOX_KEYS, buildRun, ELBOW, inScope, PIPE, runEditPatch, findFact, isConfirmed, projectBasis, readBox, runChanged, runNodes, upsertFacts,
  syncRunDraft, type Callouts, type Fact, type FactSpec, type RunNode, type RunNodeKind,
} from "./model.js";
import { Badge, Button, Callout, Field, Icon, Section } from "./ui.js";

export type Act = (label: string, fn: (s: Snapshot) => Promise<unknown>) => Promise<boolean>;
export type Unit = "mm" | "in";
interface Common { s: Snapshot; act: Act; busy: string; unit: Unit; setNotice: (t: string) => void }

export const BY_YOU = "Confirmed by you in Sprink";
export const MEASURED = "Measured on site by you";

/**
 * Edit inputs. When a route is selected, the server keeps the selection even if site facts change,
 * so the UI clears it first (select the baseline) and says so.
 */
export async function patchClearing(s: Snapshot, patch: Partial<PackageInputs>, setNotice: (t: string) => void): Promise<void> {
  let revision = s.inputRevision;
  const baselineId = s.baselinePlan?.id;
  if (s.selectedPlan && baselineId && s.selectedPlan.id !== baselineId) {
    const cleared = await api.select(s.id, revision, baselineId);
    revision = cleared.inputRevision;
    setNotice("Your route selection was cleared because the inputs changed. Regenerate and choose again.");
  }
  await api.edit(s.id, revision, patch);
}

export function factStatus(f: Fact | undefined) {
  if (!f || f.value === null) return <Badge tone="amber">Missing</Badge>;
  if (f.source.description.startsWith("SAMPLE")) return <Badge tone="sample">Sample</Badge>;
  if (f.confirmation === "confirmed") return <Badge tone="green">{f.context === "observed" ? "Measured by you" : "Confirmed"}</Badge>;
  return <Badge tone="amber">Proposed</Badge>;
}

// ---------------------------------------------------------------- drawing

const safeId = (text: string) => (text.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "") || "drawing").slice(0, 100);

export function DrawingInputs({ s, act, busy, setNotice }: Common) {
  const d = s.sourceDrawing;
  // The server freezes the drawing with a confirmed run, as well as once it is approved.
  const runConfirmed = s.baselinePlan?.confirmation === "confirmed";
  const frozen = d?.approval === "approved" || runConfirmed;
  const [rev, setRev] = useState(d?.revision ?? "A");
  const [page, setPage] = useState(String(d?.page ?? 1));
  const [scale, setScale] = useState(d?.scale.value !== null && d?.scale.value !== undefined ? String(d.scale.value) : "");
  // The server accepts only mm/pixel (apps/server/src/work-packages/validation.ts).
  const scaleUnit = "mm/pixel";
  useEffect(() => { setRev(d?.revision ?? "A"); setPage(String(d?.page ?? 1)); setScale(d?.scale.value != null ? String(d.scale.value) : ""); }, [d?.assetId, d?.revision, d?.page, d?.scale.value]);

  const upload = (file: File) => act("upload", async cur => {
    pageNumber(page);
    const asset = await api.upload(cur.id, file);
    await patchClearing(cur, {
      sourceDrawing: {
        assetId: asset.id, drawingId: safeId(file.name), revision: rev.trim() || "A", page: pageNumber(page), approval: "unreviewed",
        scale: { value: null, unit: scaleUnit, reason: "Scale not confirmed yet", basis: "unknown" },
      },
    }, setNotice);
  });
  const saveScale = (confirm: boolean) => act(confirm ? "scale" : "scale-save", async cur => {
    if (!cur.sourceDrawing) return;
    const value = Number(scale);
    const known = scale.trim() !== "" && Number.isFinite(value) && value > 0;
    await patchClearing(cur, {
      sourceDrawing: {
        ...cur.sourceDrawing, revision: rev.trim() || cur.sourceDrawing.revision, page: pageNumber(page),
        scale: known ? { value, unit: scaleUnit, reason: null, basis: confirm ? "confirmed_inputs" : "proposed_inputs" } : { value: null, unit: scaleUnit, reason: "Scale not confirmed yet", basis: "unknown" },
      },
    }, setNotice);
  });

  if (!d && runConfirmed) return <p className="fa-muted">The run was confirmed without a drawing, so this package cannot take one now. Start a new package to attach the sheet.</p>;

  if (!d) return <div className="fa-stack">
    <p className="fa-muted">Upload the approved sheet for this work (PDF, PNG or JPEG, up to 20 MB). It stays linked to every result.</p>
    <div className="fa-row2">
      <Field label="Revision"><input value={rev} onChange={e => setRev(e.target.value)} maxLength={40} /></Field>
      <Field label="Page"><input value={page} inputMode="numeric" aria-invalid={!pageOk(page)} className={pageOk(page) ? undefined : "is-invalid"} onChange={e => setPage(e.target.value)} /></Field>
    </div>
    <label className={`fa-drop ${busy === "upload" ? "is-busy" : ""}`}>
      <Icon name="upload" /><span>{busy === "upload" ? "Uploading…" : "Choose drawing file"}</span>
      <input type="file" accept="application/pdf,image/png,image/jpeg" disabled={!!busy} onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
    </label>
  </div>;

  return <div className="fa-stack">
    <div className="fa-kv">
      <span>Sheet</span><strong className="mono">{d.drawingId}</strong>
      <span>Revision</span><strong>{d.revision} · page {d.page}</strong>
      <span>Approval</span><strong>{d.approval === "approved" ? <Badge tone="green">Approved drawing</Badge> : d.approval === "superseded" ? <Badge tone="red">Superseded</Badge> : <Badge>Not reviewed</Badge>}</strong>
      <span>Scale</span><strong>{d.scale.basis === "confirmed_inputs" ? <>{d.scale.value} {d.scale.unit} <Badge tone="green">Confirmed</Badge></> : d.scale.value !== null ? <>{d.scale.value} {d.scale.unit} <Badge tone="amber">Not confirmed</Badge></> : <Badge tone="amber">{d.scale.reason ?? "Not confirmed"}</Badge>}</strong>
    </div>
    {frozen ? <p className="fa-muted">{runConfirmed ? "The drawing is frozen with the confirmed run." : "The approved drawing is frozen in this package."} Start a new package for a new revision.</p> : <>
      <div className="fa-row3">
        <Field label="Revision"><input value={rev} onChange={e => setRev(e.target.value)} maxLength={40} /></Field>
        <Field label="Page"><input value={page} inputMode="numeric" aria-invalid={!pageOk(page)} className={pageOk(page) ? undefined : "is-invalid"} onChange={e => setPage(e.target.value)} /></Field>
        <Field label="Scale, mm per pixel"><input value={scale} inputMode="decimal" placeholder="e.g. 1" onChange={e => setScale(e.target.value)} /></Field>
      </div>
      <div className="fa-actions">
        <Button variant="primary" busy={busy === "scale"} disabled={!!busy || !(Number(scale) > 0)} onClick={() => void saveScale(true)}>Confirm scale</Button>
        <Button busy={busy === "scale-save"} disabled={!!busy} onClick={() => void saveScale(false)}>Save without confirming</Button>
      </div>
      <label className="fa-link-file">Replace file<input type="file" accept="application/pdf,image/png,image/jpeg" disabled={!!busy} onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} /></label>
    </>}
  </div>;
}

// ---------------------------------------------------------------- run editor

/** The contract wants a positive whole page number; anything else stops the action before the upload or patch. */
const pageOk = (text: string) => /^\s*\d+\s*$/.test(text) && Number(text) >= 1;
const pageNumber = (text: string) => { if (!pageOk(text)) throw new Error("Page must be a whole number, 1 or more."); return Number(text); };

const KIND_LABEL: Record<RunNodeKind, string> = { tie_in: "Tie-in", open_end: "Open end", elbow: "90° elbow" };

export function RunEditor({ s, act, busy, unit, setNotice, callouts }: Common & { callouts: Callouts }) {
  const saved = useMemo(() => runNodes(s.baselinePlan), [s.baselinePlan]);
  const frozen = s.baselinePlan?.confirmation === "confirmed";
  const blank: RunNode[] = s.intent === "adapt_to_site" ? [{ kind: "tie_in", x: 0, y: 0 }, { kind: "tie_in", x: null, y: 0 }] : [{ kind: "open_end", x: 0, y: 0 }, { kind: "elbow", x: null, y: 0 }, { kind: "open_end", x: null, y: null }];
  const [draft, setDraft] = useState(() => syncRunDraft(null, saved ?? blank, unit));
  const currentDraft = syncRunDraft(draft, saved ?? blank, unit);
  if (currentDraft !== draft) setDraft(currentDraft);
  const rows = currentDraft.rows;
  const setRows = (rows: typeof draft.rows) => setDraft({ ...currentDraft, rows });

  const nodes: RunNode[] = rows.map(r => ({ kind: r.kind, x: parseLength(r.x, unit), y: parseLength(r.y, unit) }));
  // No product is assumed: a typed run is only sized with a product the user chose.
  const [product, setProduct] = useState(() => s.baselinePlan?.entities.find(e => e.kind === "pipe")?.productId === PIPE ? "cpvc" : "none");
  const built = buildRun(nodes, s.baselinePlan?.id ?? "baseline", undefined, product === "cpvc" ? { pipe: PIPE, elbow: ELBOW } : { pipe: null, elbow: null });
  const productChanged = !!s.baselinePlan && (s.baselinePlan.entities.find(e => e.kind === "pipe")?.productId ?? null) !== (product === "cpvc" ? PIPE : null);
  const problems = "problems" in built ? built.problems : [];
  const dirty = runChanged(nodes, saved, unit) || productChanged;
  const drawingReady = s.sourceDrawing?.scale.basis === "confirmed_inputs";

  const save = () => act("run", async cur => {
    if ("problems" in built) return;
    const patch = runEditPatch(cur, nodes, built);
    await patchClearing(cur, patch, setNotice);
    if (patch.changeRequest === null && cur.changeRequest) setNotice("Your site change was cleared because the run shape changed. Choose the affected pipe again.");
  });
  const confirm = () => {
    if (!s.baselinePlan) return;
    if (!window.confirm("Confirm these run dimensions against the drawing? The confirmed run is frozen in this package; a later change needs a new package.")) return;
    void act("confirm-run", async cur => {
      if (!cur.baselinePlan) return;
      const d = cur.sourceDrawing;
      const source = `${BY_YOU} against ${d ? `${d.drawingId} rev ${d.revision} p${d.page}` : "the drawing"}`;
      const datums: FactSpec[] = [];
      for (const pipe of cur.baselinePlan.entities.filter(e => e.kind === "pipe"))
        for (const end of ["start", "end"]) {
          const f = findFact(cur, `datum.${end}`, pipe.id);
          if (f?.value) datums.push({ field: `datum.${end}`, value: f.value, subjectIds: [pipe.id], confirmation: "confirmed", context: "detailing", source });
        }
      await patchClearing(cur, { baselinePlan: { ...cur.baselinePlan, confirmation: "confirmed" }, ...upsertFacts(cur, datums) }, setNotice);
    });
  };

  if (!saved && s.baselinePlan) return <Callout tone="neutral" title="This run has a shape the editor does not handle">It is drawn on the plan as saved. The editor handles one open run with tie-ins or open ends and 90° elbows.</Callout>;

  return <div className="fa-stack">
    <p className="fa-muted">Enter the run in order along the pipe, as positions measured on the drawing from the first point ({unit === "mm" ? "mm" : "ft-in, e.g. 10' 2-1/2\""}).</p>
    <div className="fa-table-wrap"><table className="fa-table fa-run">
      <thead><tr><th>#</th><th>Point</th><th>X</th><th>Y</th>{!frozen && <th aria-label="Remove" />}</tr></thead>
      <tbody>{rows.map((r, i) => {
        const tag = s.baselinePlan && saved ? (r.kind === "elbow" ? callouts.fitting.get(`f${rows.slice(0, i + 1).filter(x => x.kind === "elbow").length}`) : r.kind === "tie_in" ? callouts.tieIn.get(`t${rows.slice(0, i + 1).filter(x => x.kind === "tie_in").length}`) : undefined) : undefined;
        return <tr key={i}>
          <td className="mono">{i + 1}</td>
          <td>{frozen ? <>{KIND_LABEL[r.kind]} {tag && <span className="fa-tagtext">{tag}</span>}</> :
            <select aria-label={`Point ${i + 1} type`} value={r.kind} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, kind: e.target.value as RunNodeKind } : x))}>
              {(i === 0 || i === rows.length - 1 ? ["tie_in", "open_end"] : ["elbow"]).map(k => <option key={k} value={k}>{KIND_LABEL[k as RunNodeKind]}</option>)}
            </select>}</td>
          {(["x", "y"] as const).map(axis => <td key={axis}>{frozen ? <span className="mono">{r[axis] || "—"}</span> :
            <input aria-label={`Point ${i + 1} ${axis.toUpperCase()}`} className={`mono ${r[axis] && parseLength(r[axis], unit) === null ? "is-invalid" : ""}`} value={r[axis]} placeholder="—"
              onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, [axis]: e.target.value } : x))} />}</td>)}
          {!frozen && <td><button type="button" className="fa-icon-btn" aria-label={`Remove point ${i + 1}`} disabled={rows.length <= 2} onClick={() => {
            const next = rows.filter((_, j) => j !== i);
            next[0] = { ...next[0], kind: next[0].kind === "elbow" ? "open_end" : next[0].kind };
            const last = next.length - 1;
            next[last] = { ...next[last], kind: next[last].kind === "elbow" ? "open_end" : next[last].kind };
            setRows(next);
          }}><Icon name="x" size={14} /></button></td>}
        </tr>;
      })}</tbody>
    </table></div>
    {frozen ? <p className="fa-muted"><Badge tone="green">Run confirmed</Badge> The confirmed run is frozen in this package.</p> : <>
      <button type="button" className="fa-link" onClick={() => {
        const next = [...rows];
        const last = next[next.length - 1];
        next[next.length - 1] = { ...last, kind: "elbow" };
        next.push({ kind: last.kind === "elbow" ? "open_end" : last.kind, x: "", y: "" });
        setRows(next);
      }}>+ Add a point (the current end becomes an elbow)</button>
      <Field label="Pipe and fittings"><select value={product} onChange={e => setProduct(e.target.value)}>
        <option value="none">Not selected yet</option><option value="cpvc">Spears FlameGuard CPVC NPS 1 (supported catalog)</option></select></Field>
      {problems.length > 0 && <ul className="fa-problems">{problems.map(p => <li key={p}>{p}</li>)}</ul>}
      <div className="fa-actions">
        <Button busy={busy === "run"} disabled={!!busy || problems.length > 0} onClick={() => void save()}>Save run</Button>
        <Button variant="primary" busy={busy === "confirm-run"} disabled={!!busy || !s.baselinePlan || !saved || dirty || !drawingReady || problems.length > 0} onClick={confirm}>Confirm dimensions</Button>
      </div>
      {s.baselinePlan && saved && dirty && problems.length === 0 && <p className="fa-muted small">Save the run first. Confirming freezes the saved run, not unsaved edits.</p>}
      {s.baselinePlan && saved && !drawingReady && <p className="fa-muted small">Upload the drawing and confirm its scale first. Confirming the run also freezes the drawing.</p>}
    </>}
  </div>;
}

// ---------------------------------------------------------------- single facts

type Kind = { type: "length" } | { type: "bool"; yes: string; no: string } | { type: "text" } | { type: "choice"; options: Array<[string, string]> };
interface RowSpec { field: string; subject?: string; label: string; kind: Kind; context?: Fact["context"]; help?: string }

export function FactRow({ s, act, busy, unit, setNotice, spec }: Common & { spec: RowSpec }) {
  const f = findFact(s, spec.field, spec.subject);
  const key = `${spec.field}.${spec.subject ?? ""}`;
  const initial = () => {
    if (f?.value === null || f?.value === undefined) return "";
    if (spec.kind.type === "length" && typeof f.value === "number") { const m = toMetres(f.value, f.unit ?? "mm"); return m === null ? "" : lengthInput(m * 1000, unit); }
    return String(f.value);
  };
  const [value, setValue] = useState(initial);
  const [editing, setEditing] = useState(!isConfirmed(f));
  useEffect(() => { setValue(initial()); setEditing(!isConfirmed(f)); }, [f?.id, f?.value, unit]);

  const parsed = spec.kind.type === "length" ? parseLength(value, unit) : spec.kind.type === "bool" ? (value === "true" ? true : value === "false" ? false : null) : value.trim() || null;
  const save = () => act(key, cur => patchClearing(cur, upsertFacts(cur, [{
    field: spec.field, subjectIds: spec.subject ? [spec.subject] : [], value: parsed, unit: spec.kind.type === "length" ? "mm" : null,
    confirmation: "confirmed", context: spec.context ?? "detailing", source: spec.context === "observed" ? MEASURED : BY_YOU,
  }]), setNotice));
  const shown = f?.value === null || f?.value === undefined ? null
    : spec.kind.type === "length" && typeof f.value === "number" ? lengthText({ value: f.value, unit: f.unit ?? "mm", basis: "confirmed_inputs" }).primary
    : spec.kind.type === "bool" ? (f.value ? spec.kind.yes : spec.kind.no)
    : spec.kind.type === "choice" ? spec.kind.options.find(o => o[0] === f.value)?.[1] ?? String(f.value) : String(f.value);

  return <div className="fa-fact">
    <div className="fa-fact-head"><span>{spec.label}</span>{factStatus(f)}</div>
    {!editing ? <div className="fa-fact-value"><span className={spec.kind.type === "length" ? "mono" : ""}>{shown}</span><button type="button" className="fa-link" onClick={() => setEditing(true)}>Change</button></div> :
      <div className="fa-fact-edit">
        {spec.kind.type === "bool" ? <select value={value} onChange={e => setValue(e.target.value)} aria-label={spec.label}><option value="">Not confirmed</option><option value="true">{spec.kind.yes}</option><option value="false">{spec.kind.no}</option></select>
          : spec.kind.type === "choice" && spec.kind.options.length ? <select value={value} onChange={e => setValue(e.target.value)} aria-label={spec.label}><option value="">Choose…</option>{spec.kind.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          : spec.kind.type === "text" ? <textarea value={value} onChange={e => setValue(e.target.value)} rows={2} aria-label={spec.label} />
          : <input value={value} onChange={e => setValue(e.target.value)} aria-label={spec.label} className={spec.kind.type === "length" ? "mono" : ""} placeholder={spec.kind.type === "length" ? (unit === "mm" ? "mm" : `ft-in`) : ""} />}
        <Button variant="primary" busy={busy === key} disabled={!!busy || parsed === null} onClick={() => void save()}>{spec.context === "observed" ? "Save measurement" : "Confirm"}</Button>
      </div>}
    {spec.help && <small className="fa-muted">{spec.help}</small>}
  </div>;
}

export function DetailingInputs(props: Common & { callouts: Callouts }) {
  const { s, callouts } = props;
  const plan = activeDetailingPlan(s);
  const work = inScope(s);
  const pipes = plan?.entities.filter(e => e.kind === "pipe" && work(e.id)) ?? [];
  const ties = plan?.entities.filter(e => e.kind === "tie_in" && work(e.id)) ?? [];
  const fits = plan?.entities.filter(e => e.kind === "fitting" && work(e.id)) ?? [];
  const datum: Kind = { type: "choice", options: [["center_to_center", "Center to center (fitting or tie-in)"], ["physical_pipe_end", "Physical pipe end"], ["scope_interface", "Scope station (not a physical joint)"]] };
  const done = (rows: RowSpec[]) => rows.every(r => isConfirmed(findFact(s, r.field, r.subject)));
  const dims: RowSpec[] = [
    ...pipes.flatMap(p => (["start", "end"] as const).map(end => ({ field: `datum.${end}`, subject: p.id, label: `Piece ${callouts.piece.get(p.id)} ${end}: dimension to`, kind: datum }))),
    ...ties.map(t => ({ field: "netCutOffset", subject: t.id, label: `${callouts.tieIn.get(t.id)} net cut offset`, kind: { type: "length" } as Kind, help: "Deducted at the tie-in, as measured for this connection." })),
  ];
  const assembly: RowSpec[] = [
    // Insertion, quarter-turn and cure questions belong to solvent-cement joints only.
    ...fits.filter(f => f.productId === ELBOW).flatMap(f => f.ports.map(port => ({ field: `movement.${port.id}`, subject: f.id, label: `${callouts.fitting.get(f.id)}/${port.id}: full insertion and quarter turn possible`, kind: { type: "bool", yes: "Yes, confirmed", no: "No" } as Kind }))),
    { field: "workAreaAccess", label: "Work-area access", kind: { type: "bool", yes: "Access confirmed", no: "No access" } },
    ...(showCpvcInputs(s) ? [{ field: "curePlan", label: "Set and cure plan (temperature, fit, test pressure)", kind: { type: "text" } as Kind }] : []),
  ];
  const project: RowSpec[] = projectBasis(s).map(b => ({ field: b.field, label: b.label, kind: b.options.length ? { type: "choice", options: b.options } : { type: "text" } }));
  return <>
    {plan && <Section title="Dimensions" count={`${dims.filter(r => isConfirmed(findFact(s, r.field, r.subject))).length}/${dims.length}`} defaultOpen={!done(dims)}>{dims.map(r => <FactRow key={`${r.field}.${r.subject}`} {...props} spec={r} />)}</Section>}
    <Section title="Assembly conditions" count={`${assembly.filter(r => isConfirmed(findFact(s, r.field, r.subject))).length}/${assembly.length}`} defaultOpen={!done(assembly)}>{assembly.map(r => <FactRow key={`${r.field}.${r.subject}`} {...props} spec={r} />)}</Section>
    <Section title="Project basis" count={`${project.filter(r => isConfirmed(findFact(s, r.field))).length}/${project.length}`} defaultOpen={!done(project)}>{!showSfInputs(s) && <p className="fa-muted">This package has no confirmed San Francisco basis. Source basis, current applicability and approval remain separate; supply project-specific facts through the shared intake/API.</p>}{project.map(r => <FactRow key={r.field} {...props} spec={r} />)}</Section>
  </>;
}

// ---------------------------------------------------------------- site conditions

export function ChangeInputs({ s, act, busy, setNotice, callouts }: Common & { callouts: Callouts }) {
  const pipes = s.baselinePlan?.entities.filter(e => e.kind === "pipe" && inScope(s)(e.id)) ?? [];
  const [desc, setDesc] = useState(s.changeRequest?.description ?? "");
  const [ids, setIds] = useState<string[]>(s.changeRequest?.affectedEntityIds ?? []);
  useEffect(() => { setDesc(s.changeRequest?.description ?? ""); setIds(s.changeRequest?.affectedEntityIds ?? []); }, [s.changeRequest]);
  const save = () => act("change", cur => patchClearing(cur, {
    changeRequest: { id: cur.changeRequest?.id ?? "site-change", description: desc.trim(), affectedEntityIds: ids, factIds: [...cur.detailing, ...cur.siteFacts].filter(f => f.field.startsWith("duct.")).map(f => f.id) },
  }, setNotice));
  if (!pipes.length) return <p className="fa-muted">Enter the existing run first, then choose the piece the obstacle blocks.</p>;
  return <div className="fa-stack">
    <Field label="What did you find on site?"><textarea rows={2} value={desc} onChange={e => setDesc(e.target.value)} placeholder="e.g. Duct installed where the branch should run" /></Field>
    <p className="fa-muted small">Choose one straight interval. Remaining pipes, heads and connections are retained as protected context and excluded from this interval’s purchase quantities.</p>
    <div className="fa-chips" role="radiogroup" aria-label="Active straight interval">{pipes.map(p => <label key={p.id} className={`fa-chip ${ids.includes(p.id) ? "is-on" : ""}`}>
      <input type="radio" name="active-interval" checked={ids.includes(p.id)} onChange={() => setIds([p.id])} />Piece {callouts.piece.get(p.id)}
    </label>)}</div>
    <div className="fa-actions"><Button variant="primary" busy={busy === "change"} disabled={!!busy || !desc.trim() || !ids.length} onClick={() => void save()}>Save site condition</Button></div>
  </div>;
}

export function EvidenceInputs({ s, act, busy, setNotice }: Common) {
  const photos = s.siteFacts.filter(f => f.field.startsWith("evidence.photo") && f.source.assetId);
  const [caption, setCaption] = useState("");
  const upload = (file: File) => act("evidence", async cur => {
    const asset = await api.upload(cur.id, file);
    const n = cur.siteFacts.filter(f => f.field.startsWith("evidence.photo")).length + 1;
    await patchClearing(cur, upsertFacts(cur, [{
      field: `evidence.photo.${n}`, value: file.name.slice(0, 200), subjectIds: cur.changeRequest?.affectedEntityIds ?? [], confirmation: "confirmed",
      context: "observed", source: caption.trim() || `Site photo taken by you: ${file.name}`, assetId: asset.id,
    }]), setNotice);
    setCaption("");
  });
  return <div className="fa-stack">
    <p className="fa-muted">Photos are kept as evidence with the measurements. The route planner does not read measurements from photos.</p>
    {photos.length > 0 && <div className="fa-thumbs">{photos.map(p => <Thumb key={p.id} packageId={s.id} assetId={p.source.assetId!} caption={p.source.description} />)}</div>}
    <Field label="Caption"><input value={caption} onChange={e => setCaption(e.target.value)} placeholder="e.g. Duct at grid C-3, looking north" /></Field>
    <label className={`fa-drop small ${busy === "evidence" ? "is-busy" : ""}`}><Icon name="camera" /><span>{busy === "evidence" ? "Uploading…" : "Add site photo"}</span>
      <input type="file" accept="image/png,image/jpeg" capture="environment" disabled={!!busy} onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
    </label>
  </div>;
}

function Thumb({ packageId, assetId, caption }: { packageId: string; assetId: string; caption: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false, made: string | null = null;
    api.asset(packageId, assetId).then(b => { if (!revoked) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => undefined);
    return () => { revoked = true; if (made) URL.revokeObjectURL(made); };
  }, [packageId, assetId]);
  return <figure className="fa-thumb">{url ? <img src={url} alt={caption} /> : <div className="fa-thumb-ph" />}<figcaption>{caption}</figcaption></figure>;
}
