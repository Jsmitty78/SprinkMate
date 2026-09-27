import { useState } from "react";
import type { Snapshot } from "../api.js";
import { Badge, Button, Callout, Field } from "../ui.js";
import { askApi, type SourceDocument } from "./askApi.js";

const TYPES: Array<[string, string]> = [
  ["published_code", "Published code or standard"],
  ["local_amendment", "Local amendment or jurisdiction document"],
  ["manufacturer", "Manufacturer installation instructions"],
  ["project_document", "Project specification or approved drawing"],
  ["company_procedure", "Company procedure"],
];
const TYPE_LABEL = Object.fromEntries(TYPES);

/** The project's source library: what is loaded, and importing documents the team is authorized to use. */
export function Library({ s, docs, onChanged }: { s: Snapshot; docs: SourceDocument[] | null; onChanged: () => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const loadDemo = async () => {
    setBusy("demo"); setError("");
    try { await askApi.loadDemo(s.projectId); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : "Could not load"); } finally { setBusy(""); }
  };
  return <div className="fa-ask-body">
    <p className="fa-muted small">Only documents you are authorized to store, index and use with AI belong here. Source text is stored as imported and kept apart from Sprink's notes.</p>
    {error && <Callout tone="red" title="Could not load">{error}</Callout>}
    {docs === null ? <p className="fa-muted">Loading…</p> : docs.length === 0
      ? <Callout tone="neutral" title="No documents yet">Import an authorized document, or load the demonstration set to try the flow. The demonstration set is invented text, labelled everywhere it appears.</Callout>
      : <ul className="fa-docs">{docs.map(d => <li key={d.id}>
        <div><strong>{d.title}</strong>{d.demonstration && <Badge tone="sample">Demonstration</Badge>}</div>
        <small>{TYPE_LABEL[d.type] ?? d.type} · {d.edition} · {d.sectionCount} sections · {d.publisher}</small>
        {d.flags.length > 0 && <small className="fa-warn">Flags: {d.flags.map(f => f.replace(/_/g, " ")).join(", ")}</small>}
      </li>)}</ul>}
    <div className="fa-actions">
      <Button busy={busy === "demo"} onClick={() => void loadDemo()}>Load demonstration sources</Button>
      <Button variant={open ? "default" : "primary"} onClick={() => setOpen(!open)}>{open ? "Close import" : "Import a document"}</Button>
    </div>
    {open && <ImportForm s={s} onDone={() => { setOpen(false); onChanged(); }} />}
  </div>;
}

function ImportForm({ s, onDone }: { s: Snapshot; onDone: () => void }) {
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
    <Field label="Text or Markdown file" hint="Use headings like “## 8.2 Title” and page markers “<!-- page: 41 -->”. Extract PDF text first.">
      <input type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" onChange={e => setFile(e.target.files?.[0] ?? null)} />
    </Field>
    <div className="fa-import-grid">
      <Field label="Title"><input value={f.title} onChange={e => set("title", e.target.value)} /></Field>
      <Field label="Publisher"><input value={f.publisher} onChange={e => set("publisher", e.target.value)} /></Field>
      <Field label="Type"><select value={f.type} onChange={e => set("type", e.target.value)}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      <Field label="Edition or revision"><input value={f.edition} onChange={e => set("edition", e.target.value)} /></Field>
      {(f.type === "published_code" || f.type === "local_amendment") && <Field label="Standard"><input value={f.standard} onChange={e => set("standard", e.target.value)} /></Field>}
      {f.type === "local_amendment" && <><Field label="Jurisdiction"><input value={f.jurisdiction} onChange={e => set("jurisdiction", e.target.value)} placeholder="san_francisco" /></Field>
        <Field label="Amends edition"><input value={f.amendsEdition} onChange={e => set("amendsEdition", e.target.value)} /></Field></>}
      {f.type === "manufacturer" && <Field label="Catalog product ids" hint="Comma separated"><input value={f.productIds} onChange={e => set("productIds", e.target.value)} placeholder="spears/CP-010" /></Field>}
      <Field label="Link to the original (optional)"><input value={f.url} onChange={e => set("url", e.target.value)} placeholder="https://" /></Field>
      <Field label="Text came from"><select value={f.extraction} onChange={e => set("extraction", e.target.value)}><option value="text">Digital text</option><option value="ocr">OCR of a scan (flagged)</option></select></Field>
    </div>
    <fieldset className="fa-import-auth">
      <legend>Authorization</legend>
      <Field label="Who authorized this, and on what basis" hint="For example a licence number, company ownership or a public-domain statement. A subscription alone is not assumed to allow this use.">
        <textarea rows={2} value={f.basis} onChange={e => set("basis", e.target.value)} />
      </Field>
      <label className="fa-check"><input type="checkbox" checked={f.store} onChange={e => set("store", e.target.checked)} />We may store and index this document</label>
      <label className="fa-check"><input type="checkbox" checked={f.ai} onChange={e => set("ai", e.target.checked)} />We may use it with AI features</label>
      <div className="fa-import-grid">
        <Field label="Display in answers"><select value={f.display} onChange={e => set("display", e.target.value)}><option value="full">Full passages</option><option value="excerpt">Excerpts only</option><option value="reference_only">Reference only</option></select></Field>
        {f.display === "excerpt" && <Field label="Excerpt limit (characters)"><input inputMode="numeric" value={f.maxQuoteChars} onChange={e => set("maxQuoteChars", e.target.value)} /></Field>}
      </div>
      <label className="fa-check"><input type="checkbox" checked={f.demonstration} onChange={e => set("demonstration", e.target.checked)} />This is a demonstration document, not a real source</label>
    </fieldset>
    {error && <Callout tone="red" title="Not imported">{error}</Callout>}
    <div className="fa-actions end"><Button variant="primary" busy={busy} disabled={!file || !f.title || !f.edition || !f.basis} onClick={() => void submit()}>Import</Button></div>
  </form>;
}
