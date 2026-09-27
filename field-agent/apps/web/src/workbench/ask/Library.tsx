import { tr } from "../locale.js";
import { useEffect, useState } from "react";
import type { Snapshot } from "../api.js";
import { Badge, Button, Callout, Field, Icon } from "../ui.js";
import { askApi, type SourceDocument, type UploadRecord } from "./askApi.js";
import { Review, TYPES, type PageFocus } from "./Review.js";
import { DropArea, FileButtons, MAX_MB, StatusBadge, isBusy, sizeText, useUploadPoll } from "./uploads.js";

const TYPE_LABEL = Object.fromEntries(TYPES);

/**
 * The project's source library: uploaded documents moving through reading, review and indexing,
 * the searchable documents, and the labelled demonstration set.
 */
export function Library({ s, docs, onChanged, incoming, onIncomingTaken, onShowPage }: {
  s: Snapshot; docs: SourceDocument[] | null; onChanged: () => void;
  incoming: File[]; onIncomingTaken: () => void; onShowPage: (p: PageFocus | null) => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [uploads, setUploads] = useState<UploadRecord[] | null>(null);
  const [sending, setSending] = useState<Array<{ key: string; file: File; progress: number; error?: string }>>([]);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [textOpen, setTextOpen] = useState(false);

  const refresh = () => askApi.uploads("reference").then(r => setUploads(r.uploads)).catch(() => setUploads([]));
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (incoming.length) { onIncomingTaken(); void send(incoming); } }, [incoming]);

  const send = async (files: File[]) => {
    const items = files.map(file => ({ key: `${file.name}-${file.size}-${Math.random()}`, file, progress: 0 }));
    setSending(x => [...x, ...items]);
    for (const it of items) {
      if (it.file.size > MAX_MB * 1048576) { setSending(x => x.map(y => y.key === it.key ? { ...y, error: `${sizeText(it.file.size)} is over the ${MAX_MB} MB limit.` } : y)); continue; }
      try {
        const u = await askApi.upload(it.file, { purpose: "reference", projectId: s.projectId, packageId: s.id }, p => setSending(x => x.map(y => y.key === it.key ? { ...y, progress: p } : y)));
        setSending(x => x.filter(y => y.key !== it.key));
        setUploads(x => [u, ...(x ?? [])]);
        if (files.length === 1) setReviewing(u.id);
      } catch (e) { setSending(x => x.map(y => y.key === it.key ? { ...y, error: e instanceof Error ? e.message : "Upload failed" } : y)); }
    }
  };
  const retrySend = (key: string) => { const it = sending.find(x => x.key === key); if (!it) return; setSending(x => x.filter(y => y.key !== key)); void send([it.file]); };
  const loadDemo = async () => {
    setBusy("demo"); setError("");
    try { await askApi.loadDemo(s.projectId); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : "Could not load"); } finally { setBusy(""); }
  };

  if (reviewing) return <Review s={s} uploadId={reviewing} onShowPage={onShowPage} onClose={() => { setReviewing(null); onShowPage(null); void refresh(); }} onIndexed={() => { onChanged(); void refresh(); }} />;

  return <DropArea onFiles={f => void send(f)} hint={tr("Drop to add to the source library")} className="fa-ask-body">
    <p className="fa-muted small">{tr("Add only documents you are authorized to store, index and use with AI. Sprink reads the text (OCR for scans and photos), you check it, and it becomes searchable when you index it.")}</p>
    <div className="fa-actions">
      <FileButtons onFiles={f => void send(f)} label={tr("Upload document")} camera={false} />
      <small className="fa-muted">{tr("PDF (text or scanned), JPEG, PNG, HEIC, WebP, TIFF, BMP or GIF, up to")}{" "}{MAX_MB}{" "}{tr("MB. You can also drop or paste files here.")}</small>
    </div>
    {error && <Callout tone="red" title={tr("Could not load")}>{error}</Callout>}

    {(sending.length > 0 || (uploads?.length ?? 0) > 0) && <section className="fa-ask-block">
      <h3>{tr("Uploads")}</h3>
      <ul className="fa-docs">
        {sending.map(it => <li key={it.key}>
          <div><strong>{it.file.name}</strong>{it.error ? <Badge tone="red">{tr("Failed")}</Badge> : <Badge tone="blue">{tr("Uploading")}{" "}{Math.round(it.progress * 100)}%</Badge>}</div>
          {it.error && <><small className="fa-warn">{it.error}</small><div className="fa-actions"><Button onClick={() => retrySend(it.key)}>{tr("Retry upload")}</Button><Button variant="quiet" onClick={() => setSending(x => x.filter(y => y.key !== it.key))}>{tr("Dismiss")}</Button></div></>}
        </li>)}
        {uploads?.map(u => <UploadRow key={u.id} u={u} onOpen={() => setReviewing(u.id)} onChange={n => setUploads(x => x?.map(y => y.id === n.id ? n : y) ?? null)} onRemoved={() => { setUploads(x => x?.filter(y => y.id !== u.id) ?? null); onChanged(); }} />)}
      </ul>
    </section>}

    <section className="fa-ask-block">
      <h3>{tr("Searchable documents")}<small>{docs?.length ?? ""}</small></h3>
      {docs === null ? <p className="fa-muted">{tr("Loading…")}</p> : docs.length === 0
        ? <Callout tone="neutral" title={tr("No documents yet")}>{tr("Upload an authorized document, or load the demonstration set to try the flow. The demonstration set is invented text, labelled everywhere it appears.")}</Callout>
        : <ul className="fa-docs">{docs.map(d => <li key={d.id}>
          <div><strong>{d.title}</strong>{d.demonstration && <Badge tone="sample">{tr("Demonstration")}</Badge>}</div>
          <small>{TYPE_LABEL[d.type] ?? d.type} · {d.edition} · {d.sectionCount}{" "}{tr("sections ·")}{" "}{d.publisher}{d.upload ? ` · revision ${d.upload.revision}${d.upload.basis === "corrected" ? " (corrected)" : ""}` : ""}</small>
          {d.flags.length > 0 && <small className="fa-warn">{tr("Flags:")}{" "}{d.flags.map(f => f.replace(/_/g, " ")).join(", ")}</small>}
        </li>)}</ul>}
      <div className="fa-actions">
        <Button busy={busy === "demo"} onClick={() => void loadDemo()}>{tr("Load demonstration sources")}</Button>
        <Button variant="quiet" onClick={() => setTextOpen(!textOpen)}>{textOpen ? tr("Close text import") : tr("Import prepared text")}</Button>
      </div>
    </section>
    {textOpen && <TextImportForm s={s} onDone={() => { setTextOpen(false); onChanged(); }} />}
  </DropArea>;
}

