# Minimal Pi + JEV workflow connection

Implements the **connection and execution slice** of [issue #6](https://github.com/my-name-is-yu/InnovationCup/issues/6), following the [complete design in issue #1](https://github.com/my-name-is-yu/InnovationCup/issues/1). This package runs the actual Pi Agent; it does not implement the pending materials engine, route generator, rule adapters, work-package APIs or browser UI. Issue #6 remains open until real business services are connected.

## Reproduce

From `field-agent` in this checkout, with Node >=22.19 and pnpm 10.17.1:

```sh
pnpm install --frozen-lockfile
pnpm --filter @field-agent/workflow typecheck
pnpm --filter @field-agent/workflow test
pnpm --filter @field-agent/workflow demo
# Existing workspace regression checks:
pnpm typecheck
pnpm test
```

The demo uses the pinned **`@earendil-works/pi-agent-core@0.87.1`** and `@earendil-works/pi-ai@0.87.1`, not a simulated Agent. The lockfile pins the resolved dependency tree. Provider SDKs are transitive Pi dependencies; this adapter never registers/calls a generative provider, looks up its credentials, or falls back to one. Tests intercept `fetch` to verify the recorded path needs no provider network request.

The two independent fixture scenarios print actual Pi tool events and save example inputs/outputs and run summaries in a newly created OS temporary directory. They demonstrate:

1. Drawing preparation: prepare model → derive package → evaluate → Choice selects staging supplied evidence → next tool-result turn → Choice selects a missing-input question → Agent ends.
2. Site adaptation: prepare model → generate fixed fixture alternatives → derive/evaluate/compare → ask the user to select/edit a plan → Agent ends. No Scenario 2 run is required.
3. After an explicit fixture user answer/selection increments `inputRevision`, an explicit start constructs a **new Agent and run**, regenerates current outputs and requests export.

`test/fixtures/choices.json` contains hand-authored, recorded-format HTTP response examples, **not captured live JEV output**. `FixtureDomain` and `MemoryRunStore` live under `test/fixtures` and are not exported by this package. The domain fixture has predetermined materials/routes and an export marker, not actual engineering calculations or PDF/CSV generation. A known material row stays visible while the dependent cut remains null and regulatory findings remain unknown. This proves the orchestration boundary, not product completion, model accuracy or constructability.

## Business interface and ownership

`DomainPort` in `src/contracts.ts` is the integration seam. The workflow owns scheduling, Pi tools, Choice validation and execution status. The Node application owns the persisted input/output store and supplies validated, detached snapshots.

| Port | Required behavior |
| --- | --- |
| `read(packageId)` | Return validated authoritative inputs, current/historical output references, derived gaps and unconfirmed evidence candidates. Include one semantic input revision and one deployed configuration version. |
| `execute(action, context)` | Compute/stage the named business operation using server-bound `subjectId`, `runId`, `actionId` and the supplied abort signal. Do not publish outputs, confirm inputs, select a construction plan or change the semantic revision. |
| `commit(action, result, context)` | In one synchronous local transaction, recheck both versions, validate the domain payload and publish revision-tagged outputs. Return false on conflict. Never commit an aborted result. |

The runner checks the version before/after external work and immediately before `commit`. No asynchronous gap is allowed inside the final check-and-write transaction. If an engine ignores abort and resolves late, the runner has already stopped awaiting it and will never call `commit` for that result. Temporary file generation must remain staged until commit; external irreversible side effects are outside this initial contract. A timed-out operation is not retried automatically.

Each registered Pi tool has exactly `{ runId, actionId }` as its arguments. The selected `BoundAction` remains in the server closure and is consumed once. Only the eight business operations in the parent design are registered. JEV cannot supply dimensions, subject IDs, arbitrary tool arguments, rule omissions, approval, plan adoption or `done`.

The policy chooses mandatory dependencies in code. For Scenario 2 it details the baseline; for Scenario 3 it generates/details/evaluates/compares alternatives and asks for user selection. It then details the explicitly selected plan. Export is only scheduled for the explicit `export_selected_package` goal. A domain adapter must emit gaps that gate only dependent operations: a missing rule source alone need not suppress known quantities; unconfirmed dimensions must remain missing in dependent calculations. Preparing/staging a model or document does not confirm it. Confirmation/selection must be a validated user API mutation, outside the tool set.

Outputs are referenced by `kind`, `subjectId`, `inputRevision` and `configVersion`. Derive readiness and gap counts from saved domain outputs (see `currentOutputs`); do not interpret `run.status === 'completed'` as approval or full input sufficiency. The synchronous snapshot and commit methods match a single Node server with a local transactional store. Do not use this runner as a distributed worker.

## Embed once in the Node server

```ts
import { JevHttpClient, JsonRunStore, WorkflowRunner } from '@field-agent/workflow';

// applicationDomainPort is a real adapter to the shared WorkPackage store/core services.
// Validate the deployment secret at startup; never put it in the browser or run records.
const runner = new WorkflowRunner({
  domain: applicationDomainPort,
  store: new JsonRunStore('/application-data/workflow-runs.json'),
  choice: new JevHttpClient(process.env.TYPESAFE_API_KEY!),
  configVersion: deployedConfigVersion,
  requestTimeoutMs: 15_000,
  maxSteps: 20,
});

const handle = runner.start(packageId, 'prepare_from_drawing', {
  inputRevision: expectedInputRevision,
  configVersion: deployedConfigVersion,
});
// Return handle.id immediately to the API client. Observe handle.done for settlement.
const run = await handle.done;
// runner.get(handle.id) reads the saved summary; runner.cancel(packageId) aborts active work.
```

Create one `WorkflowRunner` at server startup. A duplicate start for the same package returns the existing handle. The constructor changes previously persisted `running` summaries to `interrupted`; it never replays tools or changes saved business inputs. `JsonRunStore` atomically replaces a small local JSON file and stores only run summaries (latest action/result/decision/fallback/error, question, versions and stop reason). An application can supply a SQLite `RunStore` instead when issue #3 lands.

The application answers the saved domain question through its own validated mutation API, checks the question's input version, increments the input revision and starts a fresh run. Candidate selection must reference an actual persisted comparison/candidate belonging to that package; selection is not drawing approval. No old Pi transcript is carried across a human wait. User input storage/validation is deliberately not implemented in this connection package.

`request_input` persists the question in the run summary and terminates Pi after that tool result. A normal successful tool emits a result into the actual Pi transcript, and the next stream turn reevaluates the saved snapshot and latest result. Sequential execution, a maximum tool count, per-request timeouts and a no-change stop prevent automatic runaway loops. Service exceptions finalize the run; raw service errors/bodies are not persisted.

### API lane handoff

The in-progress API lane was read at `docs/contracts/work-package-api.en.md` and `apps/server/src/work-packages/service.ts` in the API worktree. Its `WorkPackageRunner.execute(PackageRunContext)` is an outer server lifecycle port; this package's `DomainPort` is the inner business-service port. They are not yet drop-in compatible. The concrete adapter should:

- Use the API's `snapshot`/`run` input versions and goal, map its cancellation signal to `runner.cancel`, and project freshly published domain outputs for each subsequent `DomainPort.read` (the initial API snapshot alone is insufficient).
- Translate staged engine results in `DomainPort.commit` into the API's synchronous, revision-checked `context.publish`. Candidate-set detailing maps to per-plan result records; model/package/evaluation/comparison references must be derived from accepted domain outputs, not fabricated completion markers. Draft packages without a bounded drawing/baseline need intake questions before they satisfy this package's `WorkSnapshot` contract.
- Map the saved workflow question to the API's durable `outputs.requests`, preserving domain subject references and revision. Candidate-selection questions target a candidate set, whereas the current API validates request subjects as plan entities; this mapping needs an explicit package/candidate question scope. A workflow wait alone does not publish an API request today.
- Preserve the API run ID and summary as the user-facing lifecycle owner when adding the adapter; reconcile the inner run ID/`RunStore` with that record instead of exposing two conflicting runs. Map completed/waiting/blocked to the outer result; propagate failure and let API cancellation/edit guards retain their terminal state. Answers/selection remain the existing user endpoints.

No API worktree files were modified or copied. This handoff records the small remaining integration seam; it does not claim a connected server or introduce another API/state model.

## JEV protocol and live smoke

The HTTP transport follows the official [Choice](https://docs.typesafe.ai/primitives/choice), [API](https://docs.typesafe.ai/api) and [model](https://docs.typesafe.ai/models) documentation. Pi integration follows the [pinned agent-core README](https://github.com/earendil-works/pi/blob/v0.87.1/packages/agent/README.md) and the installed package's TypeScript declarations.

When multiple eligible operations need semantic selection, send one `next_action` Choice to `POST https://api.typesafe.ai/v1/systemone`, using `Authorization: Bearer ...` and the fixed model **`jev-1.13.0`**. State contains intent/goal, plan ID, versions, stage, gaps and the latest compact business result; criteria contains the eligible operation IDs/descriptions. It never includes the entire Pi transcript, drawing binaries or rule source. `needs_clarification` is an explicit control option, not an executable tool. A single eligible operation bypasses JEV.

Validation checks the answer type, pinned response model, exact option membership, finite probabilities in `[0,1]`, all options exactly once, sum within `1e-6`, unique maximum choice, confidence shape, and the locally correlated request versions. The external API does **not** promise to echo `inputRevision` or `configVersion`: the transport binds these locally, and the runner rechecks the current saved versions before execution. Confidence is diagnostic only; even the valid `0.02` fixture is accepted. Exact probability ties, `needs_clarification`, invalid output and service failure use eligible questions in fixed `order`/ID order; without a question, the run stops with the concrete blocker. No second provider or automatic retry exists.

Configure `TYPESAFE_API_KEY` through your normal secret environment, then run:

```sh
pnpm --filter @field-agent/workflow smoke:jev
```

The smoke sends one small synthetic request, validates its response and logs no key, headers, raw body or private domain data. It performs no business operation. Exit 2 means missing credentials (no request sent), exit 1 means the smoke failed, and exit 0 means the connection/response check succeeded. HTTP transport tests use a mock and do not establish live readiness.

## Verification and remaining integrations

Verified in this checkout on September 26, 2026 (America/Los_Angeles):

- Workflow tests: **51 passed**, using the actual pinned Pi runtime, representative recorded-format decisions and mocked HTTP transport.
- Workspace tests: **137 passed** across seven files; workspace typechecking passed.
- Both-scenario CLI demo passed; one tool per Pi turn, tool-result continuation, durable wait and new-Agent resumption observed.
- Live JEV smoke: **skipped**, exit 2. `TYPESAFE_API_KEY` was not configured; live service compatibility and latency remain unverified.

Representative failure cases cover invalid Choice type/membership/model/distribution/version, generated arguments, clarification/ties, duplicate start, cancellation, stale input/configuration during both Choice and tool execution, ignored abort/late results, commit conflicts, timeout, step limit, no progress, service errors, restart interruption and saved-input rerun. No benchmark or confidence calibration is claimed.

Remaining application connections are issue #3's shared work-package persistence, #10's detailing/materials/assembly service, #9's candidate generator/comparison, #2's scenario-specific evaluation adapter, #13's real export, and #7's authenticated run/answer APIs. Existing task APIs in this checkout implement the older camera workflow and are intentionally not relabeled as these new work-package services. The separately edited rule implementation in the original checkout has not been copied or modified. This patch does not close issue #6, merge, or modify the original checkout.
