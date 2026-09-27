import { adaptationFrame } from "@field-agent/core";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Snapshot } from "./api.js";
import { dateTime } from "./format.js";
import { ChangeInputs, ClearanceInput, DetailingInputs, DrawingInputs, EvidenceInputs, RunEditor, BoxInputs, type Unit } from "./inputs.js";
import { callouts, findFact, isConfirmed, readBox, requirements, resultFor, routeOptions, runBlockers, type Plan } from "./model.js";
import { Assembly, Checks, Freshness, MaterialsCuts, PackageDelta, RouteComparison } from "./outputs.js";
import { PlanCanvas } from "./PlanCanvas.js";
import { hasSampleData, sampleDrawing, sampleInputs } from "./sample.js";
import { Badge, Button, Callout, Icon, Section, Spinner } from "./ui.js";
import { usePackage } from "./usePackage.js";
import { AskPanel } from "./ask/AskPanel.js";

type Tab = "inputs" | "materials" | "assembly" | "checks" | "site" | "routes" | "package";
const TABS: Record<"prepare" | "adapt", Array<[Tab, string]>> = {
  prepare: [["inputs", "Inputs"], ["materials", "Materials & cuts"], ["assembly", "Assembly"], ["checks", "Checks"]],
  adapt: [["site", "Site evidence"], ["routes", "Routes"], ["package", "Revised package"], ["checks", "Checks"]],
};
const SELECT_QUESTION = /^Which alternative/;