function UploadRow({ u, onOpen, onChange, onRemoved }: { u: UploadRecord; onOpen: () => void; onChange: (u: UploadRecord) => void; onRemoved: () => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useUploadPoll(u, onChange);
  const act = async (what: "retry" | "remove") => {
    setBusy(what); setError("");
    try { if (what === "retry") onChange(await askApi.retryUpload(u.id)); else { await askApi.removeUpload(u.id); onRemoved(); } }
    catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setBusy(""); }
  };
  return <li>
    <div><strong>{u.filename}</strong><StatusBadge u={u} /></div>
    <small>{u.kindLabel} · {sizeText(u.size)}{u.pageCount ? ` · ${u.pageCount} page${u.pageCount === 1 ? "" : "s"}` : ""}{u.review.blocking ? ` · ${u.review.blocking} to check` : ""}{u.indexedRevision ? ` · revision ${u.indexedRevision} indexed` : ""}</small>
    {u.status === "failed" && <small className="fa-warn">{u.error?.message}</small>}
    {error && <small className="fa-warn">{error}</small>}
    <div className="fa-actions">
      {(u.status === "review" || u.status === "ready" || (u.status === "failed" && u.failedStage === "indexing")) && <Button variant={u.status === "review" ? "primary" : "default"} onClick={onOpen}>{u.status === "review" ? tr("Review") : tr("Open")}</Button>}
      {u.status === "failed" && <Button busy={busy === "retry"} onClick={() => void act("retry")}>{tr("Retry")}</Button>}
      {!isBusy(u.status) && <Button variant="quiet" busy={busy === "remove"} onClick={() => void act("remove")}>{tr("Remove")}</Button>}
    </div>
  </li>;
}

