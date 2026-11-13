# Public Boston-area starter sources

This folder contains **three reviewed Massachusetts state-text packages**, yielding **eight indexed sections**. It does not contain the full Massachusetts codes or the incorporated NFPA/ICC books.

| Package | Included text | Original PDF pages | Indexed sections |
| --- | --- | --- | ---: |
| [Fire-code adoption](ma-adoption.source.json) | 527 CMR 1.04 adoption clause only. | 1 | 1 |
| [Referenced-standard amendments](ma-ch35.source.json) | Massachusetts 10th-edition Chapter 35 amendment sheet. | 1 | 1 |
| [Residential sprinkler amendments](ma-residential-r313.source.json) | R313.1, R313.2 and the source's printed 313.2.1, with three exceptions and the occupancy note. | 20–21 | 6 |

Source review was performed on October 7, 2026; [review and extraction notes](../../docs/boston-source-findings.md) record the exact coverage and provenance. The state PDFs identify themselves as unofficial copies and direct readers to the Secretary of the Commonwealth for official copies. No full incorporated model-code or NFPA book is bundled.

From `sprink`:

```sh
pnpm sources:import reference-sources/boston-public --check
pnpm sources:import reference-sources/boston-public
```

The first command validates all packages in temporary storage. The second imports the batch into the configured library. Source IDs are immutable: use a new ID for a revised edition, and never re-label older text as a newer edition.

On November 13, 2026, validation-only import passed for all three packages. This checks package structure and import behavior, not complete coverage, current legal applicability or retrieval accuracy.
