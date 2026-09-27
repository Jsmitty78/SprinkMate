import { tr } from "../locale.js";
import { useEffect, useState } from "react";
import type { Snapshot } from "../api.js";
import { Badge, Button, Callout, Field, Icon, Spinner } from "../ui.js";
import { askApi, type ReferenceMetadata, type ReviewData, type ReviewItem, type UploadRecord } from "./askApi.js";
import { StatusBadge, isBusy, useUploadPoll } from "./uploads.js";

export const TYPES: Array<[string, string]> = [
  ["published_code", "Published code or standard"],
  ["local_amendment", "Local amendment or jurisdiction document"],
  ["manufacturer", "Manufacturer installation instructions"],
  ["project_document", "Project specification or approved drawing"],
  ["company_procedure", "Company procedure"],
];
const KIND_LABEL: Record<string, string> = {
  uncertain_number: "Uncertain number", low_confidence: "Hard to read", table_structure: "Table layout", no_text: "No text found", embedded_instructions: "Instruction-like text",
};
export interface PageFocus { uploadId: string; page: number; pageCount: number; title: string; subtitle: string; boxes: Array<{ x: number; y: number; w: number; h: number; tone: "flag" | "passage" }> }

/**
 * Review of an uploaded reference document before it becomes searchable: the extracted text and
 * metadata can be corrected, and every uncertain reading must be checked against the original.
 * Corrections are saved as new revisions; the extracted revision is kept.
 */
