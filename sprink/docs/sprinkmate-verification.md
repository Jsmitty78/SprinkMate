# SprinkMate foundation verification — 2026-10-07

This section records the original foundation checkpoint, commit `a32ded7`, when only the adoption clause was packaged. The later source expansion and reporting checks are recorded below.

Environment: Node 22.19.0, pnpm 10.17.1, macOS, local Chrome.

- `pnpm typecheck`: all six workspace projects pass.
- `pnpm test`: 30 files, 340 tests pass.
- `pnpm build`: passes; Vite reports an existing large application bundle warning.
- `pnpm sources:import reference-sources/boston-public --check`: validates one public state adoption clause without modifying the destination.
- Local browser test: reference reading and filtering, selected-document API request, distinct clauses on the same page, authenticated original-file blob link, configuration error with continued library access, unsupported-question result, and a 390px mobile viewport without horizontal overflow pass. No browser page errors.

The new CLI tests verify a folder import, idempotence, validation-only isolation, all-or-nothing rollback and demonstration separation. The retrieval test verifies that unselected editions/standards cannot enter a selected-reference result, and rejects stale or invalid selections.

## Reproduce the browser test

After `pnpm build`, use two terminals in `sprink`:

```sh
pnpm e2e:references:server
```

```sh
# Set E2E_CHROME_PATH if using an installed Chrome rather than a Playwright browser.
E2E_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm e2e:references
```

The server binds only to 127.0.0.1:4337, uses an isolated temporary SQLite database and authored test fixtures, and stubs retrieval. Stop it when finished. Browser screenshots are ignored under `e2e-out/reference-library`.

## Not established by these checks

No live JEV retrieval or OpenAI work-package run was performed for this change: credentials were unavailable. No complete NFPA books or full Massachusetts/Boston amendments were imported. The one public starter clause is not installation guidance. Retrieval accuracy, jurisdiction applicability, complete source coverage and field readiness remain unverified; use the Boston setup acceptance process with the actual licensed sources.

## Source expansion and reporting check

The later October 7 commit [`61d3e4a`](https://github.com/Jsmitty78/SprinkMate/commit/61d3e4a539115727e55c82d467555abb4af61d46) adds two state amendment packages, bringing the starter folder to three packages and eight indexed sections. Its [GitHub Actions run](https://github.com/Jsmitty78/SprinkMate/actions/runs/37578338118) passed installation, typecheck, tests and build. See the [source review record](boston-source-findings.md) for page comparison and extraction scope.

On November 13, 2026, validation-only import was rerun successfully against the checked-in packages:

```text
ma-527-adoption-2023       1 section
ma-780-ch35-10th           1 section
ma-780-res-r313-10th       6 sections
3 source packages validated; destination library unchanged.
```

The original foundation results above remain dated evidence. The November reporting update does not claim a fresh live-provider test, public deployment, complete source coverage or field-accuracy acceptance.