/** Import of already-prepared text or Markdown, kept for documents extracted elsewhere. */
function TextImportForm({ s, onDone }: { s: Snapshot; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [f, setF] = useState({ title: "", publisher: "", type: "published_code", edition: "", standard: "nfpa13", jurisdiction: "", amendsEdition: "", productIds: "", url: "",
    extraction: "text", basis: "", store: false, ai: false, display: "excerpt", maxQuoteChars: "400", demonstration: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof f, v: string | boolean) => setF({ ...f, [k]: v });
  const submit = async () => {
    if (!file) return;
    setBusy(true); setError("");
    try {
      const content = await file.text();
      const scope: Record<string, unknown> = {};
      if (f.type === "published_code" || f.type === "local_amendment") scope.standard = f.standard;
      if (f.type === "local_amendment") { scope.jurisdiction = f.jurisdiction; scope.amendsEdition = f.amendsEdition; }
      if (f.type === "manufacturer") scope.productIds = f.productIds.split(",").map(x => x.trim()).filter(Boolean);
      if (f.type === "project_document") scope.projectId = s.projectId;
      const id = `${f.title}-${f.edition}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || `doc-${Date.now()}`;
      await askApi.importDocument({
        id, title: f.title, publisher: f.publisher, type: f.type, edition: f.edition, scope, demonstration: f.demonstration,
        ...(f.url ? { url: f.url } : {}), filename: file.name, content,
        extraction: { method: f.extraction },
        authorization: { basis: f.basis, storeAndIndex: f.store, useWithAi: f.ai, display: f.display, ...(f.display === "excerpt" ? { maxQuoteChars: Number(f.maxQuoteChars) } : {}) },
      });
      onDone();
    } catch (e) { setError(e instanceof Error ? e.message : "Import failed"); } finally { setBusy(false); }
  };
  return <form className="fa-import" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <Field label={tr("Text or Markdown file")} hint={tr("Use headings like “## 8.2 Title” and page markers “<!-- page: 41 -->”.")}>
      <input type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" onChange={e => setFile(e.target.files?.[0] ?? null)} />
    </Field>
    <div className="fa-import-grid">
      <Field label={tr("Title")}><input value={f.title} onChange={e => set("title", e.target.value)} /></Field>
      <Field label={tr("Publisher")}><input value={f.publisher} onChange={e => set("publisher", e.target.value)} /></Field>
      <Field label={tr("Type")}><select value={f.type} onChange={e => set("type", e.target.value)}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      <Field label={tr("Edition or revision")}><input value={f.edition} onChange={e => set("edition", e.target.value)} /></Field>
      {(f.type === "published_code" || f.type === "local_amendment") && <Field label={tr("Standard")}><input value={f.standard} onChange={e => set("standard", e.target.value)} /></Field>}
      {f.type === "local_amendment" && <><Field label={tr("Jurisdiction")}><input value={f.jurisdiction} onChange={e => set("jurisdiction", e.target.value)} placeholder={tr("san_francisco")} /></Field>
        <Field label={tr("Amends edition")}><input value={f.amendsEdition} onChange={e => set("amendsEdition", e.target.value)} /></Field></>}
      {f.type === "manufacturer" && <Field label={tr("Catalog product ids")} hint={tr("Comma separated")}><input value={f.productIds} onChange={e => set("productIds", e.target.value)} placeholder={tr("spears/CP-010")} /></Field>}
      <Field label={tr("Link to the original (optional)")}><input value={f.url} onChange={e => set("url", e.target.value)} placeholder={tr("https://")} /></Field>
      <Field label={tr("Text came from")}><select value={f.extraction} onChange={e => set("extraction", e.target.value)}><option value="text">{tr("Digital text")}</option><option value="ocr">{tr("OCR of a scan (flagged)")}</option></select></Field>
    </div>
    <fieldset className="fa-import-auth">
      <legend>{tr("Authorization")}</legend>
      <Field label={tr("Who authorized this, and on what basis")} hint={tr("A licence, company ownership or a public-domain statement. A subscription alone is not assumed to allow this use.")}>
        <textarea rows={2} value={f.basis} onChange={e => set("basis", e.target.value)} />
      </Field>
      <label className="fa-check"><input type="checkbox" checked={f.store} onChange={e => set("store", e.target.checked)} />{tr("We may store and index this document")}</label>
      <label className="fa-check"><input type="checkbox" checked={f.ai} onChange={e => set("ai", e.target.checked)} />{tr("We may use it with AI features")}</label>
      <div className="fa-import-grid">
        <Field label={tr("Display in answers")}><select value={f.display} onChange={e => set("display", e.target.value)}><option value="full">{tr("Full passages")}</option><option value="excerpt">{tr("Excerpts only")}</option><option value="reference_only">{tr("Reference only")}</option></select></Field>
        {f.display === "excerpt" && <Field label={tr("Excerpt limit (characters)")}><input inputMode="numeric" value={f.maxQuoteChars} onChange={e => set("maxQuoteChars", e.target.value)} /></Field>}
      </div>
      <label className="fa-check"><input type="checkbox" checked={f.demonstration} onChange={e => set("demonstration", e.target.checked)} />{tr("This is a demonstration document, not a real source")}</label>
    </fieldset>
    {error && <Callout tone="red" title={tr("Not imported")}>{error}</Callout>}
    <div className="fa-actions end"><Button variant="primary" busy={busy} disabled={!file || !f.title || !f.edition || !f.basis} onClick={() => void submit()}><Icon name="upload" size={16} />{tr("Import")}</Button></div>
  </form>;
}
