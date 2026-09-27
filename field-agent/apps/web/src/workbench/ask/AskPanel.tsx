import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Snapshot } from "../api.js";
import { Badge, Button, Callout, Icon, Spinner } from "../ui.js";
import { askApi, type AskAnswer, type AskRequest, type Citation, type FollowUp, type Origin, type SectionView, type SourceDocument } from "./askApi.js";
import { Library } from "./Library.js";

/**
 * Ask Sprink: a question panel beside the drawing workspace.
 * Everything shown comes from the server: retrieved passages, notes, script results. The panel
 * keeps source wording, Sprink's notes and calculations visually separate.
 */
const SUGGESTED = [
  "A duct is blocking this branch. What rules do I need to check before changing the route?",
  "Will the pipe clear the duct if I drop it 600 mm?",
  "What cut length do I need for 2400 mm center to center?",
];
const MEASURE_FIELDS: Array<{ name: string; label: string; unit: string }> = [
  { name: "obstructionWidth", label: "Duct width along the pipe", unit: "mm" },
  { name: "addedFittings", label: "Fittings the new route adds", unit: "count" },
  { name: "verticalOffset", label: "Vertical move (− is down)", unit: "mm" },
  { name: "centerToCenter", label: "Center to center", unit: "mm" },
];
const ORIGIN_LABEL: Record<Origin, string> = { project: "Project", sample: "Sample", you: "You", derived: "Derived", catalog: "Catalog", document: "Document" };
const ROLE_LABEL: Record<string, string> = {
  main: "Matched", amendment: "Amendment", exception: "Exception", referenced: "Referenced", footnote: "Note", related: "Related", definition: "Definition", commentary: "Explanatory",
};

export function AskPanel({ s, selectedPiece, onClose }: { s: Snapshot; selectedPiece: string | null; onClose: () => void }) {
  const [tab, setTab] = useState<"ask" | "library">("ask");
  const [question, setQuestion] = useState("");
  const [measurements, setMeasurements] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<AskRequest["answers"]>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [viewing, setViewing] = useState<Citation | null>(null);
  const [docs, setDocs] = useState<SourceDocument[] | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const refreshDocs = () => askApi.documents().then(r => setDocs(r.documents)).catch(() => setDocs([]));
  useEffect(() => { void refreshDocs(); input.current?.focus(); }, []);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);

  const run = async (q = question, extra: { answers?: AskRequest["answers"]; measurements?: Record<string, string> } = {}) => {
    if (!q.trim()) return;
    setBusy(true); setError("");
    const m = extra.measurements ?? measurements;
    const list = MEASURE_FIELDS.filter(f => m[f.name]?.trim()).map(f => ({ name: f.name, value: Number(m[f.name]), unit: f.unit }));
    try {
      const a = await askApi.ask({ question: q, packageId: s.id, selectedElementId: selectedPiece ?? undefined, measurements: list, answers: extra.answers ?? answers });
      setAnswer(a);
      const first = a.sources.find(x => x.role === "main");
      setViewing(v => (v && a.sources.some(x => x.key === v.key)) ? v : first ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : "The question could not be answered"); }
    finally { setBusy(false); }
  };
  const answerFollowUp = (f: FollowUp, value: string) => {
    if (f.kind === "choice") { const next = { ...answers, [f.field]: value }; setAnswers(next); void run(answer?.question ?? question, { answers: next }); }
    else { const next = { ...measurements, [f.field]: value }; setMeasurements(next); void run(answer?.question ?? question, { measurements: next }); }
  };
  const selectionMoved = !!answer && (selectedPiece ?? null) !== null && answer.context.selectedElementId !== selectedPiece
    && !answer.context.facts.some(f => f.name === "selectionNote");
  const noLibrary = docs !== null && docs.length === 0;

  return <div className="fa-ask" role="dialog" aria-label="Ask Sprink">
    <div className="fa-ask-col">
      <div className="fa-ask-head">
        <h2>Ask Sprink</h2>
        <div className="fa-seg" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "ask"} className={tab === "ask" ? "is-on" : ""} onClick={() => setTab("ask")}>Ask</button>
          <button type="button" role="tab" aria-selected={tab === "library"} className={tab === "library" ? "is-on" : ""} onClick={() => setTab("library")}>Library{docs ? ` (${docs.length})` : ""}</button>
        </div>
        <button type="button" className="fa-icon-btn" onClick={onClose} aria-label="Close Ask Sprink"><Icon name="x" /></button>
      </div>
      {tab === "library" ? <Library s={s} docs={docs} onChanged={refreshDocs} /> : <div className="fa-ask-body">
        <ContextStrip s={s} answer={answer} selectedPiece={selectedPiece} />
        {noLibrary && <Callout tone="neutral" title="The source library is empty" action={<Button variant="quiet" onClick={() => setTab("library")}>Open library</Button>}>Import authorized documents or load the labelled demonstration set.</Callout>}
        <form className="fa-ask-form" onSubmit={e => { e.preventDefault(); void run(); }}>
          <label className="sr-only" htmlFor="ask-q">Question</label>
          <textarea id="ask-q" ref={input} rows={2} value={question} placeholder="Ask about a rule, a measurement or this site condition" onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void run(); } }} />
          <Button variant="primary" busy={busy} disabled={!question.trim()} onClick={() => void run()}>Ask</Button>
        </form>
        {!answer && <div className="fa-ask-suggest">{SUGGESTED.map(q => <button key={q} type="button" onClick={() => { setQuestion(q); void run(q); }}>{q}</button>)}</div>}
        <details className="fa-ask-measure">
          <summary>Measurements you add{Object.values(measurements).filter(Boolean).length ? ` (${Object.values(measurements).filter(Boolean).length})` : ""}</summary>
          <div className="fa-ask-measure-grid">{MEASURE_FIELDS.map(f => <label key={f.name}><span>{f.label}</span>
            <span className="fa-ask-unit"><input inputMode="decimal" value={measurements[f.name] ?? ""} onChange={e => setMeasurements({ ...measurements, [f.name]: e.target.value })} /><small>{f.unit}</small></span></label>)}</div>
          <small className="fa-muted">Used for this question only. They are not saved to the work package.</small>
        </details>
        {error && <Callout tone="red" title="Could not answer">{error}</Callout>}
        {busy && !answer && <Spinner label="Searching the project library…" />}
        {answer && <Answer a={answer} viewing={viewing} onView={setViewing} onFollowUp={answerFollowUp} busy={busy} stale={selectionMoved} onAskAgain={() => void run(answer.question)} />}
      </div>}
    </div>
    <SourceViewer citation={viewing} onClose={() => setViewing(null)} />
  </div>;
}

