import type { PackageResult } from "@field-agent/core";
import type { DetailPlan } from "./api.js";
import { countText, DISPLAY_ROUNDING, lengthText, metresText, productCode, productName, signedCount, type Quantity } from "./format.js";
import { checkCounts, groupChecks, labelFor, ROUTE_ORDER_NOTE, sourceTitle, sourceUrl, type Callouts, type CheckGroup, type Plan, type RouteOption } from "./model.js";
import { Badge, Button, Callout, Icon, Length, Section } from "./ui.js";

type Sources = Array<{ id: string; document?: string; title?: string; url?: string }> | undefined;
const STATUS: Record<CheckGroup["status"], { label: string; tone: "green" | "amber" | "red" | "neutral" }> = {
  pass: { label: "Pass", tone: "green" }, unknown: { label: "Unknown", tone: "amber" }, fail: { label: "Fail", tone: "red" }, not_applicable: { label: "N/A", tone: "neutral" },
};

export function SourceLinks({ refs, sources }: { refs: string[]; sources: Sources }) {
  if (!refs.length) return <span className="fa-src none">No source cited</span>;
  return <span className="fa-src">{refs.map(r => {
    const url = sourceUrl(r, sources);
    return url ? <a key={r} href={url} target="_blank" rel="noreferrer">{sourceTitle(r, sources)}<Icon name="external" size={11} /></a> : <span key={r}>{sourceTitle(r, sources)}</span>;
  })}</span>;
}

export function CheckList({ groups, sources, callouts, compact }: { groups: CheckGroup[]; sources: Sources; callouts?: Callouts; compact?: boolean }) {
  if (!groups.length) return <p className="fa-muted">No findings for this item.</p>;
  return <ul className={`fa-checks ${compact ? "compact" : ""}`}>{groups.map(g => <li key={`${g.status}${g.reason}`}>
    <Badge tone={STATUS[g.status].tone}>{STATUS[g.status].label}</Badge>
    <div>
      <p>{g.reason}{g.count > 1 && <span className="fa-muted"> ({g.count} checks)</span>}</p>
      {!compact && callouts && g.subjectIds.length > 0 && <p className="fa-muted small">Applies to {g.subjectIds.map(id => labelFor(callouts, id)).join(", ")}</p>}
      <SourceLinks refs={g.sourceRefs} sources={sources} />
    </div>
  </li>)}</ul>;
}

/** Stale results stay visible but say what they belong to. */
export function Freshness({ current, revision, resultRevision }: { current: boolean; revision: number; resultRevision?: number }) {
  if (current) return <Badge tone="green">Current for rev {revision}</Badge>;
  return <Badge tone="amber" title="Inputs changed after these results were generated">Stale: from rev {resultRevision ?? "?"}, inputs now rev {revision}</Badge>;
}

