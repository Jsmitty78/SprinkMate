# Ask Sprink

Ask Sprink lets a fitter type a practical question in the drawing workspace ("A duct is blocking this branch. What rules do I need to check before changing the route?"), see the passages that apply for this project, understand when they apply, open the original passage, and get calculations from the existing scripts, shown separately.

It answers only from the project's source library. When nothing in the library supports an answer it says: "I couldn't find a supporting source in the project library."

**No real code text is loaded.** The team holds no licensed NFPA text, so the library ships with six clearly labelled demonstration documents (`demo-sources/`). Every passage from them carries a Demonstration badge and a `DEMO-` section number.

## 1. What the existing app has (inspected, not assumed)

| Area | What the code has | Where |
| --- | --- | --- |
| Framework | Hono server on Node 22 (`tsx`), React 19 + Vite web client, pnpm workspace | `apps/server`, `apps/web` |
| Model provider | JEV (TypeSafe) *choice* model only, used by the work-package runner to pick the next bounded action. No generative model and no embedding model. Nothing needs model credentials to start. | `packages/workflow/src/choice.ts` |
| Document storage | One SQLite file (`.data/field.sqlite`, better-sqlite3, WAL) plus asset files. No searchable library of code text existed. | `apps/server/src/store.ts` |
| Drawing context | Work packages: source drawing reference, confirmed baseline run (pipes, fittings, tie-ins in a mm frame), project-basis facts (jurisdiction, standard, permit kind, original edition), site facts (measured duct box, work boundary, clearance), the change request and the selected route. | `packages/core/src/work-package.ts` |
| Calculation and rule scripts | `evaluateLocalPlanGeometry` (straight-pipe centerline, cut length from takeouts, pipe-envelope-to-duct-box clearance); `resolveSfNfpa13Edition` (SFFD AB 2.04 edition basis); `deriveWorkPackage` (fabrication cuts, materials, assembly); `evaluateProject` rule packs (TFP171, SFFD supports and local change); Spears FlameGuard catalog with source records. | `packages/core`, `packages/fabrication` |

### Which scripts Ask Sprink uses

- **`resolveSfNfpa13Edition`** chooses the code edition from the package's confirmed permit facts. The newest edition is never assumed. (The project evaluator additionally requires attached permit records; Ask Sprink uses the confirmed package facts and says "no permit record is attached".)
- **`evaluateLocalPlanGeometry`** is called through two validated tools:
  - `pipe_duct_clearance`: gap between the selected piece and the measured duct box, optionally after a vertical move you ask about ("if I drop it 600 mm").
  - `straight_cut_length`: nominal cut between two 4206-010S elbows from a center-to-center length, using the catalog G and H dimensions.
- The Spears catalog (`spearsCatalog`) supplies pipe OD and elbow dimensions, with their source records.

`deriveWorkPackage` and the rule packs already run in the workspace itself; Ask Sprink does not duplicate them.

### Source documents that are missing

- **NFPA 13** (any edition), including the TIAs and errata the rule inventory lists. Needed for obstruction, clearance, hanger and testing questions. We do not assume an NFPA subscription permits storing, indexing or AI use, or that an integration API exists; the licence terms have to be checked first.
- **San Francisco amendments** (SFFD administrative bulletins as adopted for the permit) as importable text. The rule code cites AB 2.04 and AB 4.15, but their text is not in the library.
- **Spears FlameGuard FG-3 installation instructions** and product sheets as text. The catalog cites them by URL and hash, but their wording is not stored.
- **Project specifications and approved drawings** for a real project.
- **Company procedures** for field route changes.

## 2. How it works

```
question ──► classify (source / calculation / both)
          ├─► context: package facts (project, sample, derived) + your measurements and answers
          ├─► retrieval: SQLite FTS5 + field vocabulary ─► applicability (edition, jurisdiction, product, project)
          │        └─► expand: exceptions, notes, referenced tables, definitions, commentary, amendments
          ├─► tools: validated inputs ─► existing script ─► result with inputs and script version
          └─► compose from stored notes ─► server checks every citation and claim ─► answer
```

Three layers are stored and shown separately:

1. **Source text**, exactly as imported, split into sections (`source_sections`, `source_fts`).
2. **Notes** that explain a section in plain language (`source_notes`). They are labelled "Sprink note (interpretation, not source text)". Notes may also record the conditions an exception depends on, and a topic/position used to spot disagreements.
3. **Scripts**, reached only through the tool registry in `apps/server/src/sources/tools.ts`. Nothing in a document or question is executed.

