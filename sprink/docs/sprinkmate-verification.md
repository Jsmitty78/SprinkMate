# SprinkMate foundation verification — 2026-10-07

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
