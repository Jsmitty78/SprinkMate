import catalog from "../../../../../reference-catalog/boston-ma.json";
import type { SourceDocument } from "./askApi.js";

/** Acquisition register stays separate from imported, searchable source text. */
export function BostonCoverage({ documents }: { documents: SourceDocument[] | null }) {
  return <details className="sk-boston-coverage">
    <summary>Boston source coverage · commercial &amp; residential</summary>
    <p>Check the approved plans, permit date, occupancy and system standard for each job. This list tracks the references we need; it does not decide which rules apply.</p>
    <ul>{catalog.sources.map(source => {
      const editions: string[] = [];
      if (documents) {
        for (const document of documents) {
          if (document.scope.standard === source.standard && !editions.includes(document.edition)) editions.push(document.edition);
        }
      }
      return <li key={source.id}>
        <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>
        <span>{source.category}</span>
        <strong>{documents === null ? "Library status unavailable" : editions.length ? `Imported editions: ${editions.join(", ")} — coverage needs review` : "Not loaded"}</strong>
        <small>{source.status}. {source.note}</small>
      </li>;
    })}</ul>
    <small>Source register checked {catalog.checkedOn}. Imported text and complete coverage are separate checks.</small>
  </details>;
}
