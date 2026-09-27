import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Snapshot } from "../api.js";
import { Badge, Button, Callout, Icon, Spinner } from "../ui.js";
import { askApi, authedBlobUrl, type AskAnswer, type AskRequest, type AttachmentView, type Citation, type FollowUp, type Origin, type SectionView, type SourceDocument, type UploadRecord } from "./askApi.js";
import { Library } from "./Library.js";
import type { PageFocus } from "./Review.js";
import { DropArea, FileButtons, MAX_MB, StatusBadge, isBusy, localPreview, sizeText, useAuthedUrl, useUploadPoll } from "./uploads.js";

/**
 * Ask Sprink: a question panel beside the drawing workspace.
 * Everything shown comes from the server: retrieved passages, notes, script results. The panel
 * keeps source wording and Sprink's notes visually separate.
 */
const SUGGESTED = [
  "A duct is blocking this branch. What rules do I need to check before changing the route?",
  "What clearance does the source require around a duct?",
  "What does the manual say about cutting this pipe?",
];
const MEASURE_FIELDS: Array<{ name: string; label: string; unit: string }> = [
  { name: "obstructionWidth", label: "Duct width along the pipe", unit: "mm" },
  { name: "addedFittings", label: "Fittings the new route adds", unit: "count" },
];
const ORIGIN_LABEL: Record<Origin, string> = { project: "Project", sample: "Sample", you: "You", derived: "Derived", catalog: "Catalog", document: "Document", photo: "Photo" };
const ROLE_LABEL: Record<string, string> = {
  main: "Matched", amendment: "Amendment", exception: "Exception", referenced: "Referenced", footnote: "Note", related: "Related", definition: "Definition", commentary: "Explanatory",
};

/** A file attached to the question: uploading, being read, ready, or failed (kept so it can be retried). */
interface Attachment { key: string; file: File | null; name: string; size: number; local: string | null; progress: number; record: UploadRecord | null; error: string }
const DRAFT_KEY = (id: string) => `sprink.ask.draft.${id}`;
interface Draft { question: string; measurements: Record<string, string>; attachmentIds: string[] }
const readDraft = (id: string): Draft | null => { try { const v = localStorage.getItem(DRAFT_KEY(id)); return v ? JSON.parse(v) : null; } catch { return null; } };
const writeDraft = (id: string, d: Draft) => { try { localStorage.setItem(DRAFT_KEY(id), JSON.stringify(d)); } catch { /* storage unavailable */ } };