function ContextStrip({ s, answer, selectedPiece }: { s: Snapshot; answer: AskAnswer | null; selectedPiece: string | null }) {
  const c = answer?.context;
  const edition = c ? (c.edition.value ? `NFPA 13 ${c.edition.value}` : "Edition unknown") : null;
  return <div className="fa-ask-context" aria-label="Question context">
    <span><b>Project</b> {s.projectId}</span>
    {edition && <span className={c!.edition.value ? "" : "fa-warn"} title={c!.edition.reason}><b>Edition</b> {edition}{c!.edition.status === "answered" ? " (your answer)" : c!.edition.status === "resolved" ? " (from permit facts)" : ""}</span>}
    {c?.jurisdiction && <span><b>Jurisdiction</b> {c.jurisdiction.replace(/_/g, " ")}</span>}
    <span><b>Piece</b> {c?.selectedElementId ?? selectedPiece ?? s.changeRequest?.affectedEntityIds[0] ?? "none"}</span>
    {s.changeRequest && <span title={s.changeRequest.description}><b>Site</b> {s.changeRequest.description}</span>}
  </div>;
}

function Answer({ a, viewing, onView, onFollowUp, busy, stale, onAskAgain }: { a: AskAnswer; viewing: Citation | null; onView: (c: Citation) => void; onFollowUp: (f: FollowUp, v: string) => void; busy: boolean; stale: boolean; onAskAgain: () => void }) {
  const byKey = new Map(a.sources.map(s => [s.key, s]));
  const demo = a.sources.some(s => s.demonstration);
  const cite = (key: string) => { const c = byKey.get(key); return c ? <button key={key} type="button" className={`fa-cite ${viewing?.key === key ? "is-on" : ""}`} onClick={() => onView(c)} title={`${c.docTitle}, ${c.edition}, p${c.pageStart ?? "?"}`}>{c.sectionId}</button> : null; };
  return <div className="fa-answer" aria-busy={busy}>
    <p className="fa-answer-q">{a.question}</p>
    {stale && <p className="fa-warn small">This answer was for piece {a.context.selectedElementId}. The selection has changed. <button type="button" className="fa-link" onClick={onAskAgain}>Ask again</button></p>}
    <div className="fa-answer-status">
      <Badge tone={a.status === "no_source" ? "amber" : a.status === "needs_input" ? "amber" : "neutral"}>{{ answered: "From the library", needs_input: "Needs your input", no_source: "No source found", calculation_only: "Calculation" }[a.status]}</Badge>
      <small className="fa-muted">{a.classification.kind === "both" ? "Source lookup and calculation" : a.classification.kind === "calculation" ? "Calculation" : "Source lookup"} · {a.timings.totalMs} ms</small>
    </div>
    <p className="fa-answer-summary">{a.summary}</p>
    {demo && <p className="fa-demo-note"><Icon name="alert" size={14} />Answered from demonstration documents. Their text is invented for testing and is not code text.</p>}

    {a.followUps.length > 0 && <Block title="Needed to answer">
      {a.followUps.map(f => <FollowUpRow key={f.id} f={f} busy={busy} onAnswer={v => onFollowUp(f, v)} />)}
    </Block>}

    {a.explanation.length > 0 && <Block title="What applies" aside="Sprink notes: interpretation, check the source wording">
      <ul className="fa-claims">{a.explanation.map(c => <li key={c.id}>{c.kind === "pointer" ? <span className="fa-muted">{c.text}</span> : c.text} <span className="fa-cites">{c.citations.map(cite)}</span></li>)}</ul>
    </Block>}
    {a.unresolved.length > 0 && <Block title="Unresolved statements" aside="Not supported by the cited passage">
      <ul className="fa-claims is-unresolved">{a.unresolved.map(c => <li key={c.id}><s>{c.text}</s> <small>{c.reason}</small></li>)}</ul>
    </Block>}

    {a.exceptions.length > 0 && <Block title="Conditions that affect this">
      {a.exceptions.map(e => <div key={e.key} className="fa-cond">
        <div className="fa-cond-head">{cite(e.key)}<Badge tone={e.status === "applies" ? "blue" : e.status === "unknown" ? "amber" : "neutral"}>{e.status === "applies" ? "Appears to apply" : e.status === "unknown" ? "Unknown" : "Does not appear to apply"}</Badge></div>
        {e.checks.length > 0 && <table className="fa-mini"><tbody>{e.checks.map(c => <tr key={c.name}>
          <td>{c.question}</td>
          <td className="mono">{c.value === null ? <span className="fa-warn">Unknown</span> : `${c.value} ${c.unit === "count" ? "" : c.unit}`}</td>
          <td>{c.origin ? <Origin o={c.origin} detail={c.detail} /> : null}</td>
          <td className="mono fa-muted">{c.op} {c.limit}</td>
        </tr>)}</tbody></table>}
        <small className="fa-muted">{e.note}</small>
      </div>)}
    </Block>}

    {a.conflicts.length > 0 && <Block title="Sources disagree">
      {a.conflicts.map(c => <div key={c.topic} className="fa-conflict">
        <ul>{c.items.map(i => <li key={i.key}>{cite(i.key)} {i.position}</li>)}</ul>
        <small>{c.resolution}</small>
      </div>)}
    </Block>}

    {a.missing.length > 0 && a.followUps.length === 0 && <Block title="Missing information"><ul className="fa-plain">{a.missing.map(m => <li key={m}>{m}</li>)}</ul></Block>}
    {a.missing.length > 0 && a.followUps.length > 0 && <ul className="fa-plain small fa-muted">{a.missing.map(m => <li key={m}>{m}</li>)}</ul>}

    {a.calculation && <CalculationBlock c={a.calculation} />}

    {a.sources.length > 0 && <Block title="Source references" aside={`${a.sources.length}`}>
      <ul className="fa-refs">{a.sources.map(s => <SourceRow key={s.key} c={s} on={viewing?.key === s.key} onOpen={() => onView(s)} />)}</ul>
    </Block>}
    {a.excluded.length > 0 && <details className="fa-ask-excluded"><summary>Not used ({a.excluded.length})</summary>
      <ul className="fa-plain small">{a.excluded.map(e => <li key={e.docId}><b>{e.title} {e.edition}</b>: {e.reason}</li>)}</ul></details>}
    <details className="fa-ask-excluded"><summary>Facts used ({a.context.facts.length})</summary>
      <table className="fa-mini"><tbody>{a.context.facts.map((f, i) => <tr key={`${f.name}-${i}`}><td>{f.label}</td><td className="mono">{String(f.value ?? "Unknown")}{f.unit && f.unit !== "count" ? ` ${f.unit}` : ""}</td><td><Origin o={f.origin} detail={f.detail} /></td></tr>)}</tbody></table>
      <small className="fa-muted">Edition: {a.context.edition.reason}{a.context.edition.script ? ` Script: ${a.context.edition.script}.` : ""}</small>
    </details>
  </div>;
}