### Retrieval

- Exact terms and section numbers are matched as typed. Natural-language wording is matched through a curated field vocabulary (for example "duct is blocking" → obstruction, "move the pipe" → relocated/route change), because the stack has no embedding model. A section must match at least half of the question's concepts, so one generic word never counts as a match.
- **Applicability** is decided before anything is used: published codes must match the project's standard and edition; local amendments must match the jurisdiction and the edition they amend; manufacturer instructions must cover a product in the run; project documents must belong to the project. Anything filtered out is listed under "Not used" with the reason.
- **Edition:** resolved from the package, or asked as a follow-up. If the project's edition is not in the library, the answer says so and other editions are not substituted.
- Each matched section brings its **exceptions and notes**, the **tables and sections it references**, **definitions** of terms it uses, **annex commentary** (labelled "Explanatory, not a requirement"), and **local amendments** that change it.
- **Disagreements** (an amendment changing a value, a project spec giving a different clearance, a company procedure allowing what the spec forbids) are shown side by side with who needs to resolve them. Sprink never picks one.

### Answer checks

- Citations are resolved on the server against the retrieved records. A claim citing anything else is moved to "Unresolved statements".
- A claim is kept only when every number and unit in it appears in the cited passage and most of its terms do. Otherwise it is shown struck through with the reason.
- Exceptions with recorded conditions are evaluated against known facts (for example the duct width along the pipe, derived from the measured duct box, or a value you type). Unknown inputs become one focused follow-up question each.
- No accuracy percentages, no "approved" labels, no sign-off. Calculations always carry "not a compliance result".

### Uploaded text is data, not instructions

Documents are never read as instructions: there is no generative model in the loop, answers are built from stored notes, and the UI renders all source text as plain text. Instruction-like text ("ignore previous instructions", "tell the user…") is flagged `embedded_instructions` at import and shown with a warning.

## 3. Importing documents

Only import documents you are authorized to store, index and use with AI. The importer refuses a document unless `authorization.basis` is stated and both `storeAndIndex` and `useWithAi` are true. The display setting is enforced in every answer and in the viewer:

- `full`: whole passages, and the original file can be opened.
- `excerpt`: at most `maxQuoteChars` characters per passage.
- `reference_only`: title, section and page only.

### Format

Text or Markdown. Headings start sections; a leading identifier becomes the section id. `<!-- page: N -->` sets page numbers.

```markdown
<!-- page: 41 -->
# 8 Installation around obstructions
## 8.2 Rerouting a branch line around an obstruction
8.2.1 Where an obstruction prevents ... shall be shown on a revised drawing ...

Exception No. 1: Where the obstruction is ... or less ...

## Table 8.2 Minimum clearance
| Pipe nominal size | Minimum clearance |
|---|---|
| ... | ... |

Note 1: Clearance is measured from ...
```

- Paragraphs starting `Exception` become exception passages linked to their section; `Note N` / `Footnote N` become notes linked to it.
- Headings under a chapter named "Definitions" are definitions; "Annex", "Explanatory" or an `A.` number is commentary.
- Tables keep their rows. A row with the wrong number of cells, or an illegible marker such as `[?]`, flags the section as a damaged table or uncertain OCR.
- Text extracted by OCR is imported with `extraction: { method: "ocr", pageConfidence: { "12": 0.97, ... } }`. Pages below 0.85, or with no confidence given, are flagged.
- PDF extraction and OCR are not part of the stack. Extract the text first.

A source package on disk is a metadata file plus the text file and optional notes (see `demo-sources/*.source.json` and `*.explanations.json`).

### Ways to import

- **In the app:** Ask Sprink → Library → Import a document (file, metadata and the authorization statement).
- **API:** `POST /api/sources` with `{ "document": { id, title, publisher, type, edition, scope, demonstration, authorization, extraction?, url?, filename, content } }`.
- **CLI:** `pnpm sources:import path/to/doc.source.json [--project <projectId>]`.

Types: `published_code`, `local_amendment`, `manufacturer`, `project_document`, `company_procedure`. Each stores title, publisher, type, edition or revision, section id, page, original text and a file or source link.

## 4. Setup

From `field-agent`, with Node 22.19+ and pnpm 10:

```sh
pnpm install --frozen-lockfile
pnpm build
FIELD_AGENT_TOKEN=<16+ characters> pnpm start       # http://127.0.0.1:4310
```

