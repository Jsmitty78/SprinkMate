import { useEffect, useId, useState } from "react";
import { tr } from "../locale.js";
import { Badge, Button, Callout, Spinner } from "../ui.js";
import { askApi, type SectionView, type SourceDocument } from "./askApi.js";

const TYPES: Record<string, string> = {
  published_code: "Code or standard", local_amendment: "Local amendment",
  manufacturer: "Manufacturer instructions", company_procedure: "Company procedure",
  project_document: "Project document",
};

export function SourceLibrary({ documents, onRefresh, loading }: { documents: SourceDocument[]; onRefresh: () => void; loading: boolean }) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const filterId = useId();
  const query = filter.trim().toLocaleLowerCase();
  const visible = documents.filter(d => [d.title, d.publisher, d.edition, ...Object.values(d.scope).flat()].join(" ").toLocaleLowerCase().includes(query));
  const current = documents.find(d => d.id === selected);
  return <section className="fa-source-library" aria-label={tr("Available references")}>
    <header><h3>{tr("Available references")} <span>({documents.length})</span></h3>
      <Button variant="quiet" busy={loading} onClick={onRefresh}>{tr("Refresh library")}</Button></header>
    {!documents.length ? <Callout tone="neutral" title={tr("Your reference library is empty")}>
      {tr("Add reviewed source documents before searching. Sample documents are not part of this library.")}
    </Callout> : <>
      <label className="fa-field" htmlFor={filterId}><span>{tr("Find a reference")}</span>
        <input id={filterId} type="search" value={filter} onChange={e => setFilter(e.target.value)} placeholder={tr("Title, edition, publisher or product")} /></label>
      {!visible.length && <p className="fa-muted">{tr("No references match this filter.")}</p>}
      <ul className="fa-library-list">{visible.map(d => <li key={d.id}>
        <div><strong>{d.title}</strong><p>{d.publisher} · {d.edition}</p>
          <div className="fa-library-tags"><Badge>{tr(TYPES[d.type] ?? d.type)}</Badge>
            {typeof d.scope.standard === "string" && <Badge>{d.scope.standard}</Badge>}
            {typeof d.scope.jurisdiction === "string" && <Badge>{d.scope.jurisdiction}</Badge>}
            {d.demonstration && <Badge tone="sample">{tr("Demonstration")}</Badge>}
          </div>
          {Array.isArray(d.scope.productIds) && <small>{d.scope.productIds.join(" · ")}</small>}
          {typeof d.scope.amendsEdition === "string" && <small>{tr("Amends edition {edition}", { edition: d.scope.amendsEdition })}</small>}
          <small>{tr("{count} indexed sections", { count: d.sectionCount })} · {tr(d.authorization.display === "full" ? "Full text available" : d.authorization.display === "excerpt" ? "Excerpts only" : "Reference only")}</small>
        </div>
        <Button aria-expanded={current?.id === d.id} onClick={() => setSelected(current?.id === d.id ? null : d.id)}>{tr(current?.id === d.id ? "Close reference" : "Read reference")}</Button>
      </li>)}</ul>
      {current && <ReferenceReader key={current.id} id={current.id} />}
    </>}
  </section>;
}

function ReferenceReader({ id }: { id: string }) {
  const [result, setResult] = useState<{ document: SourceDocument; sections: SectionView[] } | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(false); setResult(null);
    askApi.document(id, controller.signal).then(value => { if (!controller.signal.aborted) setResult(value); }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [id, attempt]);
  if (error) return <Callout tone="red" title={tr("Could not load the reference")} action={<Button onClick={() => setAttempt(n => n + 1)}>{tr("Retry")}</Button>} />;
  if (!result) return <Spinner label={tr("Loading reference…")} />;
  const { document: doc, sections } = result;
  const original = doc.url && /^https?:\/\//i.test(doc.url) ? doc.url : null;
  return <article className="fa-reference-reader" aria-label={doc.title}>
    <header><h3>{doc.title}</h3><p>{doc.publisher} · {doc.edition}</p>
      {original && <a href={original} target="_blank" rel="noreferrer">{tr("Open original source")}</a>}</header>
    {doc.authorization.display !== "full" && <p className="fa-muted">{tr("Display is limited by this source’s permissions. Use the original for the complete wording.")}</p>}
    {sections.map(s => <details key={s.key} className="fa-reference-section">
      <summary>{s.heading}{s.pageStart !== null && <small> · {tr("Page {page}", { page: s.pageStart })}</small>}</summary>
      {s.flags.length > 0 && <p className="fa-warn">{tr("This passage has extraction flags. Check the original before using it.")}</p>}
      {s.text ? <blockquote className="fa-wording">{s.text}</blockquote> : <p className="fa-muted">{tr("Reference only. Read the wording in the original source.")}</p>}
      {s.limited === "excerpt" && <small>{tr("Excerpt only; the complete passage may include further conditions.")}</small>}
    </details>)}
  </article>;
}