export function MaterialsCuts({ result, current, revision, plan, callouts, detail, selectedPiece, onSelectPiece, sources, label }: {
  result: PackageResult | undefined; current: boolean; revision: number; plan: Plan | null; callouts: Callouts; detail?: DetailPlan;
  selectedPiece: string | null; onSelectPiece: (id: string | null) => void; sources: Sources; label?: string;
}) {
  if (!result) return <div className="fa-empty"><Icon name="layers" size={28} /><p>No materials yet.</p><small>Generate from your inputs to see the materials, cut list and assembly for this run.</small></div>;
  const cutDetail = new Map(detail?.fabrication?.cuts.map(c => [c.pieceId, c]) ?? []);
  const fittings = plan?.entities.filter(e => e.kind === "fitting" && result.materials.some(m => m.entityIds.includes(e.id))) ?? [];
  return <div className="fa-stack">
    <div className="fa-headline"><div>{label && <strong>{label}</strong>}<Freshness current={current} revision={revision} resultRevision={result.inputRevision} /></div></div>
    {!current && <Callout title="These results are from older inputs">Regenerate before cutting. The numbers below are kept for comparison only.</Callout>}
    <Section title="Materials" count={result.materials.length}>
      <table className="fa-table"><thead><tr><th>Item</th><th className="num">Modeled qty</th></tr></thead>
        <tbody>{result.materials.map(m => <tr key={m.id}>
          <td><strong>{productName(m.description)}</strong><small className="mono">{productCode(m.description)}</small><div className="fa-steptags">{m.entityIds.map(id => <button type="button" key={id} className="fa-tagbox small" aria-pressed={selectedPiece === id} onClick={() => onSelectPiece(selectedPiece === id ? null : id)}>{labelFor(callouts, id)}</button>)}</div></td>
          <td className="num">{m.quantity.value === null ? <span className="fa-unknown" title={m.quantity.reason}>Unknown<small>{m.quantity.reason}</small></span> : countText(m.quantity)}</td>
        </tr>)}</tbody></table>
    </Section>
    <Section title="Cut list" count={result.cuts.length}>
      <table className="fa-table fa-cuts"><thead><tr><th>Piece</th><th className="num">Center to center</th><th className="num">Cut length</th></tr></thead>
        <tbody>{result.cuts.map(c => {
          const d = cutDetail.get(c.pieceId);
          const on = c.pieceId === selectedPiece;
          return [
            <tr key={c.id} className={`fa-selectable ${on ? "is-on" : ""}`} onClick={() => onSelectPiece(on ? null : c.pieceId)} tabIndex={0} onKeyDown={e => { if (e.key === "Enter") onSelectPiece(on ? null : c.pieceId); }} aria-selected={on}>
              <td><span className={`fa-tagbox ${lengthText(c.length).known ? "" : "is-unknown"}`}>{callouts.piece.get(c.pieceId) ?? "?"}</span><small>{productCode(plan?.entities.find(e => e.id === c.pieceId)?.productId)}</small></td>
              <td className="num">{d ? <Length q={d.centerline as Quantity} /> : <span className="fa-muted">—</span>}</td>
              <td className="num strong"><Length q={c.length} /></td>
            </tr>,
            on && <tr key={`${c.id}-d`} className="fa-rowdetail"><td colSpan={3}>
              {d?.takeouts.length ? <div className="fa-takeouts"><span className="fa-muted">Deductions (server)</span>{d.takeouts.map((t, i) => <span key={i}>{t.fittingId ? callouts.fitting.get(t.fittingId) ?? "fitting" : t.datum === "tie_in" ? "Tie-in" : t.datum.replace(/_/g, " ")}: <b className="mono">{lengthText(t.netTakeout as Quantity).primary}</b></span>)}</div> : null}
              {d?.formula && <p className="fa-muted small mono">{d.formula}</p>}
              <CheckList groups={groupChecks(result.evaluations, c.pieceId)} sources={sources} compact />
            </td></tr>,
          ];
        })}</tbody></table>
      {fittings.length > 0 && <p className="fa-muted small">Fittings: {fittings.map(f => `${callouts.fitting.get(f.id)} ${productCode(f.productId)}`).join(" · ")}</p>}
      <p className="fa-muted small">{DISPLAY_ROUNDING}</p>
    </Section>
    {result.gaps.length > 0 && <Section title="Still missing" count={result.gaps.length} defaultOpen={false}>
      <ul className="fa-list">{[...new Set(result.gaps.map(g => g.reason))].map(r => <li key={r}>{r}</li>)}</ul>
    </Section>}
  </div>;
}

export function Assembly({ result, callouts, sources, selectedPiece, onSelectPiece }: { result: PackageResult | undefined; callouts: Callouts; sources: Sources; selectedPiece?: string | null; onSelectPiece?: (id: string | null) => void }) {
  if (!result) return <div className="fa-empty"><p>No assembly steps yet.</p></div>;
  return <ol className="fa-steps">{result.assembly.map(a => <li key={a.id} className={a.unresolved.length ? "is-open" : ""}>
    <span className="fa-stepno">{a.step}</span>
    <div>
      <p>{a.instruction}</p>
      <div className="fa-steptags">{a.pieceIds.map(id => <button type="button" key={id} className="fa-tagbox small" aria-pressed={selectedPiece === id} onClick={() => onSelectPiece?.(selectedPiece === id ? null : id)}>{callouts.piece.get(id) ?? id}</button>)}{a.jointIds.length > 0 && <span className="fa-muted small">{a.jointIds.length} joint{a.jointIds.length > 1 ? "s" : ""}</span>}</div>
      {a.procedureRef && <SourceLinks refs={[a.procedureRef]} sources={sources} />}
      {a.unresolved.map(u => <p key={u} className="fa-warn small"><Icon name="alert" size={12} /> {u}</p>)}
    </div>
  </li>)}</ol>;
}

