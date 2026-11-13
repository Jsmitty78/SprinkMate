# SprinkMate development progress

**Report updated November 13, 2026.** This report describes completed repository work, supporting evidence and remaining development. The implementation and research milestones were committed on October 7, 2026; Source research was last reviewed on October 7; package validation was repeated on November 13.

SprinkMate extends the Innovation Cup Sprink prototype toward a practical reference and field-work tool for Boston sprinkler fitters. The focus is commercial and residential work, with source wording, edition, jurisdiction, exceptions and original-page references kept visible.

## Delivered in the Boston work

| Work | Result | Inspect it |
| --- | --- | --- |
| Reference reading | A searchable library list with expandable clauses and links to the original sources. Reading works without an AI key. | [Library interface](sprink/apps/web/src/workbench/ask/SourceLibrary.tsx) |
| Search scope | A document selector carries explicit source IDs to retrieval; unselected sources and stale selections are covered by tests. | [Search tests](sprink/apps/server/test/rules-search.test.ts) |
| Database imports | Recursive package imports, validation-only mode, immutable IDs, permission declarations and an atomic batch transaction. | [Importer](sprink/scripts/import-sources.ts) · [Tests](sprink/apps/server/test/source-import-cli.test.ts) |
| Boston coverage register | 16 entries covering the core installation standards, related standards, Massachusetts amendments and individual BFD documents. | [Register](sprink/reference-catalog/boston-ma.json) |
| Research provenance | A manifest of nine government PDFs totaling 243 pages, plus a BFD guide text snapshot, with source URLs and SHA-256 hashes. Original snapshots remain local and outside Git. | [Acquisition manifest](sprink/reference-catalog/boston-downloads-2026-10-07.json) |
| Reviewed source text | Three importable state packages, eight indexed sections, including three linked residential exceptions. | [Packages and coverage](sprink/reference-sources/boston-public/README.md) |
| Local setup and checks | A local launcher, pinned Node/pnpm versions, import instructions and a repeatable reference-library browser check. | [Setup](sprink/docs/boston-setup.md) · [Verification](sprink/docs/sprinkmate-verification.md) |

The nine PDFs are a research archive, not 243 pages of fully reviewed search content. The source register identifies acquisition targets and provenance; it is not itself an executable rules database.

## Commit milestones

| Date | Milestone | Repository evidence |
| --- | --- | --- |
| October 7, 2026 | Imported the Innovation Cup app and pilot backend history into SprinkMate. | [8f016a5](https://github.com/Jsmitty78/SprinkMate/commit/8f016a5) |
| October 7, 2026 | Added the Boston reference-library foundation, document selection, importer improvements and supporting tests. | [a32ded7](https://github.com/Jsmitty78/SprinkMate/commit/a32ded748227c2cba7aa10d762abdf878560f4fa) |
| October 7, 2026 | Expanded the source register and added reviewed Chapter 35 and residential R313 amendment packages. | [61d3e4a](https://github.com/Jsmitty78/SprinkMate/commit/61d3e4a539115727e55c82d467555abb4af61d46) |

## Validation evidence

- The [foundation verification record](sprink/docs/sprinkmate-verification.md) records 340 passing tests, passing typecheck/build and a local browser check on October 7.
- GitHub Actions passed installation, typecheck, tests and build for [a32ded7](https://github.com/Jsmitty78/SprinkMate/actions/runs/37573533667) and [61d3e4a](https://github.com/Jsmitty78/SprinkMate/actions/runs/37578338118). The links identify the exact commits and dates tested.
- On November 13, `pnpm sources:import reference-sources/boston-public --check` validated all three packages: 1 adoption section, 1 Chapter 35 section and 6 residential sections. This check uses temporary storage and leaves the destination library unchanged.
- Original-page comparison and the retention of residential exceptions are documented in the [October 7 source review](sprink/docs/boston-source-findings.md).

## Existing workflows retained

The Innovation Cup app contributes drawing review, material and assembly preparation, site-change proposals, PDF/CSV export, mobile voice entry, authentication and the pilot backend. The original contributors and commits remain in the repository history. The Boston additions are listed above.

See the [demo and workflow recordings](README.md#see-the-workflows) and the [upstream project](https://github.com/my-name-is-yu/InnovationCup).

## Next development milestones

- [ ] Obtain authorized NFPA 13, 13R and 13D content for the required editions and document its permitted uses.
- [ ] Expand reviewed Massachusetts/Boston coverage, including tables and cross-references, with explicit source revision dates.
- [ ] Configure live retrieval and evaluate it against source-backed questions, including wrong-edition cases, exceptions and unsupported questions.
- [ ] Review the evaluation with a sprinkler fitter/designer before making field-accuracy claims.
- [ ] Complete the persistent-storage, authentication and deployment checks for a hosted pilot. See the [pilot readiness checklist](ASK_PILOT_READINESS.md).

The current deliverable is a local prototype with reviewed source packages and implementation evidence. Full code coverage, live retrieval evaluation and a hosted pilot remain development milestones.
