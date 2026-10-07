# Boston sprinkler sources found online

Checked October 7, 2026. **Nine government PDFs, 243 pages, plus Boston Fire Department’s consolidated permit guide.** Downloads and imported source text are tracked separately.

## Start with Boston’s current guide

The [BFD consolidated permit guide](https://docs.google.com/document/d/1zVLi3IfuHXyXI_22nHx2AbZAKab2ZmNKs3gRcqm8nXE/edit) says it was last updated **October 5, 2026**. Boston links it from its [official permitting page](https://content.boston.gov/departments/fire-prevention/fire-alarm-system-permitting). It covers adopted editions, permit submissions, impairments, standpipes, repair work and construction fire protection. It is a controlled document that can change; use its live version for current review.

Its edition list identifies **NFPA 13, 13R, 13D, 14, 20 and 24: 2019; NFPA 25: 2020; NFPA 241: 2022**. The 2021 IBC Chapter 35 [publisher reference table](https://shop.iccsafe.org/media/wysiwyg/material/3000S21-Sample.pdf), printed page 35-23, independently lists the three 2019 sprinkler installation standards. These are source-backed acquisition targets, not an automatic ruling on an existing job’s approved code basis.

## NFPA book access

NFPA provides [online code viewing through its standards directory](https://www.nfpa.org/for-professionals/codes-and-standards/list-of-codes-and-standards?l=776). Select the required standard and edition; account/access steps may be required. The following ICC listings provide specific 2019 purchase options, without assuming that the newest edition applies:

| Book | Scope to review |
| --- | --- |
| [NFPA 13 — 2019](https://shop.iccsafe.org/nfpa-13-2019-standard-for-the-installation-of-sprinkler-systems-2019-edition.html) | General sprinkler installation |
| [NFPA 13R — 2019](https://shop.iccsafe.org/nfpa-13r-standard-for-the-installation-of-sprinkler-systems-in-low-rise-residential-occupancies-2019-edition.html) | Eligible low-rise residential occupancies |
| [NFPA 13D — 2019](https://shop.iccsafe.org/nfpa-13d-2019-standard-for-the-installation-of-sprinkler-systems-in-one-and-two-family-dwellings-and-manufactured-homes-2019-edition.html) | Eligible one- and two-family dwellings and manufactured homes |

Full NFPA book text has not been obtained or loaded into SprinkMate. A reading or print purchase does not itself establish app redistribution or AI ingestion rights; an actual content license is still needed for those uses. No purchase was made.

## Government documents downloaded

| Original source | PDF pages | Imported coverage |
| --- | ---: | --- |
| [527 CMR 1.00 Massachusetts fire-code amendments](https://www.mass.gov/doc/massachusetts-527-cmr-100-2021-edition-effective-may-12-2023/download) | 182 | Only the previously imported adoption clause 1.04. |
| [780 CMR 10th edition Chapter 9 fire-protection amendments](https://www.mass.gov/doc/10th-edition-chapter-9-fire-protection-systems/download) | 21 | Not indexed; original retained for further review. |
| [780 CMR 10th edition Chapter 35 referenced-standard amendments](https://www.mass.gov/doc/10th-edition-chapter-35-referenced-standards/download) | 1 | All state amendment wording on page 1; base IBC table not included. |
| [780 CMR residential Chapter 3 building-planning amendments](https://www.mass.gov/doc/10th-edition-residential-chapter-3-building-planning/download) | 31 | Only R313 sprinkler amendments on pages 20–21, including exceptions. |
| [780 CMR residential Chapter 44 referenced standards](https://www.mass.gov/doc/10th-edition-residential-chapter-44-referenced-standards/download) | 1 | Not indexed; original retained for further review. |
| [Boston preaction sprinkler permit checklist](https://www.boston.gov/sites/default/files/file/2021/07/Preaction%20Sprinkler%20Guidelines_tcm3-4038_new_2_tcm3-4038_edited_7_12_21_0.pdf) | 1 | Not indexed; original retained for further review. |
| [Boston fire protection service repairs guidance](https://content.boston.gov/sites/default/files/file/2025/02/Boston%20Fire%20Department%20Fire%20Protection%20Service%20Repairs%20Guideline.pdf) | 1 | Not indexed; original retained for further review. |
| [Boston sprinkler alteration and impairment guidance (2015)](https://documents.boston.gov/images_documents/BFD%20Fire%20Safety%20Requirements%20for%20Alteration%20and%20Impairment%20to%20Water%20Based%20Suppression%20Systems_tcm3-49400.pdf) | 1 | Not indexed; original retained for further review. |
| [Boston air-pressurized standpipe requirements (2015)](https://documents.boston.gov/images_documents/Requirements%20for%20Air%20Pressurized%20Standpipes_tcm3-51725.pdf) | 4 | Not indexed; original retained for further review. |

The originals are saved locally in `sprink/.data/source-acquisition/2026-10-07/`. The [download manifest](../reference-catalog/boston-downloads-2026-10-07.json) records URLs, SHA-256 hashes, page counts and coverage. It includes a text snapshot of the current BFD guide. The archive is excluded from Git; the source register, provenance and selected state legislative text are versioned.

## Review record for the imported state amendments

- **Chapter 35, page 1:** visually compared with the original. The complete amendment paragraph and all listed standards are retained. The source says “Insert 10 referenced standards” but prints nine rows; that wording is preserved, not silently repaired. This is the Massachusetts amendment sheet, not the complete IBC Chapter 35 table.
- **Residential Chapter 3, pages 20–21:** visually compared both full pages. R313.1, R313.2 and the source’s printed `313.2.1` are included with all three exceptions, the owner-occupancy note and aggregate-area definitions. The omitted `R` in printed `313.2.1` is preserved. Line wraps and headings were formatted for reading; extracted `ft2` represents the source’s square-foot superscript. No R314 content is included.
- The state PDFs call themselves unofficial copies and direct readers to the Secretary of the Commonwealth for official copies. The edition scope remains Massachusetts’s 10th edition amendments to 2021 IBC/IRC.
- Boston’s 2015 impairment/standpipe handouts remain reference links with visible dates, not current indexed rules. The service-repair sheet is scanned and has no printed date; `2025/02` in its URL is only a posting clue.

The library now has three state source packages: the existing fire-code adoption clause, Chapter 35 amendments, and selected residential R313 sprinkler amendments. Structure validation and original-page comparison do not establish whole-code completeness or field accuracy. Natural-language retrieval still requires the configured JEV service.