export function Review({ s, uploadId, onClose, onShowPage, onIndexed }: {
  s: Snapshot; uploadId: string; onClose: () => void; onShowPage: (p: PageFocus | null) => void; onIndexed: () => void;
}) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [record, setRecord] = useState<UploadRecord | null>(null);
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [m, setM] = useState<ReferenceMetadata | null>(null);
  const [busy, setBusy] = useState<"" | "save" | "index" | "retry">("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const load = async () => {
    try {
      const u = await askApi.getUpload(uploadId);
      setRecord(u);
      if (u.status === "review" || u.status === "ready" || (u.status === "failed" && u.failedStage === "indexing")) {
        const d = await askApi.review(uploadId);
        setData(d); setText(d.revision.text); setChecked(new Set(d.revision.acknowledged));
        setM(u.metadata ?? defaults(u, s));
        const first = d.items.find(i => i.blocking);
        showPage(d, first?.page ?? 1, first ? [first] : []);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not open the upload"); }
  };
  useEffect(() => { void load(); return () => onShowPage(null); }, [uploadId]);
  useUploadPoll(record, u => { setRecord(u); if (!isBusy(u.status)) void load(); });

  const showPage = (d: ReviewData, page: number, items: ReviewItem[]) => onShowPage({
    uploadId, page, pageCount: d.pages.length, title: d.upload.filename, subtitle: `Page ${page} of ${d.pages.length} · ${methodText(d.pages[page - 1]?.method)}`,
    boxes: items.filter(i => i.bbox && i.page === page).map(i => ({ ...i.bbox!, tone: "flag" as const })),
  });

  if (error && !data) return <div className="fa-ask-body"><Callout tone="red" title={tr("Could not open the upload")} action={<Button onClick={() => { setError(""); void load(); }}>{tr("Retry")}</Button>}>{error}</Callout><Button variant="quiet" onClick={onClose}>{tr("Back to library")}</Button></div>;
  if (!record) return <div className="fa-ask-body"><Spinner label={tr("Opening upload…")} /></div>;

  const blocking = data?.items.filter(i => i.blocking) ?? [];
  const open = blocking.filter(i => !checked.has(i.id));
  const missingMeta = m ? metaProblems(m) : ["details"];
  const dirty = !!data && (text !== data.revision.text || [...checked].sort().join() !== [...data.revision.acknowledged].sort().join() || JSON.stringify(m) !== JSON.stringify(record.metadata));

  const save = async (quiet = false) => {
    if (!data || !m) return null;
    setBusy("save"); setError(""); setSaved("");
    try {
      const u = await askApi.saveReview(uploadId, { text, acknowledged: [...checked], metadata: m });
      setRecord(u);
      const d = await askApi.review(uploadId);
      setData(d);
      if (!quiet) setSaved(d.revision.basis === "corrected" ? `Saved as revision ${d.revision.rev} (corrected). The extracted text is kept as revision 1.` : `Saved revision ${d.revision.rev}.`);
      return u;
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save"); return null; }
    finally { setBusy(""); }
  };
  const index = async () => {
    if (!m) return;
    if (dirty && !(await save(true))) return;
    setBusy("index"); setError(""); setSaved("");
    try { const u = await askApi.indexUpload(uploadId, m); setRecord(u); onIndexed(); }
    catch (e) { setError(e instanceof Error ? e.message : "Indexing failed"); void askApi.getUpload(uploadId).then(setRecord).catch(() => undefined); }
    finally { setBusy(""); }
  };
  const retry = async () => {
    setBusy("retry"); setError("");
    try { setRecord(await askApi.retryUpload(uploadId)); } catch (e) { setError(e instanceof Error ? e.message : "Retry failed"); } finally { setBusy(""); }
  };
  const set = <K extends keyof ReferenceMetadata>(k: K, v: ReferenceMetadata[K]) => setM(x => x ? { ...x, [k]: v } : x);
  const setAuth = (k: keyof ReferenceMetadata["authorization"], v: unknown) => setM(x => x ? { ...x, authorization: { ...x.authorization, [k]: v } } : x);
  const setScope = (k: string, v: unknown) => setM(x => x ? { ...x, scope: { ...x.scope, [k]: v } } : x);

  return <div className="fa-ask-body fa-review">
    <div className="fa-review-head">
      <button type="button" className="fa-link" onClick={onClose}><Icon name="chevron" size={14} />{" "}{tr("Library")}</button>
      <strong title={record.filename}>{record.filename}</strong>
      <StatusBadge u={record} />
    </div>
    <Steps u={record} />
    {record.status === "failed" && <Callout tone="red" title={record.failedStage === "indexing" ? tr("Indexing failed") : tr("Reading the file failed")}
      action={<Button busy={busy === "retry"} onClick={() => void retry()}>{tr("Retry")}</Button>}>{record.error?.message}</Callout>}
    {isBusy(record.status) && <Spinner label={record.status === "indexing" ? tr("Indexing…") : tr("Reading the file (text layer and OCR)…")} />}
    {record.status === "ready" && record.indexedRevision === data?.revision.rev &&
      <Callout tone="blue" title={tr("Searchable")}>{tr("Revision")}{" "}{record.indexedRevision}{" "}{tr("is in the library and answers cite it. Editing below creates a new revision that needs indexing again.")}</Callout>}
    {record.notes.map(n => <p key={n} className="small fa-muted">{n}</p>)}

    {data && m && <>
      <section className="fa-ask-block">
        <h3>{tr("Check these readings")}<small>{open.length ? `${open.length} of ${blocking.length} left` : blocking.length ? tr("All checked") : tr("Nothing flagged")}</small></h3>
        {data.items.length === 0 && <p className="small fa-muted">{tr("No uncertain readings were found. Compare the text with the page before indexing.")}</p>}
        <ul className="fa-review-items">{data.items.map(i => <li key={i.id} className={checked.has(i.id) ? "is-done" : ""}>
          <button type="button" className="fa-review-item" onClick={() => showPage(data, i.page, [i])}>
            <span className="mono">{tr("p.")}{" "}{i.page}</span><Badge tone={i.blocking ? "amber" : "neutral"}>{KIND_LABEL[i.kind] ?? i.kind}</Badge>
            <span className="fa-review-msg">{i.message}</span>
            {i.text && <code>{i.text}</code>}
          </button>
          {i.blocking && <label className="fa-check"><input type="checkbox" checked={checked.has(i.id)} onChange={e => { const n = new Set(checked); if (e.target.checked) n.add(i.id); else n.delete(i.id); setChecked(n); }} />{tr("Checked against the original (edit the text below if it is wrong)")}</label>}
        </li>)}</ul>
      </section>

      <section className="fa-ask-block">
        <h3>{tr("Extracted text")}<small>{tr("Revision")}{" "}{data.revision.rev} · {data.revision.basis === "corrected" ? tr("corrected") : tr("as extracted")}</small></h3>
        <p className="small fa-muted">{tr("Numbered headings (“## 8.2 Title”) start sections and “<!-- page: N -->” marks pages. Fix misreadings here; the original file is never changed.")}</p>
        <textarea className="fa-review-text mono" rows={14} value={text} onChange={e => setText(e.target.value)} spellCheck={false} aria-label={tr("Extracted text")} />
        <div className="fa-actions"><small className="fa-muted">{data.pages.length}{" "}{tr("page")}{data.pages.length === 1 ? "" : tr("s")}: {data.pages.map(p => <button type="button" key={p.n} className="fa-link" onClick={() => showPage(data, p.n, data.items.filter(i => i.page === p.n && !checked.has(i.id)))}>{p.n}</button>)}</small></div>
      </section>

      <section className="fa-ask-block">
        <h3>{tr("Document details")}</h3>
        <div className="fa-import-grid">
          <Field label={tr("Title")}><input value={m.title} onChange={e => set("title", e.target.value)} /></Field>
          <Field label={tr("Publisher")}><input value={m.publisher} onChange={e => set("publisher", e.target.value)} /></Field>
          <Field label={tr("Type")}><select value={m.type} onChange={e => set("type", e.target.value)}><option value="">{tr("Choose…")}</option>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label={tr("Edition or revision")}><input value={m.edition} onChange={e => set("edition", e.target.value)} /></Field>
          {(m.type === "published_code" || m.type === "local_amendment") && <Field label={tr("Standard")}><input value={String(m.scope.standard ?? "")} onChange={e => setScope("standard", e.target.value)} placeholder={tr("nfpa13")} /></Field>}
          {m.type === "local_amendment" && <><Field label={tr("Jurisdiction")}><input value={String(m.scope.jurisdiction ?? "")} onChange={e => setScope("jurisdiction", e.target.value)} placeholder={tr("san_francisco")} /></Field>
            <Field label={tr("Amends edition")}><input value={String(m.scope.amendsEdition ?? "")} onChange={e => setScope("amendsEdition", e.target.value)} /></Field></>}
          {m.type === "manufacturer" && <Field label={tr("Catalog product ids")} hint={tr("Comma separated")}><input value={Array.isArray(m.scope.productIds) ? (m.scope.productIds as string[]).join(", ") : ""} onChange={e => setScope("productIds", e.target.value.split(",").map(x => x.trim()).filter(Boolean))} placeholder={tr("spears/CP-010")} /></Field>}
          <Field label={tr("Link to the original (optional)")}><input value={m.url ?? ""} onChange={e => set("url", e.target.value || undefined)} placeholder={tr("https://")} /></Field>
        </div>
        <fieldset className="fa-import-auth">
          <legend>{tr("Authorization")}</legend>
          <Field label={tr("Who authorized this, and on what basis")} hint={tr("A licence, company ownership or a public-domain statement. A subscription alone is not assumed to allow this use.")}>
            <textarea rows={2} value={m.authorization.basis} onChange={e => setAuth("basis", e.target.value)} />
          </Field>
          <label className="fa-check"><input type="checkbox" checked={m.authorization.storeAndIndex} onChange={e => setAuth("storeAndIndex", e.target.checked)} />{tr("We may store and index this document")}</label>
          <label className="fa-check"><input type="checkbox" checked={m.authorization.useWithAi} onChange={e => setAuth("useWithAi", e.target.checked)} />{tr("We may use it with AI features")}</label>
          <div className="fa-import-grid">
            <Field label={tr("Display in answers")}><select value={m.authorization.display} onChange={e => setAuth("display", e.target.value)}><option value="full">{tr("Full passages and page images")}</option><option value="excerpt">{tr("Excerpts only")}</option><option value="reference_only">{tr("Reference only")}</option></select></Field>
            {m.authorization.display === "excerpt" && <Field label={tr("Excerpt limit (characters)")}><input inputMode="numeric" value={m.authorization.maxQuoteChars ?? 400} onChange={e => setAuth("maxQuoteChars", Number(e.target.value))} /></Field>}
          </div>
          <label className="fa-check"><input type="checkbox" checked={m.demonstration} onChange={e => set("demonstration", e.target.checked)} />{tr("This is a demonstration document, not a real source")}</label>
        </fieldset>
      </section>

      {error && <Callout tone="red" title={tr("Not done")}>{error}</Callout>}
      {saved && <p className="small fa-muted">{saved}</p>}
      <div className="fa-actions end fa-review-actions">
        {(open.length > 0 || missingMeta.length > 0) && <small className="fa-muted">{open.length ? `Check ${open.length} reading${open.length === 1 ? "" : "s"}` : ""}{open.length && missingMeta.length ? tr(" and ") : ""}{missingMeta.length ? `add ${missingMeta.join(", ")}` : ""}{" "}{tr("before indexing.")}</small>}
        <Button busy={busy === "save"} disabled={!dirty || !!busy} onClick={() => void save()}>{tr("Save correction")}</Button>
        <Button variant="primary" busy={busy === "index" || record.status === "indexing"} disabled={!!busy || open.length > 0 || missingMeta.length > 0 || isBusy(record.status)} onClick={() => void index()}>
          {record.status === "ready" && !dirty && record.indexedRevision === data.revision.rev ? tr("Index again") : tr("Index document")}
        </Button>
      </div>
    </>}
  </div>;
}

function Steps({ u }: { u: UploadRecord }) {
  const order = ["uploaded", "extracting", "review", "indexing", "ready"] as const;
  const at = u.status === "failed" ? (u.failedStage === "indexing" ? 3 : 1) : order.indexOf(u.status as typeof order[number]);
  const labels = ["Uploaded", "Text read", "Reviewed", "Indexed", "Searchable"];
  return <ol className="fa-steps" aria-label={tr("Processing steps")}>{labels.map((l, i) =>
    <li key={l} className={i < at || (u.status === "ready" && i === at) ? "is-done" : i === at ? (u.status === "failed" ? "is-failed" : "is-now") : ""}>{l}</li>)}</ol>;
}

const methodText = (m?: string) => m === "text" ? "text layer" : m === "mixed" ? "text layer and OCR" : "OCR";

function defaults(u: UploadRecord, s: Snapshot): ReferenceMetadata {
  return {
    title: u.filename.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " "), publisher: "", type: "", edition: "",
    scope: { projectId: s.projectId }, demonstration: false,
    authorization: { basis: "", storeAndIndex: false, useWithAi: false, display: "excerpt", maxQuoteChars: 400 },
  };
}
function metaProblems(m: ReferenceMetadata): string[] {
  const out: string[] = [];
  if (!m.title.trim()) out.push("a title");
  if (!m.publisher.trim()) out.push("the publisher");
  if (!m.type) out.push("the type");
  if (!m.edition.trim()) out.push("the edition");
  if (!m.authorization.basis.trim() || !m.authorization.storeAndIndex || !m.authorization.useWithAi) out.push("the authorization");
  return out;
}
