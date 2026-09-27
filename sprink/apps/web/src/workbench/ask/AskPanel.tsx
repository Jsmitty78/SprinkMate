import { tr } from "../locale.js";
import { useEffect, useRef, useState } from "react";
import { Button, Callout, Icon, Spinner } from "../ui.js";
import { askApi, type AskAnswer, type Citation, type SourceDocument } from "./askApi.js";
import { useAuthedUrl } from "./uploads.js";
import "./rule-search.css";

const SUGGESTED = [
  "What does Spears FlameGuard require for deburring a solvent-cement pipe joint?",
  "What installation instructions are available for TYCO TY-FRB sprinklers?",
];

/** Shared, operator-maintained reference search, independent of a work package. */
export function AskPanel({ onClose, embedded = false }: { embedded?: boolean; onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [viewing, setViewing] = useState<Citation | null>(null);
  const [docs, setDocs] = useState<SourceDocument[] | null>(null);
  const [libraryError, setLibraryError] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { let live = true; askApi.documents().then(r => { if (live) setDocs(r.documents); }).catch(() => { if (live) setLibraryError(true); }); input.current?.focus(); return () => { live = false; }; }, []);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (!embedded && e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose, embedded]);
  const run = async (q = question) => {
    if (!q.trim() || busy) return;
    setBusy(true); setError(""); setAnswer(null); setViewing(null);
    try { setAnswer(await askApi.search(q)); }
    catch (e) { setError(e instanceof Error ? e.message : "Search failed"); }
    finally { setBusy(false); }
  };
  return <div className={`fa-ask fa-rule-search ${answer || busy || error ? "has-answer" : "is-new-question"}`} role={embedded ? "region" : "dialog"} aria-label={tr("Rule search")}>
    <div className="fa-ask-col">
      <div className="fa-ask-head"><h2>{tr("Rule search")}</h2>
        {answer && <Button variant="quiet" onClick={() => { setQuestion(""); setAnswer(null); setViewing(null); setError(""); input.current?.focus(); }}>{tr("New search")}</Button>}
        {!embedded && <button type="button" className="fa-icon-btn" onClick={onClose} aria-label={tr("Close Ask Sprink")}><Icon name="x" /></button>}
      </div>
      <div className="fa-ask-body fa-ask-split">
        <div className="fa-ask-compose">
          <div className="fa-search-intro"><span className="fa-search-eyebrow">{tr("SPRINK REFERENCE LIBRARY")}</span><h1>{tr("What do you need to know?")}</h1><p className="fa-muted">{tr("Search sprinkler references maintained by Sprink.")}</p></div>
          <form className="fa-ask-form" role="search" onSubmit={e => { e.preventDefault(); void run(); }}>
            <label className="fa-search-label" htmlFor="ask-q">{tr("Search sprinkler rules")}</label>
            <textarea id="ask-q" ref={input} rows={2} maxLength={1000} value={question} placeholder={tr("Ask a question or enter a product, rule or keyword…")} onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void run(); } }} />
            <div className="fa-search-actions"><small>{tr("Enter to search · Shift + Enter for a new line")}</small><Button type="submit" variant="primary" busy={busy} disabled={!question.trim() || busy}><Icon name="ask" size={18} />{tr("Search")}</Button></div>
          </form>
        </div>
        <div className="fa-ask-scroll">
          {libraryError && <Callout tone="red" title={tr("Could not load the source list")} />}
          {!answer && !busy && <div className="fa-ask-suggest"><span className="fa-search-eyebrow">{tr("TRY A QUESTION")}</span>{SUGGESTED.map(q => <button key={q} type="button" onClick={() => { setQuestion(q); void run(q); }}>{tr(q)}</button>)}</div>}
          {error && <Callout tone="red" title={tr("Could not answer")} action={<Button onClick={() => void run()}>{tr("Retry")}</Button>}>{error}</Callout>}
          {busy && <Spinner label={tr("Searching references…")} />}
          {answer && <Answer a={answer} viewing={viewing} onView={setViewing} />}
          {docs && <details className="wf-question-examples"><summary>{tr("Available references")} ({docs.length})</summary>
            {docs.length ? <ul className="fa-plain small">{docs.map(d => <li key={d.id}><strong>{d.title}</strong><br />{d.publisher} · {d.edition}</li>)}</ul> : <p>{tr("No references are available yet. The library administrator must add sources.")}</p>}
          </details>}

        </div>
      </div>
    </div>
  </div>;
}