function FollowUpRow({ f, busy, onAnswer }: { f: FollowUp; busy: boolean; onAnswer: (v: string) => void }) {
  const [v, setV] = useState("");
  return <div className="fa-followup">
    <p>{f.question}</p>
    {f.kind === "choice"
      ? <div className="fa-actions">{f.options?.map(o => <Button key={o.value} disabled={busy} onClick={() => onAnswer(o.value)}>{o.label}</Button>)}</div>
      : <form className="fa-actions" onSubmit={e => { e.preventDefault(); if (v.trim()) onAnswer(v.trim()); }}>
        <span className="fa-ask-unit"><input inputMode="decimal" value={v} onChange={e => setV(e.target.value)} aria-label={f.question} /><small>{f.unit === "count" ? "" : f.unit}</small></span>
        <Button disabled={busy || !v.trim() || !Number.isFinite(Number(v))} onClick={() => onAnswer(v.trim())}>Use</Button>
      </form>}
  </div>;
}

function CalculationBlock({ c }: { c: NonNullable<AskAnswer["calculation"]> }) {
  return <Block title={`Calculation: ${c.title}`}>
    <div className="fa-calc">
      {c.status === "ok"
        ? <dl className="fa-calc-out">{c.outputs.map(o => <div key={o.name}><dt>{o.label}</dt><dd className={typeof o.value === "number" ? "mono" : ""}>{o.value}{o.unit ? ` ${o.unit}` : ""}</dd></div>)}</dl>
        : <Callout tone="amber" title={c.status === "missing_inputs" ? "Missing inputs" : c.status === "out_of_scope" ? "Outside what the script supports" : "Input rejected"}>{c.message}{c.missing.length ? ` ${c.missing.join("; ")}.` : ""}</Callout>}
      {c.inputs.length > 0 && <table className="fa-mini"><thead><tr><th>Input</th><th>Value</th><th>From</th></tr></thead>
        <tbody>{c.inputs.map(i => <tr key={i.name}><td>{i.label}</td><td className="mono">{String(i.value)}{i.unit ? ` ${i.unit}` : ""}</td><td><Origin o={i.origin} detail={i.detail} /></td></tr>)}</tbody></table>}
      <small className="fa-muted">Script <span className="mono">{c.script.fn}</span> ({c.script.module}) <span className="mono">{c.script.version}</span></small>
      {c.limits && <small>{c.limits}</small>}
    </div>
  </Block>;
}

