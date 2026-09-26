# Field validation core

Import from `@field-agent/core`. This package has no Pi, network, camera, database, or filesystem dependency. It evaluates supplied facts; it does not infer them from images.

## Head rule

`validateHead(facts: HeadFacts, ctx: RuleContext): RuleResult` implements only `TY3231_INSTALL_ORIENTATION_V1`. Its source is TFP171, August 2026, page 3 (TY3231 is pendent) and page 5 (installation orientation). It applies to a confirmed installed, standard/non-recessed TY3231. There is no invented angular tolerance and no system-wide compliance result.

`HeadFacts` contains `model`, `installation`, `mounting`, `orientation`, and `verticalReference`. Each uses:

```ts
interface Fact<T = string> {
  value: T | null;
  confirmed: boolean;
  evidenceIds: string[];
  source: "manual" | "model" | "fixture";
}
```

Use `emptyFacts()` when information has not been collected. A `model` source is a candidate, even if a caller sets `confirmed: true`. A person independently verifying the observation may record a manual fact with its evidence. A manufacturer's expected orientation cannot serve as the installed orientation. `verticalReference` must independently establish `gravity` or a `verified_record`; image up/down alone does not do that.

`RuleContext` is `{ targetId, taskRevision, observations: Evidence[] }`. An evidence record is `{ id, targetId, superseded?: boolean }`. Each referenced ID must resolve exactly once, belong to the target, and not be superseded. Observations are immutable: merely advancing the task revision does not invalidate existing evidence. The host marks evidence superseded when it is replaced, and invalidates result snapshots when their input revision changes.

An independently confirmed other model, uninstalled head, or recessed mounting yields `not_applicable` even when unrelated facts are missing. Otherwise, missing applicability facts yield `unknown`; applicable but unsupported orientation/reference also yields `unknown`. Confirmed pendent yields `pass`, and confirmed upright or sideways yields `fail`. The result includes applicability, reasons, missing input paths, source pages, and the exact task/rule/source versions.

`comparePlan(planOrientation, facts, ctx)` separately returns `match`, `different`, or `unknown`. Matching an upright plan can still fail the TY3231 rule. Fixture facts test rule behavior, not image interpretation or a physical installation.

## Measurements

`validateMeasurement(measurement, ctx)` validates acquisition records and returns `{ status: "recorded" | "unknown", qualityRecorded, accuracy: "unknown", valueMeters, reason, missingInputs, targetId, taskRevision }`. A recorded measurement never implies physical accuracy or installation suitability.

All measurements have `{ id, targetId, unit: "m", evidenceIds }` and one of:

- `method: "manual"`, `valueMeters`, `fromLabel`, `toLabel`.
- `method: "ar_raycast" | "fixture"`, `from`, `to`.

Each endpoint is:

```ts
interface MeasurementEndpoint {
  coordinateFrameId: string;
  captureSessionId: string;
  timestamp: number; // monotonic seconds within the capture session
  position: [number, number, number]; // metres in coordinateFrameId
  hit: "existing_plane" | "estimated_plane" | "none" | "fallback" | "fixture";
  tracking: "normal" | "limited" | "unavailable";
  evidenceIds: string[];
}
```

Endpoints must share a session and coordinate frame and have finite positions/timestamps, normal tracking, and valid evidence. AR permits actual existing-plane and estimated-plane raycast results; no-hit results and fixed-distance fallback points are rejected. Fixture coordinates require `hit: "fixture"`. Physical endpoint selection and measurement error require separate real-device evaluation.

## JSON boundary

Exports include `HeadFactsSchema`, `FactSchema`, `OrientationSchema`, `EvidenceSchema`, `RuleContextSchema`, `MeasurementEndpointSchema`, `MeasurementSchema`, and `factSchema`. Validate untrusted API input before calling typed functions using `checkSchema(schema, value)`, `assertSchema(schema, value)`, or `validateSchema(schema, value)` (returns `{ valid: true, value }` or `{ valid: false, errors }`). Unknown properties are rejected.

From the workspace root:

```sh
pnpm exec vitest run packages/core/test
pnpm exec tsc --noEmit -p packages/core/tsconfig.json
```