export function Checks({ result, sources, callouts }: { result: PackageResult | undefined; sources: Sources; callouts: Callouts }) {
  if (!result) return <div className="fa-empty"><p>No checks yet.</p></div>;
  const c = checkCounts(result.evaluations);
  return <div className="fa-stack">
    <div className="fa-counts"><span><b>{c.pass}</b> pass</span><span className="amber"><b>{c.unknown}</b> unknown</span><span className="red"><b>{c.fail}</b> fail</span></div>
    <p className="fa-muted small">These are the server's rule findings for this run. Unknown means the rule could not be decided from the inputs; it is not a pass. None of this is construction approval.</p>
    <Section title="This work" count={groupChecks(result.evaluations).filter(g => g.subjectIds.length).length}><CheckList groups={groupChecks(result.evaluations).filter(g => g.subjectIds.length)} sources={sources} callouts={callouts} /></Section>
    <Section title="Project and permit" count={groupChecks(result.evaluations, "").length} defaultOpen={false}><CheckList groups={groupChecks(result.evaluations, "")} sources={sources} /></Section>
  </div>;
}

// ---------------------------------------------------------------- adapt

export function RouteComparison({ routes, baseline, baselineResult, focusId, selectedId, current, appliedAt, rejected, searchDescription, noneReason, onPreview, onRegenerate, onShowPackage, busy, clearanceMissing, sources }: {
  routes: RouteOption[]; baseline: Plan | null; baselineResult: PackageResult | undefined; focusId: string | null; selectedId: string | null; current: boolean; appliedAt: number | null;
  rejected: Array<{ id: string; reason: string }>; searchDescription: string | null; noneReason: string | null;
  onPreview: (id: string) => void; onRegenerate: () => void; onShowPackage: () => void; busy: boolean; clearanceMissing: boolean; sources: Sources;
}) {
  const focus = routes.find(r => r.plan.id === focusId);
  const baseFittings = baseline?.entities.filter(e => e.kind === "fitting").length ?? 0;
  return <div className="fa-stack">
    {!current && routes.length > 0 && appliedAt !== null && <Callout tone="neutral" title={`Route ${routes.find(r => r.plan.id === selectedId)?.letter ?? ""} is applied at rev ${appliedAt}`} action={<Button busy={busy} onClick={onRegenerate}><Icon name="refresh" size={14} />Regenerate</Button>}>
      Selecting a route creates a new input revision, so these routes are kept as history. Regenerate to choose a different one.
    </Callout>}
    {!current && routes.length > 0 && appliedAt === null && <Callout title="These routes were generated for older inputs" action={<Button busy={busy} onClick={onRegenerate}><Icon name="refresh" size={14} />Regenerate</Button>}>
      {selectedId ? "Your selection is kept for reference, but it cannot be used until the routes are regenerated." : "Regenerate before choosing a route."}
    </Callout>}
    {clearanceMissing && <Callout title="Clearance measurement needed">Enter the required clearance under Site evidence so the planner can keep routes clear of the duct.</Callout>}
    {routes.length === 0 ? <Callout tone="red" title="No generated alternative is available" action={<Button busy={busy} onClick={onRegenerate}>Regenerate</Button>}>
      {noneReason ?? "Generate from confirmed inputs to search the supported templates."} Check the obstacle and work boundary measurements, then regenerate.
    </Callout> : <Section title="Proposed routes" count={routes.length}>
      <table className="fa-table fa-routes"><thead><tr><th>Route</th><th>Proposal</th><th>State</th></tr></thead>
        <tbody>{routes.map(r => {
          const state = r.plan.id === selectedId ? <Badge tone="blue">Selected by you</Badge> : r.centerlineDeltaM === null ? <Badge tone="amber">Needs input</Badge> : r.plan.id === focusId ? <Badge>Previewing</Badge> : <Badge>Generated</Badge>;
          const delta = metresText(r.centerlineDeltaM, true);
          return <tr key={r.plan.id} className={`fa-selectable ${r.plan.id === focusId ? "is-on" : ""}`} onClick={() => onPreview(r.plan.id)} tabIndex={0} onKeyDown={e => { if (e.key === "Enter") onPreview(r.plan.id); }}>
            <td><span className="fa-route-letter">{r.letter}</span></td>
            <td><strong>{r.fittings - baseFittings} added fitting{r.fittings - baseFittings === 1 ? "" : "s"}</strong><small>{delta.known ? `${delta.primary} centerline` : `Length unknown: ${r.unknownReason}`}</small></td>
            <td>{state}</td>
          </tr>;
        })}</tbody></table>
      {routes.length === 1 && <p className="fa-muted small">Only one route fits. Review it before selecting.</p>}
      <p className="fa-muted small">{ROUTE_ORDER_NOTE}{searchDescription ? ` Search: ${searchDescription}` : ""}</p>
    </Section>}
    {rejected.length > 0 && <Section title="Layouts the planner rejected" count={rejected.length} defaultOpen={false}>
      <ul className="fa-list">{rejected.map(r => <li key={r.id}>{r.reason}</li>)}</ul>
    </Section>}
    {focus && <Section title={`Changes with Route ${focus.letter}`}>
      <table className="fa-table"><thead><tr><th /><th className="num">Existing</th><th className="num">Route {focus.letter}</th></tr></thead>
        <tbody>
          <tr><td>Pipe centerline</td><td className="num fa-muted">—</td><td className="num"><Length q={focus.centerlineDeltaM === null ? { value: null, unit: "m", reason: focus.unknownReason } : { value: focus.centerlineDeltaM, unit: "m", basis: "proposed_inputs" }} signed /></td></tr>
          <tr><td>Fittings incl. retained context</td><td className="num">{baseFittings}</td><td className="num">{focus.fittings}</td></tr>
          <tr><td>Modeled spans (closure may split them)</td><td className="num">{baselineResult?.cuts.length ?? "Unknown"}</td><td className="num">{focus.result?.cuts.length ?? "Unknown"}</td></tr>
          <tr><td>Assembly steps</td><td className="num">{baselineResult?.assembly.length ?? "Unknown"}</td><td className="num">{focus.result?.assembly.length ?? "Unknown"}</td></tr>
        </tbody></table>
      {focus.result && <CheckList groups={groupChecks(focus.result.evaluations).filter(g => g.subjectIds.length && g.status !== "pass").slice(0, 2)} sources={sources} compact />}
      <Button variant="quiet" onClick={onShowPackage}>View materials and cuts</Button>
    </Section>}
  </div>;
}