function SourceRow({ c, on, onOpen }: { c: Citation; on: boolean; onOpen: () => void }) {
  return <li className={on ? "is-on" : ""}>
    <details>
      <summary>
        <span className="fa-ref-id mono">{c.sectionId}</span>
        <span className="fa-ref-title">{c.heading}</span>
        <span className="fa-ref-meta">{ROLE_LABEL[c.role] ?? c.role} · {c.label}</span>
      </summary>
      <div className="fa-ref-body">
        <p className="fa-ref-doc">{c.docTitle} · {c.edition} · {c.typeLabel} · {pages(c)}{c.demonstration && <> · <Badge tone="sample">Demonstration</Badge></>}</p>
        {c.flags.map(f => <p key={f.flag} className="fa-warn small"><Icon name="alert" size={13} /> {f.label}</p>)}
        <SourceWording c={c} />
      </div>
    </details>
    <Button variant="quiet" onClick={onOpen}>Open source</Button>
  </li>;
}

function SourceWording({ c }: { c: Pick<Citation, "quote" | "quoteNote" | "table"> }) {
  return <>
    {c.table ? <Table rows={c.table} /> : c.quote ? <blockquote className="fa-wording">{c.quote}</blockquote> : null}
    {c.quoteNote && <small className="fa-muted">{c.quoteNote}</small>}
  </>;
}
function Table({ rows }: { rows: string[][] }) {
  const [head, ...body] = rows;
  return <table className="fa-mini fa-wording-table"><thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead><tbody>{body.map((r, i) => <tr key={i}>{r.map((x, j) => <td key={j}>{x}</td>)}</tr>)}</tbody></table>;
}

