# SprinkMate: Boston pilot setup

SprinkMate preserves the Innovation Cup drawing, materials, site-change and export workflows, and adds a Boston reference-library foundation. The public starter package contains only 527 CMR 1.04, the Massachusetts fire-code adoption clause. **The NFPA installation books and full state/local amendments are not loaded.**

## Start locally

Use Node 22.19.0 and pnpm 10.17.1. Native SQLite must be installed under the same Node version used to run the app.

```sh
git clone https://github.com/Jsmitty78/SprinkMate.git
cd SprinkMate/sprink
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm sources:import reference-sources/boston-public --check
pnpm sources:import reference-sources/boston-public
pnpm build
pnpm start
```

Open http://127.0.0.1:4310/codes and enter the local `.data/access-token` value. Reference reading works without an AI key. Set `TYPESAFE_API_KEY` in `.env.local` for JEV reference retrieval. The drawing/site agent additionally needs `OPENAI_API_KEY`. Never put keys or the access token in Git, URLs, screenshots or browser source.

## Establish the code basis

The [source acquisition register](../reference-catalog/boston-ma.json) is separate from the source-text database. It records what is verified, what is still needed and the official links.

- [Massachusetts building code, 780 CMR](https://www.mass.gov/massachusetts-state-building-code-780-cmr): base and residential volumes. The [state transition notice](https://www.mass.gov/news/concurrency-period-for-9th-and-10th-edition-of-the-state-building-code-extended-until-june-30-2025) says ninth-edition permit applications had to be filed by June 30, 2025. Review older permits separately.
- [Massachusetts fire code, 527 CMR 1.00](https://www.mass.gov/info-details/massachusetts-fire-code): NFPA 1 (2021) with state amendments. The official page lists amendments effective May 12, 2023.
- NFPA 13, NFPA 13R and NFPA 13D need **individually confirmed adopted editions and licensed text**. Do not pick the newest edition automatically. Verify the referenced-standard tables, approved plans and local authority's requirements. Residential work is not automatically eligible for 13R or 13D.
- [Boston sprinkler permit guidance](https://www.boston.gov/boston-permitting/install-or-replace/install-sprinkler-heads), current BFD requirements, approved project documents and exact manufacturer model instructions need their own source records. An individual project's public drawings are not a citywide rule.

Record the permit/application date, occupancy, new/existing work, adopted standard and edition, amendment revisions, and the approved design basis before using results on a job. Lookup shows evidence; it does not determine project applicability.

## Build the rules database

SQLite stores original document metadata, exact sections, page references, permissions and extraction flags. Explanations are stored separately from source wording. Original wording must not be replaced with an AI paraphrase. Exceptions, referenced definitions, table footnotes and conditions must be retained with their parent clauses.

Keep licensed books and private manifests in a folder outside Git. Permission to read a book does not by itself establish permission to store its text or send it to an AI service. Record the actual authorized use in each package.

A package is a `.source.json` manifest plus its text file. Use the [public starter manifest](../reference-sources/boston-public/ma-adoption.source.json) as the format example, replacing every field with the real source's metadata and permissions. Text uses Markdown section headings and `<!-- page: N -->` markers. Each edition has a distinct immutable document ID; local amendments carry `scope.standard`, `scope.jurisdiction` and `scope.amendsEdition`. Manufacturer documents carry exact product IDs.

```sh
pnpm sources:import /absolute/path/to/reviewed-packages --check
pnpm sources:import /absolute/path/to/reviewed-packages
```

`--check` validates the batch in temporary storage, without touching the destination. Real import is atomic: one invalid document rolls the entire batch back. Existing-ID conflicts are checked during import. This command validates structure and permissions declarations, **not legal correctness, license validity, OCR accuracy or completeness**.

Read each imported reference in the app and compare its clauses, numeric values, tables, exceptions and page references against the original. Use “Search within” to restrict a lookup to a specific imported reference; selecting only a base book can omit amendments. “All available references” can return different editions, so compare scope and applicability explicitly.

## Accuracy acceptance before field use

Prepare a private evaluation set with the fitter/designer: ordinary commercial questions, eligible 13R/13D cases, wrong-edition traps, local overrides, exceptions, missing measurements, exact product models, and deliberately unsupported questions. Record expected source IDs, editions, sections and relevant exceptions, not just a prose answer.

For each case, check source recall, wrong-edition/wrong-jurisdiction results, exception visibility, citation/page correctness, faithful wording, and appropriate no-source responses. Missing safety-critical exceptions or invented authority blocks acceptance. Repeat after changing sources or the search provider. Automated software tests cannot establish field accuracy.

The current search scans authorized passages with JEV; it is **not fine-tuning** a model on the books. It returns a clear error when retrieval is unconfigured or exceeds its input/time limits. There is no silent keyword or generative-answer fallback. Large libraries may need a separately evaluated retrieval/indexing design before all books fit.

## Validate changes

```sh
pnpm typecheck
pnpm test
pnpm build
```

Use persistent private storage (`SPRINK_DATA_DIR`, absolute path), authentication and the [pilot deployment checklist](../../ASK_PILOT_READINESS.md) for hosting. A local prototype with missing books or keys is not a completed production deployment.