export function AskPanel({ s, selectedPiece, onClose }: { s: Snapshot; selectedPiece: string | null; onClose: () => void }) {
  const draft = useRef(readDraft(s.id)).current;
  const [tab, setTab] = useState<"ask" | "library">("ask");
  const [question, setQuestion] = useState(draft?.question ?? "");
  const [measurements, setMeasurements] = useState<Record<string, string>>(draft?.measurements ?? {});
  const [answers, setAnswers] = useState<AskRequest["answers"]>({});
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pending, setPending] = useState<File[]>([]);
  const [forLibrary, setForLibrary] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [viewing, setViewing] = useState<Citation | null>(null);
  const [page, setPage] = useState<PageFocus | null>(null);
  const [docs, setDocs] = useState<SourceDocument[] | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const refreshDocs = () => askApi.documents().then(r => setDocs(r.documents)).catch(() => setDocs([]));
  useEffect(() => { void refreshDocs(); input.current?.focus(); }, []);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  // Attachments from an earlier visit come back with the typed question, so nothing has to be redone.
  useEffect(() => {
    for (const id of draft?.attachmentIds ?? []) askApi.getUpload(id).then(u => setAttachments(a => a.some(x => x.record?.id === u.id) ? a : [...a, { key: u.id, file: null, name: u.filename, size: u.size, local: null, progress: 1, record: u, error: "" }])).catch(() => undefined);
  }, []);
  useEffect(() => { writeDraft(s.id, { question, measurements, attachmentIds: attachments.flatMap(a => a.record ? [a.record.id] : []) }); }, [question, measurements, attachments]);

  const sendAttachment = async (a: Attachment) => {
    if (!a.file) return;
    if (a.size > MAX_MB * 1048576) { setAttachments(x => x.map(y => y.key === a.key ? { ...y, error: `${sizeText(a.size)} is over the ${MAX_MB} MB limit.` } : y)); return; }
    setAttachments(x => x.map(y => y.key === a.key ? { ...y, error: "", progress: 0 } : y));
    try {
      const u = await askApi.upload(a.file, { purpose: "site_photo", projectId: s.projectId, packageId: s.id }, p => setAttachments(x => x.map(y => y.key === a.key ? { ...y, progress: p } : y)));
      setAttachments(x => x.map(y => y.key === a.key ? { ...y, record: u, progress: 1 } : y));
    } catch (e) { setAttachments(x => x.map(y => y.key === a.key ? { ...y, error: e instanceof Error ? e.message : "Upload failed" } : y)); }
  };
  const attach = (files: File[]) => {
    const list = files.map(file => ({ key: `${file.name}-${file.size}-${Math.random()}`, file, name: file.name || "photo", size: file.size, local: localPreview(file), progress: 0, record: null, error: "" }));
    setAttachments(x => [...x, ...list]);
    for (const a of list) void sendAttachment(a);
  };
  const chooseUse = (use: "question" | "library") => {
    const files = pending; setPending([]);
    if (use === "question") attach(files); else { setForLibrary(files); setTab("library"); }
  };
  const removeAttachment = (a: Attachment) => { if (a.local) URL.revokeObjectURL(a.local); setAttachments(x => x.filter(y => y.key !== a.key)); };
  const retryAttachment = async (a: Attachment) => {
    if (!a.record) return void sendAttachment(a);
    try { const u = await askApi.retryUpload(a.record.id); setAttachments(x => x.map(y => y.key === a.key ? { ...y, record: u, error: "" } : y)); }
    catch (e) { setAttachments(x => x.map(y => y.key === a.key ? { ...y, error: e instanceof Error ? e.message : "Retry failed" } : y)); }
  };
  const readyIds = attachments.flatMap(a => a.record?.status === "ready" ? [a.record.id] : []);
  const waiting = attachments.some(a => !a.error && (!a.record || isBusy(a.record.status)));

  const run = async (q = question, extra: { answers?: AskRequest["answers"]; measurements?: Record<string, string> } = {}) => {
    if (!q.trim() || waiting) return;
    setBusy(true); setError("");
    const m = extra.measurements ?? measurements;
    const list = MEASURE_FIELDS.filter(f => m[f.name]?.trim()).map(f => ({ name: f.name, value: Number(m[f.name]), unit: f.unit }));
    try {
      const a = await askApi.ask({ question: q, packageId: s.id, selectedElementId: selectedPiece ?? undefined, measurements: list, answers: extra.answers ?? answers, attachments: readyIds });
      setAnswer(a);
      const first = a.sources.find(x => x.role === "main");
      setPage(null);
      setViewing(v => (v && a.sources.some(x => x.key === v.key)) ? v : first ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : "The question could not be answered"); }
    finally { setBusy(false); }
  };
  const answerFollowUp = (f: FollowUp, value: string) => {
    if (f.field.startsWith("observation:")) { const next = { ...answers, observations: { ...answers?.observations, [f.field.slice(12)]: value as "yes" | "no" } }; setAnswers(next); void run(answer?.question ?? question, { answers: next }); }
    else if (f.kind === "choice") { const next = { ...answers, [f.field]: value }; setAnswers(next); void run(answer?.question ?? question, { answers: next }); }
    else { const next = { ...measurements, [f.field]: value }; setMeasurements(next); void run(answer?.question ?? question, { measurements: next }); }
  };
  const selectionMoved = !!answer && (selectedPiece ?? null) !== null && answer.context.selectedElementId !== selectedPiece
    && !answer.context.facts.some(f => f.name === "selectionNote");
  const noLibrary = docs !== null && docs.length === 0;
  const openCitation = (c: Citation) => { setPage(null); setViewing(c); };

  return <div className="fa-ask" role="dialog" aria-label="Ask Sprink">
    <div className="fa-ask-col">
      <div className="fa-ask-head">
        <h2>Ask Sprink</h2>
        <div className="fa-seg" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "ask"} className={tab === "ask" ? "is-on" : ""} onClick={() => { setTab("ask"); setPage(null); }}>Ask</button>
          <button type="button" role="tab" aria-selected={tab === "library"} className={tab === "library" ? "is-on" : ""} onClick={() => setTab("library")}>Library{docs ? ` (${docs.length})` : ""}</button>
        </div>
        <button type="button" className="fa-icon-btn" onClick={onClose} aria-label="Close Ask Sprink"><Icon name="x" /></button>
      </div>
      {tab === "library" ? <Library s={s} docs={docs} onChanged={refreshDocs} incoming={forLibrary} onIncomingTaken={() => setForLibrary([])} onShowPage={setPage} />
        : <DropArea onFiles={f => setPending(f)} hint="Drop to attach" className="fa-ask-body fa-ask-split">
        <div className="fa-ask-compose">
        <ContextStrip s={s} answer={answer} selectedPiece={selectedPiece} />
        <form className="fa-ask-form" onSubmit={e => { e.preventDefault(); void run(); }}>
          <label className="sr-only" htmlFor="ask-q">Question</label>
          <textarea id="ask-q" ref={input} rows={2} value={question} placeholder="Ask about a rule, a measurement or this site condition" onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void run(); } }} />
          <Button variant="primary" busy={busy} disabled={!question.trim() || waiting} onClick={() => void run()} title={waiting ? "Waiting for attachments to be read" : undefined}>Ask</Button>
        </form>
        <div className="fa-ask-attach">
          <FileButtons onFiles={f => setPending(f)} />
          <small className="fa-muted">Photos, drawings or PDFs. Drop or paste them here.</small>
        </div>
        {pending.length > 0 && <div className="fa-purpose" role="group" aria-label="How to use the files">
          <p><b>How should Sprink use {pending.length === 1 ? pending[0].name || "this file" : `these ${pending.length} files`}?</b></p>
          <Button onClick={() => chooseUse("question")}>Attach to this question<small>Site photo or drawing. Context only, never a code source.</small></Button>
          <Button onClick={() => chooseUse("library")}>Add to the source library<small>A reference document to review and index.</small></Button>
          <Button variant="quiet" onClick={() => setPending([])}>Cancel</Button>
        </div>}
        {attachments.length > 0 && <ul className="fa-atts">{attachments.map(a => <AttachmentChip key={a.key} a={a}
          onRemove={() => removeAttachment(a)} onRetry={() => void retryAttachment(a)} onChange={u => setAttachments(x => x.map(y => y.key === a.key ? { ...y, record: u } : y))} />)}</ul>}
        </div>
        <div className="fa-ask-scroll">
        {noLibrary && <Callout tone="neutral" title="The source library is empty" action={<Button variant="quiet" onClick={() => setTab("library")}>Open library</Button>}>Upload authorized documents or load the labelled demonstration set.</Callout>}
        {!answer && <div className="fa-ask-suggest">{SUGGESTED.map(q => <button key={q} type="button" onClick={() => { setQuestion(q); void run(q); }}>{q}</button>)}</div>}
        <details className="fa-ask-measure">
          <summary>Measurements you add{Object.values(measurements).filter(Boolean).length ? ` (${Object.values(measurements).filter(Boolean).length})` : ""}</summary>
          <div className="fa-ask-measure-grid">{MEASURE_FIELDS.map(f => <label key={f.name}><span>{f.label}</span>
            <span className="fa-ask-unit"><input inputMode="decimal" value={measurements[f.name] ?? ""} onChange={e => setMeasurements({ ...measurements, [f.name]: e.target.value })} /><small>{f.unit}</small></span></label>)}</div>
          <small className="fa-muted">Used for this question only. They are not saved to the work package.</small>
        </details>
        {error && <Callout tone="red" title="Could not answer" action={<Button busy={busy} onClick={() => void run()}>Retry</Button>}>{error} Your question and attachments are kept.</Callout>}
        {busy && !answer && <Spinner label="Searching the project library…" />}
        {answer && <Answer a={answer} viewing={viewing} onView={openCitation} onFollowUp={answerFollowUp} busy={busy} stale={selectionMoved} onAskAgain={() => void run(answer.question)} />}
        </div>
      </DropArea>}
    </div>
    {page ? <PageViewer focus={page} onClose={() => setPage(null)} onPage={n => setPage({ ...page, page: n, boxes: [], subtitle: `Page ${n} of ${page.pageCount}` })} />
      : <SourceViewer citation={viewing} onClose={() => setViewing(null)} />}
  </div>;
}