/** One button per original page, even when several indexed passages matched it. */
export function Answer({ a, viewing, onView }: { a: AskAnswer; viewing: Citation | null; onView: (c: Citation) => void }) {
  const candidates = a.sources.filter(s => s.excerpt || !a.sources.some(x => x.excerpt && x.docId === s.docId && x.pageStart === s.pageStart));
  const hits = candidates.filter((s, i, all) => all.findIndex(x => s.excerpt ? x.key === s.key : x.docId === s.docId && (s.pageStart !== null ? x.pageStart === s.pageStart : x.key === s.key)) === i).sort((a, b) => Number(!!b.excerpt) - Number(!!a.excerpt));
  const selected = viewing ?? hits[0];
  const docs = hits.filter((s, i) => hits.findIndex(x => x.docId === s.docId) === i);
  if (a.status === 'no_source') return <div className="fa-pdf-empty"><h3>{tr('No source found')}</h3><p>{a.summary}</p></div>;
  return <section className="fa-pdf-results" aria-label={tr('Source results')}>
    <header className="fa-pdf-results-head"><strong>{hits.length} {tr('results')}</strong><small>{(a.timings.retrievalMs / 1000).toFixed(1)}s · {tr('Original documents')}</small></header>
    <nav className="fa-pdf-matches" aria-label={tr('Matched pages')}>{docs.map(doc => <div key={doc.docId}>
      <strong>{doc.docTitle}</strong><small>{doc.publisher} · {doc.edition}</small>
      <div className="fa-pdf-page-buttons">{hits.filter(s => s.docId === doc.docId).map(s => <button type="button" key={s.key} aria-pressed={selected?.key === s.key} onClick={() => onView(s)}>{s.excerpt ? `${s.excerpt.label} · p. ${s.pageStart}` : s.pageStart ? `Page ${s.pageStart}` : s.heading}</button>)}</div>
    </div>)}</nav>
    {selected && <OriginalPage key={selected.key} citation={selected} />}
  </section>;
}
function OriginalPage({ citation: c }: { citation: Citation }) {
  const image = useAuthedUrl(c.page?.image);
  const [context, setContext] = useState(false);
  const [full, setFull] = useState(false);
  const [zoom, setZoom] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (full) dialog.current?.showModal(); else dialog.current?.close(); }, [full]);
  const original = c.original && /^https?:/.test(c.original) ? `${c.original.split('#')[0]}${c.pageStart ? `#page=${c.pageStart}` : ''}` : null;
  const crop = c.excerpt && (context ? c.excerpt.contextBox : c.excerpt.box);
  const ratio = crop && c.excerpt ? (crop.w * c.excerpt.pageWidth) / (crop.h * c.excerpt.pageHeight) : 1;
  const displayWidth = crop && c.excerpt ? Math.max((crop.w * c.excerpt.pageWidth) / (c.excerpt.box.h * c.excerpt.pageHeight) * 340, Math.min(620, crop.w * c.excerpt.pageWidth)) : 0;
  const alt = `${c.docTitle} — original PDF page ${c.page?.number ?? c.pageStart}`;
  return <article className="fa-pdf-original">
    <header className="fa-pdf-toolbar"><div className="fa-pdf-heading"><strong>{c.excerpt?.label ?? tr('Original PDF')}</strong><small>{c.pageStart ? `Page ${c.pageStart}` : c.heading} · {c.excerpt ? tr('Original excerpt') : tr('Full page')}</small></div><div>
      {c.excerpt && <button type="button" aria-pressed={context} onClick={() => setContext(!context)}>{context ? tr('Focus on match') : tr('Show context')}</button>}
      {c.page && <button type="button" onClick={() => setFull(true)}>{tr('Full page')}</button>}
    </div></header>
    {c.page ? image.error ? <Callout tone="red" title={tr('Could not load the page image')}>{tr('Open the original file instead.')}</Callout> : image.url ? crop ?
      <div className="fa-pdf-crop-stage"><div className="fa-pdf-crop" style={{ aspectRatio: ratio, maxWidth: `${displayWidth}px` }}>
        <img src={image.url} alt={`${alt} — ${c.excerpt!.label}${context ? ' with surrounding context' : ''}`} style={{ width: `${100 / crop.w}%`, left: `${-crop.x / crop.w * 100}%`, top: `${-crop.y / crop.h * 100}%` }} />
      </div></div> : <div className="fa-pdf-canvas"><img src={image.url} alt={alt} /></div> : <Spinner label={tr('Loading page…')} /> : <p className="fa-muted">{tr('Page preview is unavailable. Open the original or read the indexed text below.')}</p>}
    <footer className="fa-pdf-footer"><span>{c.excerpt ? tr('Cropped from the original · wording and diagrams unchanged') : tr('Full page shown · no reviewed excerpt available')}</span>{original && <a href={original} target="_blank" rel="noreferrer">{tr('Open original PDF')} <Icon name="external" size={12} /></a>}</footer>
    <details className="fa-pdf-text"><summary>{tr('Indexed text')}</summary>{c.flags.map(f => <p className="fa-warn" key={f.flag}>{f.label}</p>)}<blockquote className="fa-wording">{c.quote}</blockquote>{c.quoteNote && <small>{c.quoteNote}</small>}</details>
    <dialog ref={dialog} className="fa-pdf-dialog" aria-label={`${tr('Full page')} · ${c.docTitle}`} onClose={() => { setFull(false); setZoom(false); }}>
      <header><div><strong>{c.docTitle}</strong><small>{c.edition} · Page {c.pageStart}</small></div><div><button type="button" onClick={() => setZoom(!zoom)}>{zoom ? tr('Fit page') : tr('Zoom in')}</button><button type="button" autoFocus onClick={() => setFull(false)}>{tr('Close')}</button></div></header>
      <div className="fa-pdf-dialog-body">{image.url && <img className={zoom ? 'is-zoomed' : ''} src={image.url} alt={alt} />}</div>
    </dialog>
  </article>;
}
