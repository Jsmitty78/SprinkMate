# Sprink

**Less time searching. More time on the job.**

Sprink helps fire sprinkler fitters move from a field question or drawing to a reviewable next step: find the original reference, prepare materials and assembly information, or compare options when site conditions change.

Built for Innovation Cup 2026. The project is **Sprink**; the repository name remains `InnovationCup`.

## Find the original

Ask a question about a sprinkler product or installation requirement. Sprink searches its registered reference library and opens the relevant original passage or PDF page, with its document and page context available for review.

![Rule search: ask about pipe preparation and open the original manufacturer instructions](docs/media/rule-search.gif)

## Prepare the work

Start from a drawing and confirm the scale, dimensions and inputs. Sprink prepares a materials list, cut-length information where the required inputs are known, and assembly steps linked to their references. Missing conditions stay visible alongside the result. Review the package and export PDF/CSV outputs.

![Materials and assembly: generate a package from a sample pipe drawing and inspect referenced steps](docs/media/materials-assembly.gif)

## Handle a site change

Record an obstruction and the measured space around the affected pipe. Sprink generates route proposals, compares material and length changes, and shows the checks and unresolved questions. The worker chooses a route and reviews the revised package.

![Site changes: compare route proposals around a duct and select a route for review](docs/media/site-change.gif)

*These GIFs are excerpts from the submission recordings. The materials and site-change clips are sped up; they do not show measured response times. The drawing examples are demonstration scenarios.*

## Technical design

**AI investigates. Scripts check. Workers decide.**

![Technical design: React, Hono, Pi and Astra, JEV, reference documents and verification scripts](docs/media/architecture.png)

| Component | Responsibility |
| --- | --- |
| React + Vite | Drawing and source views, input confirmation, proposal comparison and exports. |
| Hono + Node.js | Authenticated API, uploads, work-package revisions and PDF/CSV delivery. |
| Pi + GPT-6 Astra | Investigate saved evidence, choose tools, request missing information and explain results using Pi's standard agent loop. |
| JEV | Select verification rules from a catalog; also support reference retrieval. |
| Verification scripts | Run explicit applicability, input and domain checks; return detailed results and missing inputs to the agent. |
| SQLite + local files | Persist work packages, confirmed facts, source metadata, observations and artifacts. |

The slide's **Docs DB** represents the registered source library. **Scripts DB** represents the versioned rule catalog and executable scripts in the codebase, rather than a separate database service. React is the browser interface; the API and agent workflow run on the server.

The agent reads evidence → JEV selects a check → its script runs → the agent inspects the result and decides the next step. Human confirmation and route adoption are explicit saved actions. Changes to inputs invalidate outdated outputs.

Read the [workflow implementation](sprink/packages/workflow/README.md) and [execution design](sprink/docs/pi-rule-selection-design.md) for details.

## Run locally

Requires **Node.js 22.19+**, **pnpm 10.17.1**, an OpenAI API key with access to the configured `gpt-6-astra` model, and a JEV/TypeSafe API key. Model access is required; the app does not automatically switch to another model. Agent runs and reference retrieval call external services.

```sh
git clone https://github.com/my-name-is-yu/InnovationCup.git
cd InnovationCup/sprink
pnpm install --frozen-lockfile
cp .env.example .env.local
```

Fill in the two keys in `.env.local`, then:

```sh
pnpm build
pnpm start
```

Open <http://127.0.0.1:4310>. In another terminal, from `sprink`, read the generated application connection token:

```sh
cat .data/access-token
```

Enter that token on the connection screen. API keys belong only in `.env.local`, never in the browser connection form. `.env.local` and `.data/` are ignored by Git; local keys take precedence over inherited environment variables.

### Try a sample

- **Drawing preparation:** create a work package, choose “Prepare from a drawing”, then use the sample drawing. Confirm its inputs before generating materials and assembly information.
- **Site change:** create an “Adapt to site conditions” package, use the sample, review the obstruction and measurements, then generate and compare proposals.
- **Reference search:** register documents you are authorized to use. The manufacturer PDF library visible in the recording is not bundled with a fresh checkout. For fictional test passages, import the included demo library:

```sh
pnpm sources:import --demo --project sprink-demo
```

The [demo sources](sprink/demo-sources/README.md) contain invented provisions and display a demonstration label. They are not NFPA or manufacturer requirements. See [source-library documentation](sprink/docs/ask-sprink.md) for source registration.

### Development and checks

Run these commands from `sprink`:

```sh
pnpm dev        # API on 4310; Vite on 5173
pnpm test
pnpm typecheck
pnpm build
```

See [testing guidance](sprink/docs/testing.md). [Recorded live workflow verification](sprink/docs/verification/pi-astra-jev-rule-loop.md) is separate from automated regression tests; running the opt-in live harness uses paid provider calls.

## Repository guide

| Path | Contents |
| --- | --- |
| [`sprink/apps/web`](sprink/apps/web) | Sprink web interface. |
| [`sprink/apps/server`](sprink/apps/server) | API, source retrieval, uploads, storage and exports. |
| [`sprink/packages/workflow`](sprink/packages/workflow) | Pi/Astra agent tools and JEV rule selection. |
| [`sprink/packages/core`](sprink/packages/core) | Contracts, rule catalog and deterministic checks. |
| [`sprink/packages/planning`](sprink/packages/planning) | Route planning and site-change calculations. |
| [`sprink/packages/fabrication`](sprink/packages/fabrication) | Materials, cut calculations and assembly information. |
| [`sprink/docs`](sprink/docs) | Engineering contracts, test guidance and verification records. |
| [`docs/media`](docs/media) | README demo GIFs and the technical-design slide. |

## Prototype scope

Sprink produces reviewable work information. Missing evidence remains `unknown`, and a completed agent run or passing check does not establish full code compliance or construction approval. Coverage is limited to the implemented rules and supported inputs; see the [rule inventory](sprink/docs/rule-inventory.md). Field measurement accuracy and real-world installation outcomes are not established by the demo recordings.