export function Workbench({ id, onHome, onAuthFailure, header }: { id: string; onHome: () => void; onAuthFailure: () => void; header: (right: ReactNode, crumbs: ReactNode) => ReactNode }) {
  const pkg = usePackage(id, onAuthFailure);
  const s = pkg.snapshot;
  const [tab, setTab] = useState<Tab | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [piece, setPiece] = useState<string | null>(null);
  const [tool, setTool] = useState<"select" | "pan">("select");
  const [view, setView] = useState<"plan" | "drawing">("plan");
  const [unit, setUnit] = useState<Unit>(() => { try { return localStorage.getItem("field-agent.unit") === "mm" ? "mm" : "in"; } catch { return "in"; } });
  const [exportOpen, setExportOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  useEffect(() => { try { localStorage.setItem("field-agent.unit", unit); } catch { /* ignore */ } }, [unit]);

  const mode = s?.intent === "adapt_to_site" ? "adapt" : "prepare";
  const detailFor = (planId: string | undefined) => pkg.detail?.state?.details.find(d => d.plan.id === planId);
  const calloutsFor = useMemo(() => (plan: Plan) => callouts(plan, detailFor(plan.id)?.fabrication), [pkg.detail]);

  if (pkg.loading && !s) return <>{header(null, null)}<Spinner label="Loading work package…" /></>;
  if (!s) return <>{header(null, null)}<div className="fa-page-msg"><Callout tone="red" title="Could not open this work package">{pkg.error}</Callout><Button onClick={onHome}>Back to packages</Button></div></>;

  const baseline = s.baselinePlan;
  const routes = routeOptions(s.outputs.candidates, s.outputs.results);
  const candidatesCurrent = !!s.outputs.candidates && s.freshness.candidates;
  const selectedId = s.selectedPlan && s.selectedPlan.id !== baseline?.id ? s.selectedPlan.id : null;
  const focusId = preview && routes.some(r => r.plan.id === preview) ? preview : selectedId ?? routes[0]?.plan.id ?? null;
  const focus = routes.find(r => r.plan.id === focusId);
  const selected = routes.find(r => r.plan.id === selectedId);
  const base = resultFor(s, baseline?.id);
  const run = s.run;
  const running = run?.status === "running";
  const reqs = requirements(s);
  const missing = reqs.filter(r => !r.done);
  const blockers = runBlockers(s);
  const canRun = blockers.length === 0;
  let toDrawing: ((p: { x: number; y: number; z: number }) => { x: number; y: number; z: number }) | undefined;
  let frameError: string | null = null;
  try { toDrawing = adaptationFrame(s).toDrawing; } catch (e) { frameError = e instanceof Error ? e.message : String(e); }
  const duct = readBox(s, "duct").box, envelope = readBox(s, "workEnvelope").box;
  const sample = hasSampleData(s);
  const openRequests = s.outputs.requests.filter(r => s.freshness.requests.find(f => f.id === r.id && f.current && !f.answered) && !SELECT_QUESTION.test(r.question));
  const selectedResult = resultFor(s, selectedId ?? undefined);
  const detailCurrent = !!pkg.detail?.current && pkg.detail.state?.inputRevision === s.inputRevision;
  const artifactsCurrent = s.outputs.artifacts.filter(a => s.freshness.artifacts.find(f => f.id === a.id)?.current);

  const workPlan = mode === "prepare" ? baseline : focus?.plan ?? baseline;
  const workResult = mode === "prepare" ? base.result : focus?.result ?? base.result;
  const cuts = new Map((workResult?.cuts ?? []).map(c => [c.pieceId, c.length]));
  const sources = (detailFor(workPlan?.id) ?? detailFor(baseline?.id))?.fabrication?.sources as Array<{ id: string; document?: string; url?: string }> | undefined;
  const activeTab: Tab = tab ?? (mode === "prepare" ? (base.result ? "materials" : "inputs") : routes.length || s.outputs.candidates ? "routes" : "site");

  const start = (goal: "prepare_from_drawing" | "adapt_to_site" | "export_selected_package", label: string) =>
    pkg.act(label, cur => api.start(cur.id, cur.inputRevision, goal));
  const choose = (planId: string) => pkg.act("select", async cur => {
    const next = await api.select(cur.id, cur.inputRevision, planId);
    await api.start(next.id, next.inputRevision, "adapt_to_site");
  }).then(ok => { if (ok) { setPreview(null); setTab("package"); } });
  const clearSelection = () => baseline && pkg.act("clear", cur => api.select(cur.id, cur.inputRevision, baseline.id));
  const loadSample = () => pkg.act("sample", async cur => {
    const file = await sampleDrawing(mode);
    const asset = await api.upload(cur.id, file);
    await api.edit(cur.id, cur.inputRevision, sampleInputs(mode, asset.id));
  });

  // ------------------------------------------------ primary action
  let primary: ReactNode = null, fine = "";
  if (running) primary = <Button variant="primary" busy disabled>{run?.progress ? `Working: ${run.progress}` : "Working…"}</Button>;
  else if (mode === "prepare") {
    fine = "Results are generated from your inputs. They are not construction approval.";
    if (base.result && base.current) primary = <Button variant="primary" onClick={() => setExportOpen(true)}><Icon name="download" size={16} />Export package</Button>;
    else primary = <Button variant="primary" busy={pkg.busy === "run"} disabled={!canRun || !!pkg.busy} onClick={() => void start("prepare_from_drawing", "run")}>{base.result ? `Regenerate for rev ${s.inputRevision}` : "Generate materials and cuts"}</Button>;
  } else {
    fine = "Choosing a route records your selection. It is not construction approval.";
    const onSelected = !!selected && (!focus || focus.plan.id === selectedId);
    if (onSelected && selectedResult.current) primary = <Button variant="primary" onClick={() => setExportOpen(true)}><Icon name="download" size={16} />Export revised package</Button>;
    else if (onSelected) primary = <Button variant="primary" busy={pkg.busy === "run"} disabled={!!pkg.busy} onClick={() => void start("adapt_to_site", "run")}>Build revised package</Button>;
    else if (!candidatesCurrent) primary = <Button variant="primary" busy={pkg.busy === "run"} disabled={!canRun || !!pkg.busy} onClick={() => void start("adapt_to_site", "run")}>{!routes.length ? "Generate route alternatives" : selectedId ? "Regenerate routes to switch" : "Regenerate routes"}</Button>;
    else if (!focus) primary = <Button variant="primary" busy={pkg.busy === "run"} disabled={!canRun || !!pkg.busy} onClick={() => void start("adapt_to_site", "run")}>Regenerate routes</Button>;
    else primary = <Button variant="primary" busy={pkg.busy === "select"} disabled={!!pkg.busy || focus.centerlineDeltaM === null} onClick={() => void choose(focus.plan.id)}>{focus.centerlineDeltaM === null ? `Route ${focus.letter} needs a measurement` : selectedId ? `Switch to Route ${focus.letter}` : `Use Route ${focus.letter}`}</Button>;
  }

  const title = mode === "adapt" ? "Adapt to site conditions" : "Prepare from a drawing";
  const d = s.sourceDrawing;
  const crumbs = <><button type="button" className="fa-crumb" onClick={onHome}>{s.projectId}</button><span>/</span><span className="fa-crumb-current">{s.title}</span></>;
  const right = <><label className="fa-unit"><span className="sr-only">Units</span><select value={unit} onChange={e => setUnit(e.target.value as Unit)}><option value="in">ft-in</option><option value="mm">mm</option></select></label>
    <Button onClick={() => setAskOpen(true)} aria-expanded={askOpen}><Icon name="ask" size={16} /><span className="fa-hide-sm">Ask Sprink</span></Button>
    <Button onClick={() => setExportOpen(true)}><Icon name="download" size={16} />Export</Button></>;

  const common = { s, act: pkg.act, busy: pkg.busy, unit, setNotice: pkg.setNotice };
  const baseCallouts = baseline ? calloutsFor(baseline) : callouts(null);
  const workCallouts = workPlan ? calloutsFor(workPlan) : callouts(null);

  const panel = (() => {
    switch (activeTab) {
      case "inputs": return <>
        <MissingList reqs={reqs} />
        <Section title="Drawing" defaultOpen={!s.sourceDrawing || s.sourceDrawing.scale.basis !== "confirmed_inputs"}><DrawingInputs {...common} /></Section>
        <Section title="Run and work area" defaultOpen={baseline?.confirmation !== "confirmed"}><RunEditor {...common} callouts={baseCallouts} /></Section>
        <DetailingInputs {...common} callouts={baseCallouts} />
      </>;
      case "site": return <>
        <MissingList reqs={reqs} />
        <Section title="Site condition" defaultOpen={!s.changeRequest}><ChangeInputs {...common} callouts={baseCallouts} /></Section>
        <Section title="Measured obstacle (duct box)" defaultOpen={!readBox(s, "duct").confirmed}><BoxInputs {...common} prefix="duct" title="Obstacle" help="Faces of the duct box in the run's frame." /></Section>
        <Section title="Work boundary" defaultOpen={!readBox(s, "workEnvelope").confirmed}><BoxInputs {...common} prefix="workEnvelope" title="Work boundary" help="Where new pipe may go." /></Section>
        <Section title="Clearance"><ClearanceInput {...common} /></Section>
        <Section title="Photos" count={s.siteFacts.filter(f => f.field.startsWith("evidence.photo")).length}><EvidenceInputs {...common} /></Section>
        <Section title="Existing run and drawing" defaultOpen={!baseline}>
          <DrawingInputs {...common} />
          <RunEditor {...common} callouts={baseCallouts} />
        </Section>
        <DetailingInputs {...common} callouts={baseCallouts} />
      </>;
      case "materials": return <MaterialsCuts result={base.result} current={base.current} revision={s.inputRevision} plan={baseline} callouts={baseCallouts} detail={detailFor(baseline?.id)} selectedPiece={piece} onSelectPiece={setPiece} sources={sources} />;
      case "assembly": return <Assembly result={base.result} callouts={baseCallouts} sources={sources} selectedPiece={piece} onSelectPiece={setPiece} />;
      case "checks": return <Checks result={workResult} sources={sources} callouts={workCallouts} />;
      case "routes": return <RouteComparison routes={routes} baseline={baseline} baselineResult={base.result} focusId={focusId} selectedId={selectedId} current={candidatesCurrent} appliedAt={selectedId && selectedResult.current ? s.inputRevision : null}
        rejected={s.outputs.candidates?.rejected ?? []} searchDescription={s.outputs.candidates?.searchDescription ?? null}
        noneReason={s.outputs.candidates && !routes.length ? [...s.outputs.candidates.gaps.map(g => g.reason), ...s.outputs.candidates.rejected.map(r => r.reason)].filter((v, i, a) => a.indexOf(v) === i).join(" ") || null : null}
        onPreview={id => { setPreview(id); setPiece(null); }} onRegenerate={() => void start("adapt_to_site", "run")} onShowPackage={() => setTab("package")} busy={pkg.busy === "run"}
        clearanceMissing={!isConfirmed(findFact(s, "requiredPipeClearance"))} sources={sources} />;
      case "package": {
        if (!routes.length && !selectedId) return <div className="fa-empty"><p>No routes yet.</p><small>Generate route alternatives, choose one, and the revised package with its full quantities and change from the original appears here.</small></div>;
        const shown = focus ?? selected;
        const isSelected = !!shown && shown.plan.id === selectedId;
        const res = isSelected ? selectedResult : { result: shown?.result, current: candidatesCurrent };
        return <>
          {isSelected
            ? (selectedResult.current && detailCurrent ? <Callout tone="blue" title={`Revised package for Route ${shown!.letter}`}>Selected by you. Quantities and cuts below are current for rev {s.inputRevision}.</Callout>
              : <Callout title={`Build the revised package for Route ${shown!.letter}`} action={<Button variant="primary" disabled={running || !!pkg.busy} busy={pkg.busy === "run"} onClick={() => void start("adapt_to_site", "run")}>Build</Button>}>Your selection is saved. Build to get the revised quantities and the change from the original.</Callout>)
            : <Callout tone="neutral" title={`Preview of Route ${shown?.letter ?? ""}`}>Not selected. Choose this route to build its revised package and the change from the original.</Callout>}
          {isSelected && <PackageDelta detail={detailCurrent ? detailFor(selectedId!) : undefined} callouts={workCallouts} baselineResult={base.result} />}
          <MaterialsCuts result={res.result} current={res.current} revision={s.inputRevision} plan={shown?.plan ?? null} callouts={workCallouts} detail={detailFor(shown?.plan.id)} selectedPiece={piece} onSelectPiece={setPiece} sources={sources} label={isSelected ? "Full revised quantities" : "Route quantities"} />
          <Section title="Assembly" defaultOpen={false}><Assembly result={res.result} callouts={workCallouts} sources={sources} selectedPiece={piece} onSelectPiece={setPiece} /></Section>
        </>;
      }
    }
  })();

  return <>
    {header(right, crumbs)}
    <div className="fa-work">
      <nav className="fa-rail" aria-label="Tools">
        <button type="button" onClick={onHome} title="All packages" aria-label="All packages"><Icon name="home" /></button>
        <button type="button" className={tool === "select" && view === "plan" ? "is-on" : ""} onClick={() => { setTool("select"); setView("plan"); }} title="Select" aria-label="Select"><Icon name="select" /></button>
        <button type="button" className={tool === "pan" && view === "plan" ? "is-on" : ""} onClick={() => { setTool("pan"); setView("plan"); }} title="Pan" aria-label="Pan"><Icon name="pan" /></button>
        <button type="button" className={view === "drawing" ? "is-on" : ""} onClick={() => setView(view === "drawing" ? "plan" : "drawing")} title="Source drawing" aria-label="Source drawing" disabled={!d}><Icon name="drawing" /></button>
        <button type="button" className={askOpen ? "is-on" : ""} onClick={() => setAskOpen(!askOpen)} title="Ask Sprink" aria-label="Ask Sprink"><Icon name="ask" /></button>
        <span className="fa-rail-gap" />
        <button type="button" onClick={() => void pkg.reload()} title="Reload" aria-label="Reload"><Icon name="refresh" /></button>
      </nav>
      <main className="fa-main">
        <div className="fa-titlebar">
          <div>
            <h1>{title}</h1>
            <p className="fa-subline">{d ? <><span className="mono">{d.drawingId}</span> · Rev {d.revision} · p{d.page}</> : "No drawing yet"}<span className="sep">|</span>{s.title}<span className="sep">|</span>Rev {s.inputRevision} inputs</p>
          </div>
          <div className="fa-chips-row">
            {sample && <Badge tone="sample" title="Contains invented sample confirmations">Sample data</Badge>}
            {mode === "prepare" ? (base.result ? <Freshness current={base.current} revision={s.inputRevision} resultRevision={base.result.inputRevision} /> : <Badge>Not generated</Badge>)
              : selected ? <Badge tone="blue">Route {selected.letter} selected by you</Badge> : routes.length ? <Badge>{routes.length} route{routes.length > 1 ? "s" : ""} generated</Badge> : <Badge>No routes yet</Badge>}
            <Badge title="The server reports construction approval as not assessed">Not construction approved</Badge>
          </div>
        </div>
        {mode === "adapt" && baseline && <Callout tone="neutral" title={`Active interval: ${s.changeRequest?.affectedEntityIds.join(", ") || "not selected"}`}>
          Full quantities and delta cover this interval. Other drawing elements are retained context, not purchase items. Scope interfaces do not establish physical joints. Context clearance, closure, supports and hydraulics remain unresolved.
          {frameError && <p>{frameError}</p>}
        </Callout>}
        <RunBanner s={s} busy={pkg.busy} onCancel={() => run && void pkg.act("cancel", cur => api.cancel(cur.id, run.id))} />
        {pkg.error && <div className="fa-toast tone-red" role="alert"><Icon name="alert" size={16} />{pkg.error}<button type="button" onClick={pkg.clearError} aria-label="Dismiss"><Icon name="x" size={14} /></button></div>}
        {pkg.notice && <div className="fa-toast tone-blue" role="status">{pkg.notice}<button type="button" onClick={() => pkg.setNotice("")} aria-label="Dismiss"><Icon name="x" size={14} /></button></div>}
        {openRequests.map(r => <RequestCallout key={r.id} s={s} request={r} act={pkg.act} busy={pkg.busy} onGoToInputs={() => setTab(mode === "prepare" ? "inputs" : "site")} />)}
        <div className="fa-stage">
          {view === "drawing" && d ? <DrawingView s={s} /> :
            <PlanCanvas mode={mode} baseline={baseline} routes={mode === "adapt" ? routes : []} staleRoutes={!candidatesCurrent && !(selectedId && selectedResult.current)} focusRouteId={focusId} selectedRouteId={selectedId} duct={frameError ? null : duct} envelope={frameError ? null : envelope} boxToDrawing={toDrawing}
              affectedIds={s.changeRequest?.affectedEntityIds ?? []} cuts={cuts} calloutsFor={calloutsFor} selectedPiece={piece} onSelectPiece={p => { setPiece(p); if (p) { setTab(mode === "prepare" ? "materials" : "package"); setSheetOpen(true); } }}
              onSelectRoute={id => { setPreview(id); setTab("routes"); }} tool={tool}
              empty={<div className="fa-empty big"><Icon name="layers" size={32} /><p>{mode === "adapt" ? "Enter the existing run and what you measured on site." : "Upload a drawing and enter the run to prepare."}</p>
                <small>Everything you enter is saved to this work package on the server.</small>
                <div className="fa-actions center"><Button variant="primary" onClick={() => { setTab(mode === "prepare" ? "inputs" : "site"); setSheetOpen(true); }}>Start with inputs</Button>
                  <Button busy={pkg.busy === "sample"} disabled={!!pkg.busy || !!s.baselinePlan} onClick={() => void loadSample()}>Load sample input</Button></div>
                <small className="fa-sample-note">Sample input is invented demo data and is marked Sample everywhere it appears.</small></div>} />}
        </div>
      </main>
      <aside className={`fa-panel ${sheetOpen ? "is-open" : ""}`} aria-label="Details">
        <button type="button" className="fa-sheet-handle" onClick={() => setSheetOpen(!sheetOpen)} aria-expanded={sheetOpen}><span />{TABS[mode].find(t => t[0] === activeTab)?.[1]}</button>
        <div className="fa-panel-head">
          <h2>{mode === "adapt" ? "Site condition" : "Run"}<span className="fa-muted"> · {baseline ? `${baseline.entities.filter(e => e.kind === "pipe").length} piece run` : "not entered"}</span></h2>
          <div className="fa-tabs" role="tablist">{TABS[mode].map(([k, label]) => <button key={k} role="tab" type="button" aria-selected={activeTab === k} className={activeTab === k ? "is-on" : ""} onClick={() => setTab(k)}>
            {label}{k === "inputs" || k === "site" ? missing.length > 0 && <span className="fa-dot">{missing.length}</span> : null}
          </button>)}</div>
        </div>
        <div className="fa-panel-body">{panel}</div>
        <div className="fa-panel-foot">
          <div className="fa-foot-row">
            <span className="fa-foot-label">{mode === "adapt" ? "Route selection" : "Package"}</span>
            {mode === "adapt" && selectedId && <Button variant="quiet" busy={pkg.busy === "clear"} disabled={!!pkg.busy || running} onClick={() => void clearSelection()}>Clear selection</Button>}
          </div>
          {!canRun && !running && <p className="fa-warn small">Before generating: {blockers[0]}{blockers.length > 1 ? ` (+${blockers.length - 1} more)` : ""}</p>}
          {canRun && missing.length > 0 && !running && <p className="fa-warn small">{missing.length} input{missing.length > 1 ? "s" : ""} not confirmed. Those values will come back as Unknown.</p>}
          {primary}
          <p className="fa-fine">{fine} Updated {dateTime(s.updatedAt)}.</p>
        </div>
      </aside>
    </div>
    {askOpen && <AskPanel s={s} selectedPiece={piece} onClose={() => setAskOpen(false)} />}
    {exportOpen && <ExportDialog s={s} artifacts={artifactsCurrent} ready={mode === "prepare" ? !!base.result && base.current : !!selectedId && selectedResult.current} busy={pkg.busy} running={running}
      onCreate={() => void start("export_selected_package", "export")} onClose={() => setExportOpen(false)} />}
  </>;
}

function MissingList({ reqs }: { reqs: ReturnType<typeof requirements> }) {
  const open = reqs.filter(r => !r.done);
  if (!open.length) return <Callout tone="blue" title="All inputs are entered">Generate to get current results. The server may still report items it cannot decide.</Callout>;
  const groups = [...new Set(open.map(r => r.group))];
  return <Callout title={`${open.length} input${open.length > 1 ? "s" : ""} still needed`}>
    <ul className="fa-missing">{groups.map(g => <li key={g}><b>{g}:</b> {open.filter(r => r.group === g).map(r => r.label).join("; ")}</li>)}</ul>
  </Callout>;
}

function RunBanner({ s, busy, onCancel }: { s: Snapshot; busy: string; onCancel: () => void }) {
  const run = s.run;
  if (!run) return null;
  const current = run.inputRevision === s.inputRevision;
  if (run.status === "running") return <div className="fa-runbar"><span className="fa-spinner" /><span><b>{goalLabel(run.goal)}</b> {run.progress}</span><Button variant="quiet" busy={busy === "cancel"} onClick={onCancel}>Cancel</Button></div>;
  if (!current || run.status === "completed" || run.status === "waiting_input") return null;
  const tone = run.status === "blocked" ? "amber" : "red";
  const reason = run.stopReason === "runner_failed" ? "The server stopped without saying why (runner_failed). Check the inputs listed under Inputs, then try again." : run.stopReason ?? run.progress;
  return <div className={`fa-toast tone-${tone}`} role="status"><Icon name="alert" size={16} /><span><b>{goalLabel(run.goal)} {run.status}.</b> {reason}</span></div>;
}
const goalLabel = (g: string) => g === "export_selected_package" ? "Export" : g === "adapt_to_site" ? "Route generation" : "Preparation";

function RequestCallout({ s, request, act, busy, onGoToInputs }: { s: Snapshot; request: Snapshot["outputs"]["requests"][number]; act: ReturnType<typeof usePackage>["act"]; busy: string; onGoToInputs: () => void }) {
  const [reason, setReason] = useState("");
  const key = `answer-${request.id}`;
  return <div className="fa-request">
    <Callout title="The server needs an answer" action={<Button variant="quiet" onClick={onGoToInputs}>Enter it in inputs</Button>}>
      <p>{request.question}</p>
      <div className="fa-fact-edit">
        <input value={reason} onChange={e => setReason(e.target.value)} placeholder="If you cannot provide it, say why" aria-label="Reason it is unavailable" />
        <Button busy={busy === key} disabled={!!busy || !reason.trim()} onClick={() => void act(key, cur => api.answer(cur.id, cur.inputRevision, request.id, null, reason.trim()))}>Mark unavailable</Button>
      </div>
    </Callout>
    <span className="sr-only">Request for revision {s.inputRevision}</span>
  </div>;
}

function DrawingView({ s }: { s: Snapshot }) {
  const d = s.sourceDrawing!;
  const [url, setUrl] = useState<{ href: string; type: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let made: string | null = null, live = true;
    api.asset(s.id, d.assetId).then(b => { if (live) { made = URL.createObjectURL(b); setUrl({ href: made, type: b.type }); } }).catch(e => setError(e instanceof Error ? e.message : "Could not load the drawing"));
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [s.id, d.assetId]);
  return <div className="fa-drawing">
    <div className="fa-drawing-bar"><b className="mono">{d.drawingId}</b> Rev {d.revision} · page {d.page}<span className="fa-muted">Shown separately from the plan. The package has no alignment between sheet and plan coordinates.</span></div>
    {error ? <Callout tone="red" title="Could not load the drawing">{error}</Callout> : !url ? <Spinner label="Loading drawing…" /> :
      url.type === "application/pdf" ? <object data={`${url.href}#page=${d.page}`} type="application/pdf" aria-label="Source drawing PDF"><a href={url.href} target="_blank" rel="noreferrer">Open the PDF</a></object> : <img src={url.href} alt={`Drawing ${d.drawingId}`} />}
  </div>;
}

const ARTIFACT_LABEL: Record<string, [string, string]> = { pdf: ["Work package PDF", "pdf"], bom_csv: ["Materials CSV", "csv"], cut_csv: ["Cut list CSV", "csv"], manifest: ["Manifest", "json"] };

function ExportDialog({ s, artifacts, ready, busy, running, onCreate, onClose }: { s: Snapshot; artifacts: Snapshot["outputs"]["artifacts"]; ready: boolean; busy: string; running: boolean; onCreate: () => void; onClose: () => void }) {
  const [downloading, setDownloading] = useState("");
  const [error, setError] = useState("");
  const download = async (a: Snapshot["outputs"]["artifacts"][number]) => {
    setDownloading(a.id); setError("");
    try {
      const blob = await api.artifact(s.id, a.id);
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href; link.download = `${s.title.replace(/[^a-zA-Z0-9_-]+/g, "-")}-rev${a.inputRevision}-${a.kind}.${ARTIFACT_LABEL[a.kind]?.[1] ?? "bin"}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 5000);
    } catch (e) { setError(e instanceof Error ? e.message : "Download failed"); } finally { setDownloading(""); }
  };
  return <div className="fa-modal" role="dialog" aria-modal="true" aria-label="Export" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="fa-modal-card">
      <div className="fa-modal-head"><h2>Export</h2><button type="button" className="fa-icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
      <p className="fa-muted">Exports are bound to one input revision and the {s.intent === "adapt_to_site" ? "selected route" : "prepared run"}. They are made by the server's exporter (the same bundle as the export API).</p>
      {artifacts.length > 0 ? <ul className="fa-downloads">{artifacts.map(a => <li key={a.id}>
        <div><strong>{ARTIFACT_LABEL[a.kind]?.[0] ?? a.kind}</strong><small>Rev {a.inputRevision}</small></div>
        <Button busy={downloading === a.id} onClick={() => void download(a)}><Icon name="download" size={14} />Download</Button>
      </li>)}</ul> : !ready ? <Callout title="Nothing to export yet">{s.intent === "adapt_to_site" ? "Choose a route and build the revised package first." : "Generate current materials and cuts first."}</Callout>
        : <Callout tone="neutral" title={`No export for rev ${s.inputRevision} yet`}>Create one to get the PDF, materials CSV and cut list CSV for these inputs.</Callout>}
      {error && <Callout tone="red" title="Download failed">{error}</Callout>}
      <div className="fa-actions end">
        <Button onClick={onClose}>Close</Button>
        {ready && artifacts.length === 0 && <Button variant="primary" busy={busy === "export" || running} onClick={onCreate}>Create export for rev {s.inputRevision}</Button>}
      </div>
    </div>
  </div>;
}