function AttachmentChip({ a, onRemove, onRetry, onChange }: { a: Attachment; onRemove: () => void; onRetry: () => void; onChange: (u: UploadRecord) => void }) {
  useUploadPoll(a.record, onChange);
  const server = useAuthedUrl(a.record && a.record.status === "ready" ? `/api/uploads/${a.record.id}/preview` : null);
  const src = server.url ?? a.local;
  const failed = a.error || a.record?.status === "failed";
  return <li className={`fa-att ${failed ? "is-failed" : ""}`}>
    <span className="fa-att-thumb">{src ? <img src={src} alt="" /> : <Icon name="file" size={20} />}</span>
    <span className="fa-att-text">
      <b title={a.name}>{a.name}</b>
      <small>{a.error ? a.error : a.record ? (a.record.status === "failed" ? a.record.error?.message : `${a.record.kindLabel} · ${sizeText(a.size)}`) : `Uploading ${Math.round(a.progress * 100)}%`}</small>
    </span>
    {a.record && !a.error && <StatusBadge u={a.record} />}
    {failed && <Button variant="quiet" onClick={onRetry}>Retry</Button>}
    <button type="button" className="fa-icon-btn" onClick={onRemove} aria-label={`Remove ${a.name}`}><Icon name="x" size={14} /></button>
  </li>;
}