function SourceViewer({ citation, onClose }: { citation: Citation | null; onClose: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof askApi.passage>> | null>(null);
  const [error, setError] = useState("");
  const [original, setOriginal] = useState<string | null>(null);
  const target = useRef<HTMLElement | null>(null);
  useEffect(() => {
    setData(null); setError(""); setOriginal(null);
    if (!citation) return;
    let live = true;
    askApi.passage(citation.link).then(d => { if (live) setData(d); }).catch(e => live && setError(e instanceof Error ? e.message : "Could not open the passage"));
    return () => { live = false; };
  }, [citation?.link]);
  useEffect(() => { target.current?.scrollIntoView({ block: "center" }); }, [data]);
  if (!citation) return <aside className="fa-viewer is-empty"><div className="fa-empty"><Icon name="drawing" size={28} /><p>Source viewer</p><small>Open a source reference to read the passage in its document.</small></div></aside>;
  const doc = data?.document;
  return <aside className="fa-viewer" aria-label="Source viewer">
    <div className="fa-viewer-head">
      <div>
        <strong>{citation.docTitle}</strong>
        <small>{citation.publisher} · {citation.edition} · {citation.typeLabel}{citation.demonstration ? " · Demonstration text, not a real provision" : ""}</small>
      </div>
      <button type="button" className="fa-icon-btn" onClick={onClose} aria-label="Close source"><Icon name="x" /></button>
    </div>
    {error ? <Callout tone="red" title="Could not open the passage">{error}</Callout> : !data ? <Spinner label="Opening passage…" /> :
      <div className="fa-viewer-body">
        {original !== null ? <pre className="fa-original">{original}</pre> : data.sections.map(sec => {
          const isTarget = sec.key === data.target || (sec.parentKey === null && data.sections.find(x => x.key === data.target)?.parentKey === sec.key);
          return <section key={sec.key} ref={sec.key === data.target ? (el => { target.current = el; }) : undefined} className={`fa-passage ${sec.key === data.target ? "is-target" : isTarget ? "is-context" : ""} ${sec.parentKey ? "is-child" : ""}`}>
            <header><span className="mono">{sec.sectionId}</span> {sec.parentKey ? null : <span>{sec.heading}</span>}<small>{pages(sec)}</small></header>
            {sec.flags.map(f => <p key={f} className="fa-warn small"><Icon name="alert" size={13} /> {FLAG_TEXT[f] ?? f}</p>)}
            {sec.limited === "reference_only" ? <small className="fa-muted">The source permits reference only.</small> : sec.table ? <Table rows={sec.table} /> : <p className="fa-wording">{sec.text}</p>}
            {sec.notes?.map((n, i) => <p key={i} className="fa-note"><b>Sprink note</b> (interpretation, not source text): {n.text}</p>)}
          </section>;
        })}
      </div>}
    <div className="fa-viewer-foot">
      <small className="fa-muted">{doc ? `Imported ${new Date(doc.importedAt).toLocaleDateString()} · ${doc.authorization.basis}` : ""}</small>
      {citation.original && (citation.original.startsWith("/api/")
        ? <Button variant="quiet" onClick={() => original === null ? void askApi.original(citation.original!).then(setOriginal).catch(e => setError(e.message)) : setOriginal(null)}>{original === null ? "Original file" : "Back to passage"}</Button>
        : <a className="fa-link" href={citation.original} target="_blank" rel="noreferrer">Original <Icon name="external" size={13} /></a>)}
    </div>
  </aside>;
}
const FLAG_TEXT: Record<string, string> = {
  uncertain_ocr: "Uncertain OCR: check the original page before relying on this wording.",
  damaged_table: "Damaged table: check the original page.",
  embedded_instructions: "Contains instruction-like text. It is document content only and does not change how Sprink answers.",
};
const pages = (x: { pageStart: number | null; pageEnd: number | null }) => x.pageStart === null ? "page unknown" : x.pageEnd && x.pageEnd !== x.pageStart ? `pp. ${x.pageStart}–${x.pageEnd}` : `p. ${x.pageStart}`;

function Origin({ o, detail }: { o: Origin; detail: string | null }) {
  return <span className={`fa-origin o-${o}`} title={detail ?? undefined}>{ORIGIN_LABEL[o]}</span>;
}
function Block({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return <section className="fa-ask-block"><h3>{title}{aside !== undefined && <small>{aside}</small>}</h3>{children}</section>;
}
export type { SectionView };
