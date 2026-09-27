# Ask Sprink

Ask Sprink lets a fitter type a practical question in the drawing workspace ("A duct is blocking this branch. What rules do I need to check before changing the route?"), see the passages that apply for this project, understand when they apply, open the original passage.

Documents and job-site photos can be uploaded, dragged in, pasted or taken with a phone camera. A reference document is read (native PDF text, or OCR for scans and images), reviewed and corrected by a person, then indexed into the library; answers cite the exact revision and open the original page with the passage highlighted. A site photo attached to a question is context only, never a code source.

It answers only from the project's source library. When nothing in the library supports an answer it says: "I couldn't find a supporting source in the project library."

**No real code text is loaded.** The team holds no licensed NFPA text, so the library ships with six clearly labelled demonstration documents (`demo-sources/`). Every passage from them carries a Demonstration badge and a `DEMO-` section number.

## 1. What the existing app has (inspected, not assumed)

| Area | What the code has | Where |
| --- | --- | --- |
| Framework | Hono server on Node 22 (`tsx`), React 19 + Vite web client, pnpm workspace | `apps/server`, `apps/web` |
| Model provider | GPT-6 Astra uses Pi standard Agent tools; JEV (TypeSafe) selects one verification rule. Startup requires OpenAI credentials; rule selection requires TypeSafe credentials. Project-local keys take precedence. | `packages/workflow/src/choice.ts` |
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
question ──► JEV source search
          ├─► context: package facts (project, sample, derived) + your measurements and answers
          ├─► retrieval: JEV Choice + Noul over registered clauses ─► applicability (edition, jurisdiction, product, project)
          │        └─► expand: explicit exceptions, notes, references and amendments
          └─► retrieve stored original text and exact citations ─► answer