function PageViewer({ focus, onClose, onPage }: { focus: PageFocus; onClose: () => void; onPage: (n: number) => void }) {
  const img = useAuthedUrl(`/api/uploads/${focus.uploadId}/pages/${focus.page}`);
  return <aside className="fa-viewer" aria-label="Page viewer">
    <div className="fa-viewer-head">
      <div><strong>{focus.title}</strong><small>{focus.subtitle}</small></div>
      <button type="button" className="fa-icon-btn" onClick={onClose} aria-label="Close page"><Icon name="x" /></button>
    </div>
    <div className="fa-viewer-body"><PageImage url={img.url} error={img.error} boxes={focus.boxes} /></div>
    {focus.pageCount > 1 && <div className="fa-viewer-foot">
      <Button variant="quiet" disabled={focus.page <= 1} onClick={() => onPage(focus.page - 1)}>Previous page</Button>
      <small className="fa-muted">Page {focus.page} of {focus.pageCount}</small>
      <Button variant="quiet" disabled={focus.page >= focus.pageCount} onClick={() => onPage(focus.page + 1)}>Next page</Button>
    </div>}
  </aside>;
}

/** A page image with highlighted regions. Region coordinates are in the page image's own pixels. */
function PageImage({ url, error, boxes }: { url: string | null; error: boolean; boxes: Array<{ x: number; y: number; w: number; h: number; tone?: string }> }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const first = useRef<HTMLSpanElement | null>(null);
  useEffect(() => { first.current?.scrollIntoView({ block: "center" }); }, [size, boxes]);
  if (error) return <Callout tone="red" title="Could not load the page image">Open the original file instead.</Callout>;
  if (!url) return <Spinner label="Loading page…" />;
  return <div className="fa-page">
    <img src={url} alt="Source page" onLoad={e => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
    {size && boxes.map((b, i) => <span key={i} ref={i === 0 ? first : undefined} className={`fa-page-box ${b.tone === "flag" ? "is-flag" : ""}`}
      style={{ left: `${(b.x / size.w) * 100}%`, top: `${(b.y / size.h) * 100}%`, width: `${(b.w / size.w) * 100}%`, height: `${(b.h / size.h) * 100}%` }} />)}
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
      <Badge tone={a.status === "no_source" ? "amber" : a.status === "needs_input" ? "amber" : "neutral"}>{{ answered: "From the library", needs_input: "Needs your input", no_source: "No source found" }[a.status]}</Badge>
      <small className="fa-muted">Source lookup · answered in {a.timings.totalMs} ms</small>
    </div>
    <p className="fa-answer-summary">{a.summary}</p>
    {demo && <p className="fa-demo-note"><Icon name="alert" size={14} />Answered from demonstration documents. Their text is invented for testing and is not code text.</p>}

    {a.followUps.length > 0 && <Block title="Needed to answer">
      {a.followUps.map(f => <FollowUpRow key={f.id} f={f} busy={busy} onAnswer={v => onFollowUp(f, v)} />)}
    </Block>}

    {a.explanation.length > 0 && <Block title="What applies" aside={a.explanation.some(c => c.kind === "quote") ? "Quotes are the source's words; notes are Sprink's interpretation" : "Sprink notes: interpretation, check the source wording"}>
      <ul className="fa-claims">{a.explanation.map(c => <li key={c.id} className={c.kind === "quote" ? "is-quote" : ""}>
        {c.kind === "pointer" ? <span className="fa-muted">{c.text}</span> : c.kind === "quote" ? <><small className="fa-claim-label">Source wording</small><q>{c.text}</q></> : c.text} <span className="fa-cites">{c.citations.map(cite)}</span></li>)}</ul>
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

    {a.attachments.length > 0 && <Block title="Site photos" aside="Context for this question, not a code source">
      {a.attachments.map(x => <AttachmentFacts key={x.id} x={x} />)}
    </Block>}


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

function AttachmentFacts({ x }: { x: AttachmentView }) {
  const shown = x.observations.filter(o => o.status !== "rejected");
  const label = { read: "Read, not confirmed", unclear: "Unclear", confirmed: "Confirmed by you", rejected: "Misread" } as const;
  return <div className="fa-photo-facts">
    <p className="small"><b>{x.filename}</b> · {x.kindLabel}</p>
    {shown.length === 0 ? <small className="fa-muted">No readable text was found in this photo.</small>
      : <table className="fa-mini"><tbody>{shown.slice(0, 8).map(o => <tr key={o.id}>
        <td>{o.kind === "marking" ? "Marking" : o.kind === "dimension_text" ? "Dimension text" : "Text"}</td>
        <td className="mono">{o.text}</td>
        <td><span className={`fa-origin ${o.status === "confirmed" ? "o-you" : "o-photo"}`}>{label[o.status]}</span></td>
      </tr>)}</tbody></table>}
    {x.observations.some(o => o.kind === "dimension_text") && <small className="fa-muted">A photo has no scale: numbers in it are not measurements and are not used in calculations.</small>}
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
  const [mode, setMode] = useState<"text" | "page">("text");
  const target = useRef<HTMLElement | null>(null);
  const pageImg = useAuthedUrl(mode === "page" && citation?.page ? citation.page.image : null);
  useEffect(() => {
    setData(null); setError(""); setOriginal(null); setMode(citation?.page ? "page" : "text");
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
        {citation.revision && <small>{citation.revision.label}</small>}
      </div>
      <button type="button" className="fa-icon-btn" onClick={onClose} aria-label="Close source"><Icon name="x" /></button>
    </div>
    {citation.page && <div className="fa-seg fa-viewer-mode" role="tablist">
      <button type="button" role="tab" aria-selected={mode === "page"} className={mode === "page" ? "is-on" : ""} onClick={() => setMode("page")}>Page {citation.page.number}</button>
      <button type="button" role="tab" aria-selected={mode === "text"} className={mode === "text" ? "is-on" : ""} onClick={() => setMode("text")}>Text</button>
    </div>}
    {mode === "page" && citation.page ? <div className="fa-viewer-body">
      <p className="small fa-muted">{citation.sectionId} is highlighted on page {citation.page.number} of the uploaded file.</p>
      <PageImage url={pageImg.url} error={pageImg.error} boxes={citation.regions.filter(r => r.page === citation.page!.number)} />
    </div> : error ? <Callout tone="red" title="Could not open the passage">{error}</Callout> : !data ? <Spinner label="Opening passage…" /> :
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
      {citation.original && (citation.original.startsWith("/api/uploads/")
        ? <Button variant="quiet" onClick={() => void openOriginal(citation.original!, citation.page?.number).catch(e => setError(e.message))}>Original file <Icon name="external" size={13} /></Button>
        : citation.original.startsWith("/api/")
        ? <Button variant="quiet" onClick={() => original === null ? void askApi.original(citation.original!).then(setOriginal).catch(e => setError(e.message)) : setOriginal(null)}>{original === null ? "Original file" : "Back to passage"}</Button>
        : <a className="fa-link" href={citation.original} target="_blank" rel="noreferrer">Original <Icon name="external" size={13} /></a>)}
    </div>
  </aside>;
}
/** Opens an uploaded original in a new tab (at the cited page for PDFs). The file is fetched with the app token. */
async function openOriginal(href: string, page?: number) {
  const win = window.open("", "_blank");
  const url = await authedBlobUrl(href);
  const target = page ? `${url}#page=${page}` : url;
  if (win) win.location.href = target; else window.location.assign(target);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