export function PackageDelta({ detail, callouts, baselineResult }: { detail: DetailPlan | undefined; callouts: Callouts; baselineResult: PackageResult | undefined }) {
  const delta = detail?.delta;
  if (!delta) return null;
  const name = (id: string) => { if (id.startsWith("unresolved-")) return `${id.slice(11)} requirements (unresolved)`; const [kind, product] = id.split(":"); return kind === "consumable" ? "Solvent cement" : productName(product); };
  return <Section title="Change from the original">
    <table className="fa-table"><thead><tr><th>Item</th><th className="num">Original</th><th className="num">Revised</th><th className="num">Change</th></tr></thead>
      <tbody>{delta.materials.map(m => <tr key={m.id}>
        <td>{name(m.id)}</td>
        <td className="num">{m.baselineQuantity ?? "Unknown"}</td>
        <td className="num">{m.candidateQuantity ?? <span className="fa-unknown">Unknown</span>}</td>
        <td className="num strong">{signedCount(m.quantityDelta)}</td>
      </tr>)}</tbody></table>
    <div className="fa-kv compact">
      <span>Centerline</span><strong><Length q={delta.centerlineDeltaM === null ? null : { value: delta.centerlineDeltaM, unit: "m", basis: "proposed_inputs" }} signed /></strong>
      <span>Total cut length</span><strong><Length q={delta.cutLengthDeltaM === null ? null : { value: delta.cutLengthDeltaM, unit: "m", basis: "proposed_inputs" }} signed /></strong>
      <span>Joints</span><strong className="mono">{signedCount(delta.jointCountDelta)}</strong>
      <span>Operations</span><strong className="mono">{signedCount(delta.operationCountDelta)}</strong>
    </div>
    <ul className="fa-deltas">{delta.pieces.map(p => <li key={p.pieceId}>
      <span className={`fa-delta-mark ${p.state}`}>{p.state === "added" ? "+" : p.state === "removed" ? "−" : "~"}</span>
      Piece {callouts.piece.get(p.pieceId) ?? p.pieceId} <span className="fa-muted">{p.state}</span>
      <span className="mono">{metresText(p.cutLengthDeltaM, true).primary}</span>
    </li>)}</ul>
    {baselineResult && <p className="fa-muted small">The original baseline is preserved unchanged: {baselineResult.cuts.length} piece{baselineResult.cuts.length === 1 ? "" : "s"}, {baselineResult.cuts.map(c => lengthText(c.length).primary).join(", ")}.</p>}
  </Section>;
}