```

Source text and reviewed metadata stay separate:

1. **Source text**, exactly as imported, split into sections (`source_sections`).
2. **Notes** that explain a section in plain language (`source_notes`). They are labelled "Sprink note (interpretation, not source text)". Notes may also record the conditions an exception depends on, and a topic/position used to spot disagreements.
Ask has no classification or direct calculation route. Its former cut-length and pipe/duct-clearance wrappers, numeric question parser and calculation UI were removed. Pi business calculations and the independent 47-rule selection/execution workflow are unchanged.

### Retrieval

- Ask sends the registered clause identifiers and text to pinned `jev-1.13.0`. Choice ranks passages; a Noul checks whether the batch contains an answer, and per-passage Nouls select supporting passages. Both existence and support must exceed 0.5; the highest-ranked passage is never a fallback for a missing answer. No BM25 shortlist, synonym dictionary, or keyword relevance filter runs in Ask.
- Every eligible clause is evaluated. Batches contain at most 255 candidates, with at most four requests in flight per selection. The conservative UTF-8 byte budget reserves serialization headroom below the official 64k total and 32k state-plus-longest-question token limits. A single oversized clause returns `source_section_too_large` and must be re-sectioned; it is never truncated. If an answer requires combining evidence across batches and no individual batch establishes existence, the lookup conservatively returns no supporting source.
- JEV evaluates supplied text; it does not browse or fetch sources. Keys returned by the service are validated against that request and resolved to stored originals. Missing credentials, timeouts, invalid responses and API failures return errors without legacy fallback or automatic retries. `TYPESAFE_API_KEY` in `field-agent/.env.local` takes precedence over the inherited environment, as in the existing rule workflow.
- Other projects and sources without AI authorization are never sent. Applicable and inapplicable documents are evaluated separately so another edition cannot supply the applicable batch's answer-existence verdict.
- Specifications: [semantic search](https://docs.typesafe.ai/cookbooks/semantic_find), [model limits](https://docs.typesafe.ai/models), [HTTP API](https://docs.typesafe.ai/api).
- **Applicability** is decided before anything is used: published codes must match the project's standard and edition; local amendments must match the jurisdiction and the edition they amend; manufacturer instructions must cover a product in the run; project documents must belong to the project. Anything filtered out is listed under "Not used" with the reason.
- **Edition:** resolved from the package, or asked as a follow-up. If the project's edition is not in the library, the answer says so and other editions are not substituted.
- Selected sections bring explicitly linked exceptions, notes, references and amendments. Definitions and commentary are candidates for JEV selection; no term-match or topic-match expansion adds them. The Pi inspect tool uses the same JEV selector for source queries. The old dictionary, BM25 method and FTS creation/indexing are removed. Import readiness checks stored section completeness. Existing database FTS tables are left inert to preserve stored data, and deleted documents are still removed from them.
- **Disagreements** (an amendment changing a value, a project spec giving a different clearance, a company procedure allowing what the spec forbids) are shown side by side with who needs to resolve them. Sprink never picks one.

### Answer checks

- Citations are built on the server from retrieved records only; service responses cannot invent a source identifier.
- Answers quote stored text verbatim, subject to display permissions. There is no generated paraphrase or lexical claim-support heuristic. Reviewed notes remain separately visible as source metadata.
- Exceptions with recorded conditions are evaluated against known facts (for example the duct width along the pipe, derived from the measured duct box, or a value you type). Unknown inputs become one focused follow-up question each.
- No accuracy percentages, no "approved" labels, no sign-off.

### Uploaded text is data, not instructions

Documents are never read as instructions: there is no generative model in the loop, answers quote stored original text, and the UI renders all source text as plain text. Instruction-like text ("ignore previous instructions", "tell the user…") is flagged `embedded_instructions` at import and shown with a warning.

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

A source package on disk is a metadata file plus the text file and optional notes (see `demo-sources/*.source.json` and `*.explanations.json`).

### Ways to import

- **In the app:** Ask Sprink → Library → Import a document (file, metadata and the authorization statement).
- **API:** `POST /api/sources` with `{ "document": { id, title, publisher, type, edition, scope, demonstration, authorization, extraction?, url?, filename, content } }`.
- **CLI:** `pnpm sources:import path/to/doc.source.json [--project <projectId>]`.

Types: `published_code`, `local_amendment`, `manufacturer`, `project_document`, `company_procedure`. Each stores title, publisher, type, edition or revision, section id, page, original text and a file or source link.

## 3b. Uploading documents and site photos

The upload code lives in `apps/server/src/uploads/` (format sniffing, decoding, OCR, PDF, extraction, the upload service and its routes) and the web pieces in `apps/web/src/workbench/ask/` (`uploads.tsx`, `Review.tsx`, `Library.tsx`, `AskPanel.tsx`). The format, decode, OCR and PDF modules have no Ask-specific logic and could be shared with other upload features.

### Formats and decoders

The server checks the file's bytes, never its name or browser type. Decoders run inside the Node server; nothing is sent to an outside service.

| Format | Decoder | Notes |
| --- | --- | --- |
| PDF (text, scanned, mixed) | `pdfjs-dist` 6 (legacy Node build) with `@napi-rs/canvas` | Native text per page; pages with little text or with images are rendered at 3× and OCR'd. Password-protected and damaged files are refused with a message. |
| JPEG, PNG, WebP, TIFF (multi-page), static GIF, AVIF | `sharp` | EXIF orientation applied. Animated GIFs are refused. |
| HEIC / HEIF (HEVC, iPhone) | `libheif-js` (WebAssembly) | The prebuilt `sharp` only decodes AVIF inside HEIF, so HEVC goes through libheif, which applies the rotation and mirror transforms. |
| BMP | `bmp-ts` | |
| OCR | `tesseract.js` 7 with the `@tesseract.js-data/eng` best-int model, loaded from `node_modules` | English only. Small images are upscaled 2× before OCR; no network access at run time. |

**Limits:** 40 MB per file, 60 PDF pages, 100 megapixels and 12,000 px on the long side per image. Page images are stored up to 3,200 px on the long side so small labels stay readable; previews are 640 px. Corrupt, locked, unsupported, oversized and animated files fail with a message that says what to do.

### Lifecycle

`uploaded → extracting → review → indexing → ready`, or `failed` with the stage and a Retry. Site photos go straight to ready ("Ready as context") after extraction. Work interrupted by a restart is marked failed and can be retried. A document is marked ready only after a search finds it.

- **Review** lists what needs a person: numbers, fractions and dimensions OCR'd with low confidence, low-confidence lines, table rows whose structure may be wrong, pages with no text, and instruction-like text (flagged, not blocking). Each blocking item must be checked before indexing. The text can be corrected in place; the extracted text is kept as revision 1 and each correction becomes a new revision (`upload_revisions`). Metadata and the authorization statement are entered in the same screen.
- **Citations** carry the upload revision and whether it is "as extracted" or "corrected", plus the page and the passage's bounding boxes, so **Open source** shows the page image with the passage highlighted. **Original file** opens the stored original at that page.
- **The same reference file uploaded twice is refused** and points to the copy already in the library, so answers do not repeat every quote.
- **Files are private.** Originals, page images and previews are stored under the data directory with owner-only permissions and served only on `/api/uploads/*` with the app token (page images and previews `Cache-Control: private`; originals `private, no-store` with a sandboxing CSP). The web client fetches them with the token into object URLs. Logs record only error names, never file contents.

### Site photos

When files are added in the Ask tab, Sprink asks whether to **attach them to this question** (site photo or drawing) or **add them to the source library**. An attached photo:

- appears under "Site photos: context for this question, not a code source" with each readable line labelled Marking, Dimension text or Text, and "Read, not confirmed" or "Unclear";
- never appears among source references and cannot be indexed (`409 site_photo_not_source`);
- raises a follow-up ("Does the marking read …?") when a product marking is unclear, and records your answer as yours;
- never provides a measurement: numbers in a photo are shown as "not measurements" and are not used in calculations, because a photo has no scale.

Sprink extracts readable text from photos. It does not describe visual content (pipe routing, fittings) because no vision model is in the stack.

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

Ask requires `TYPESAFE_API_KEY`. The tables are created in the existing `.data/field.sqlite` on first start.

To try uploads, open Library → **Upload document** (or drop a file) and use the invented fixtures in `fixtures/uploads/` (for example `native-text-manual.pdf`, `scanned-spec.pdf`, `site-label-iphone.heic`). `pnpm install` brings every decoder and the OCR model; nothing is downloaded at run time.

**Fixtures** are generated by `fixtures/uploads/generate.py` (Pillow, pillow-heif for real HEVC HEIC with an `irot` rotation, reportlab for PDFs, including an encrypted one): `python3 -m pip install pillow pillow-heif reportlab && python3 fixtures/uploads/generate.py`.

**Browser test** of the whole upload-to-answer flow, against a server started with a fresh `FIELD_AGENT_DATA_DIR`:

```sh
FIELD_AGENT_DATA_DIR=$(mktemp -d) FIELD_AGENT_TOKEN=<token> pnpm start
E2E_TOKEN=<token> node scripts/e2e-ask-uploads.mjs    # needs Playwright + Chromium; PLAYWRIGHT_MODULE=<path to playwright/index.js> if installed globally
```

## 5. Status

### What works

- Typed questions search registered original source text.
- Context from the open package: project, edition (from permit facts), jurisdiction, selected piece, site condition, measured duct box, and the duct width along the piece (derived). Each fact shows where it came from: Project, Sample, Derived, Catalog or You.
- The Ask Sprink panel beside the drawing workspace: question, visible project and edition context, concise answer, notes with citation chips, conditions, disagreements, focused follow-ups, expandable references, and a source viewer that opens the passage in its document with its page, exceptions and notes. The original file opens from the viewer when the source allows it.
- Library view and importer with the authorization statement.
- Uploads of PDF (text, scanned, mixed), JPEG, PNG, HEIC/HEIF, WebP, TIFF, BMP and static GIF by file picker, drag and drop, clipboard paste and phone camera; review and correction before indexing; revision-exact citations that open the original page with the passage highlighted; site photos as context only.
- The question, measurements and attachments are kept in the browser if a request fails or the page reloads; failed uploads and questions have Retry.

### What was tested

JEV migration verification: workspace typecheck, 48 files / 871 tests, and web build passed without paid API calls. After updating to main `932c05f` (including Pi fix `3d23fa2`), server typecheck and 60 workflow/work-package/integration tests passed. The integration tests explicitly confirm that Pi uses the shared selector and excludes other projects. Search decisions are scripted in downstream regressions; live JEV quality and the running server remain unverified.

`apps/server/test/semantic.test.ts` checks the JEV protocol, no-answer behavior, malformed responses and bounded batching without calling a paid API. `apps/server/test/ask.test.ts` uses scripted selection decisions to cover downstream behavior:

| Required check | Result |
| --- | --- |
| A supported question returns a relevant source | Pass: DEMO-8.2, Table DEMO-8.2 and DEMO-9.1 with exceptions, notes, referenced table, definitions and commentary |
| Missing context triggers a useful follow-up | Pass: with no project, "Which NFPA 13 edition applies to this permit?"; after answering, a width question for the exception |
| An exception changes or qualifies the answer | Pass: duct 2000 mm wide (derived) → does not apply; 450 mm and 4 fittings → appears to apply, and the qualification sits under the requirement |
| The wrong edition is not silently substituted | Pass: a 2016 project gets no 2022 or 2025 text, and is told the 2016 text is missing |
| An unsupported question produces an honest no-source response | Pass: sidewall spacing → "I couldn't find a supporting source in the project library." |
| Source links open the correct passage | Pass: each citation link returns that passage with its page; the original file contains it |
| Instructions inside documents cannot override behavior | Pass: the demo passage and a newly uploaded document with injected instructions are flagged and change nothing |

Also: authorization refusals, OCR and damaged-table flags, excerpt and reference-only limits, and unknown service identifiers rejected. Historical pre-migration verification included the workspace suite, typecheck and build. The panel was driven in Chromium against `pnpm start` at 1600×1000 and 390×844 with no console errors and no horizontal overflow. Screenshots are in `docs/ui/ask-*.png`.

### Upload flow tests

`apps/server/test/uploads.test.ts` (22 tests) runs the real decoders and OCR on the fixtures, with scripted JEV selection and one stored OCR-confidence edit to simulate an unreadable scan:

| Check | Result |
| --- | --- |
| Each format decodes | Pass: PNG, WebP, BMP, GIF, TIFF (2 pages), JPEG, HEIC, and a JPEG named `.heic` (detected as JPEG) |
| Rotated iPhone HEIC is upright and its text read | Pass: stored 4032×3024 with `irot`, decoded 2400×3200 (scaled to the limit), "SPEARS FlameGuard CPVC" read. The fixture is checked for `ftypheic`, `hvcC` and `irot` boxes. |
| Scanned and native-text PDFs become searchable | Pass: S-5.2.1 from the native PDF and PS-2.4 from the scanned PDF are quoted in answers; the image part of a mixed page is OCR'd |
| Unclear OCR requires review | Pass: indexing is refused until items are checked; the corrected revision 2 is cited |
| Uploaded source answers a new question | Pass: the answer quotes the uploaded wording, cites revision and page 2 with a region; nothing is hardcoded |
| Exceptions qualify the answer | Pass: the S-4.1 exception shows as "may change this; read its wording" |
| Wrong edition not substituted | Pass: an uploaded 2019 code edition is excluded for a 2025 project |
| No source | Pass |
| Site photos are context | Pass: never cited, not indexable, dimension text not a measurement, unclear marking asks to confirm |
| Embedded instructions | Pass: the injected passage is flagged and never quoted |
| Refusals | Pass: unsupported, locked, damaged, animated, oversized, duplicate |
| Retry | Pass: work interrupted by a restart is retried |

`scripts/e2e-ask-uploads.mjs` drives the built app in Chromium against a live server (real decoders and OCR). Historical pre-JEV verification passed 28 of 28 checks: both PDFs indexed through the review screen, unclear OCR blocked, answers from the uploads, citation opens page 2 highlighted, each format uploaded through picker, drag and drop or paste and previewed, HEIC and EXIF JPEG upright, photos as context, failed question and failed upload retried (the failures are simulated by aborting the request in the browser), question and attachments survive a reload, no-source answer, the former calculation UI, phone layout without overflow, no console errors. Screenshots: `docs/ui/ask-upload-*.png`.

### Latency (measured)

Upload flow, one local run on a clean server (in-container CPU, first request includes module and WebAssembly loading):

| Sample file | Extraction | Indexing |
| --- | --- | --- |
| `native-text-manual.pdf` (2 pages, text) | 1.8 s (pdf.js load 1.2 s, text 0.6 s) | 5 ms |
| `scanned-spec.pdf` (2 pages, scanned) | 4.9 s (render 2.9 s, OCR 2.0 s) | 2 ms |
| `site-label-iphone.heic` | 3.4 s (decode 0.9 s, OCR 0.7 s) | n/a (context) |
| `site-duct-rotated.jpg` | 1.8 s (OCR 0.4 s) | n/a |
| `two-page.tiff` | 3.5 s | n/a |

The extraction timings above are historical, before the JEV migration. They do not measure current search latency. The old local-search latency loop was removed. JEV transport time is reported in `timings.modelMs`; live API quality, latency and browser behavior after this migration have not been verified by a paid run.

### Sources loaded

Only the six demonstration documents in `demo-sources/` (stand-ins for NFPA 13 2025 and 2022, San Francisco amendments, CPVC installation instructions, a project specification and a company procedure). All text and values are invented.

### Blocked by missing documents or access

- **Real answers need real documents.** No NFPA 13, SFFD, Spears or project text is loaded. Importing NFPA text needs a licence that covers storage, indexing and AI use; that has not been confirmed.
- **Notes for real documents.** Plain-language notes, exception conditions and topics are authored per section. For a newly imported document without notes, Ask Sprink still retrieves and cites the passages but quotes the original text, and cannot evaluate exception conditions or spot value disagreements automatically (explicit amendments are still linked).
- **JEV selection is not a generated answer.** Answers use verbatim source text with stored citations; reviewed notes remain separate metadata. No script is selected or executed from a retrieved passage; the independent Pi rule loop is unchanged.
- **OCR is English only** and reads text, not drawings: there is no vision model to describe what a photo shows.
- **The HEIC fixture was produced with libheif/x265**, not shot on an iPhone. It has the same HEVC coding and `irot` rotation as an iPhone portrait photo; a real iPhone photo has not been tested.
- Page highlighting uses the extracted line boxes; a passage whose text was corrected heavily may lose its highlight and open at the page instead.
- **Permit records.** The edition comes from the package's confirmed permit facts; attaching the actual permit record is future work.