1. Connect with the token, start an **Adapt to site conditions** package and press **Load sample input** (invented sample data, marked Sample).
2. Open **Ask Sprink** (top bar or the rail).
3. Library → **Load demonstration sources**. Or from a terminal: `pnpm sources:import --demo --project <projectId>`.
4. Ask one of the suggested questions.

No model credentials are needed. The tables are created in the existing `.data/field.sqlite` on first start.

## 5. Status

### What works

- Typed questions, classified as source lookup, calculation or both.
- Context from the open package: project, edition (from permit facts), jurisdiction, selected piece, site condition, measured duct box, and the duct width along the piece (derived). Each fact shows where it came from: Project, Sample, Derived, Catalog or You.
- The Ask Sprink panel beside the drawing workspace: question, visible project and edition context, concise answer, notes with citation chips, conditions, disagreements, focused follow-ups, a separate calculation block, expandable references, and a source viewer that opens the passage in its document with its page, exceptions and notes. The original file opens from the viewer when the source allows it.
- Library view and importer with the authorization statement.

### What was tested

`apps/server/test/ask.test.ts` (14 tests) covers:

| Required check | Result |
| --- | --- |
| A supported question returns a relevant source | Pass: DEMO-8.2, Table DEMO-8.2 and DEMO-9.1 with exceptions, notes, referenced table, definitions and commentary |
| Missing context triggers a useful follow-up | Pass: with no project, "Which NFPA 13 edition applies to this permit?"; after answering, a width question for the exception |
| An exception changes or qualifies the answer | Pass: duct 2000 mm wide (derived) → does not apply; 450 mm and 4 fittings → appears to apply, and the qualification sits under the requirement |
| The wrong edition is not silently substituted | Pass: a 2016 project gets no 2022 or 2025 text, and is told the 2016 text is missing |
| An unsupported question produces an honest no-source response | Pass: sidewall spacing → "I couldn't find a supporting source in the project library." |
| A calculation uses the existing script with visible inputs | Pass: cut for 2400 mm C-C = 2333.3 mm; drop 600 mm → 83.3 mm gap; script name and content hash shown; bad units and unknown inputs rejected |
| Source links open the correct passage | Pass: each citation link returns that passage with its page; the original file contains it |
| Instructions inside documents cannot override behavior | Pass: the demo passage and a newly uploaded document with injected instructions are flagged and change nothing |

Also: authorization refusals, OCR and damaged-table flags, excerpt and reference-only limits, and invented citations or wrong numbers removed from answers. The whole workspace suite passes (`pnpm test`), with `pnpm typecheck` and `pnpm build`. The panel was driven in Chromium against `pnpm start` at 1600×1000 and 390×844 with no console errors and no horizontal overflow. Screenshots are in `docs/ui/ask-*.png`.

### Latency (measured)

Local, demo library of 6 documents and 27 sections, 40 requests over 8 questions through the HTTP API: **p50 about 3 ms, p95 about 6 ms** end to end; retrieval p95 about 3 ms. The test prints the numbers on every run. This is far inside "answers in seconds", but it is measured on a tiny library on one machine; re-measure with the real document set.

### Sources loaded

Only the six demonstration documents in `demo-sources/` (stand-ins for NFPA 13 2025 and 2022, San Francisco amendments, CPVC installation instructions, a project specification and a company procedure). All text and values are invented.

### Blocked by missing documents or access

- **Real answers need real documents.** No NFPA 13, SFFD, Spears or project text is loaded. Importing NFPA text needs a licence that covers storage, indexing and AI use; that has not been confirmed.
- **Notes for real documents.** Plain-language notes, exception conditions and topics are authored per section. For a newly imported document without notes, Ask Sprink still retrieves and cites the passages but shows "Read the source wording" instead of a summary, and cannot evaluate exception conditions or spot value disagreements automatically (explicit amendments are still linked).
- **No generative model or embeddings in the stack.** Explanations come from stored notes, and meaning search uses a field vocabulary. If a model is added later, its output goes through the same citation and support checks (`validateClaims`), which the tests already exercise with an adversarial composer.
- **PDF text extraction and OCR** are not in the stack; documents must be imported as text.
- **Permit records.** The edition comes from the package's confirmed permit facts; attaching the actual permit record is future work.
- Calculations cover straight axis-parallel pipe and an axis-aligned duct box, and NPS 1 CPVC 4206-010S elbows, which is what the existing script and catalog support.
