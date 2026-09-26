export interface Fact<T = string> {
  value: T | null;
  confirmed: boolean;
  evidenceIds: string[];
  source: "manual" | "model" | "fixture";
}

export type Orientation = "pendent" | "upright" | "sideways" | "unknown";

export interface HeadFacts {
  model: Fact<string>;
  installation: Fact<"installed" | "uninstalled">;
  mounting: Fact<"standard" | "recessed">;
  orientation: Fact<Orientation>;
  verticalReference: Fact<"gravity" | "verified_record" | "unknown">;
}

export interface Evidence {
  id: string;
  targetId: string;
  /** Only explicit supersession invalidates an immutable observation. */
  superseded?: boolean;
  spatial?: Record<string, unknown>;
}

export interface RuleContext {
  targetId: string;
  taskRevision: number;
  observations: Evidence[];
}

export type RuleStatus = "pass" | "fail" | "unknown" | "not_applicable";

export interface SourceReference {
  document: string;
  revision: string;
  page: number;
  url: string;
  purpose: string;
}

export interface RuleResult {
  ruleId: string;
  targetId: string;
  status: RuleStatus;
  applicability: "applicable" | "not_applicable" | "unknown";
  reason: string;
  missingInputs: string[];
  evidenceIds: string[];
  sourceRefs: readonly SourceReference[];
  versions: { taskRevision: number; ruleVersion: string; sourceRevision: string };
}

export interface PlanComparison {
  status: "match" | "different" | "unknown";
  targetId: string;
  planned: Orientation;
  observed: Orientation | null;
  reason: string;
  missingInputs: string[];
  taskRevision: number;
}

export interface MeasurementEndpoint {
  coordinateFrameId: string;
  captureSessionId: string;
  /** Seconds on the capture session's monotonic clock. */
  timestamp: number;
  position: [number, number, number];
  hit: "existing_plane" | "estimated_plane" | "none" | "fallback" | "fixture";
  tracking: "normal" | "limited" | "unavailable";
  evidenceIds: string[];
}

interface MeasurementBase {
  id: string;
  targetId: string;
  unit: "m";
  evidenceIds: string[];
}

export type Measurement = MeasurementBase & (
  | { method: "ar_raycast" | "fixture"; from: MeasurementEndpoint; to: MeasurementEndpoint }
  | { method: "manual"; valueMeters: number; fromLabel: string; toLabel: string }
);

export interface MeasurementValidation {
  measurementId: string;
  status: "recorded" | "unknown";
  qualityRecorded: boolean;
  /** Recording valid input never certifies physical accuracy. */
  accuracy: "unknown";
  valueMeters: number | null;
  reason: string;
  missingInputs: string[];
  targetId: string;
  taskRevision: number;
}

export function emptyFacts(): HeadFacts {
  const empty = <T>(): Fact<T> => ({
    value: null,
    confirmed: false,
    evidenceIds: [],
    source: "manual",
  });
  return {
    model: empty<string>(),
    installation: empty<"installed" | "uninstalled">(),
    mounting: empty<"standard" | "recessed">(),
    orientation: empty<Orientation>(),
    verticalReference: empty<"gravity" | "verified_record" | "unknown">(),
  };
}
