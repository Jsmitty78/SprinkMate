import { describe, expect, it } from "vitest";
import { validateMeasurement, type Measurement, type MeasurementEndpoint, type RuleContext } from "../src/index.js";

const context = (): RuleContext => ({
  targetId: "P1", taskRevision: 2,
  observations: ["from-image", "to-image"].map(id => ({ id, targetId: "P1", spatial: {coordinateFrameId: "ar-frame-1", captureSessionId: "capture-1", timestamp: 12, tracking: "normal"} })),
});
const point = (position: [number, number, number], evidenceId: string): MeasurementEndpoint => ({
  position, coordinateFrameId: "ar-frame-1", captureSessionId: "capture-1", timestamp: 12,
  hit: "estimated_plane", tracking: "normal", evidenceIds: [evidenceId],
});
const ar = (): Extract<Measurement, { method: "ar_raycast" | "fixture" }> => ({
  id: "M1", targetId: "P1", unit: "m", method: "ar_raycast", evidenceIds: ["from-image", "to-image"],
  from: point([0, 0, 0], "from-image"), to: point([3, 4, 0], "to-image"),
});

describe("measurement acquisition validation", () => {
  it("records valid estimated-plane raycasts without asserting physical accuracy", () => {
    expect(validateMeasurement(ar(), context())).toMatchObject({
      status: "recorded", qualityRecorded: true, valueMeters: 5, accuracy: "unknown", missingInputs: [],
    });
  });

  it("accepts existing-plane hits", () => {
    const measurement = ar();
    measurement.from.hit = "existing_plane";
    measurement.to.hit = "existing_plane";
    expect(validateMeasurement(measurement, context()).qualityRecorded).toBe(true);
  });

  it.each(["none", "fallback", "fixture"] as const)("rejects %s as an AR raycast result", hit => {
    const measurement = ar();
    measurement.from.hit = hit;
    expect(validateMeasurement(measurement, context())).toMatchObject({ status: "unknown", valueMeters: null, accuracy: "unknown" });
  });

  it.each(["frame", "session", "tracking", "timestamp", "position", "evidence"])("rejects invalid endpoint %s", problem => {
    const measurement = ar();
    if (problem === "frame") measurement.to.coordinateFrameId = "new-frame";
    if (problem === "session") measurement.to.captureSessionId = "new-session";
    if (problem === "tracking") measurement.to.tracking = "limited";
    if (problem === "timestamp") measurement.to.timestamp = NaN;
    if (problem === "position") measurement.to.position[0] = Infinity;
    if (problem === "evidence") measurement.to.evidenceIds = [];
    expect(validateMeasurement(measurement, context()).qualityRecorded).toBe(false);
  });

  it("rejects stale and wrong-target measurement evidence", () => {
    const ctx = context();
    ctx.observations[0].superseded = true;
    expect(validateMeasurement(ar(), ctx).status).toBe("unknown");
    ctx.observations[0] = { id: "from-image", targetId: "another-pipe" };
    expect(validateMeasurement(ar(), ctx).status).toBe("unknown");
  });
  it.each(["captureSessionId", "coordinateFrameId", "timestamp", "tracking"])("rejects a different image %s", key => {
    const ctx=context();
    ctx.observations[0].spatial![key]="different";
    expect(validateMeasurement(ar(),ctx)).toMatchObject({status:"unknown",valueMeters:null});
  });
  it("rejects AR evidence without image frame metadata", () => {
    const ctx=context();delete ctx.observations[0].spatial;
    expect(validateMeasurement(ar(),ctx).missingInputs).toContain("from.imageFrameAssociation");
  });

  it("rejects a measurement for another task target", () => {
    expect(validateMeasurement({ ...ar(), targetId: "P2" }, context()).status).toBe("unknown");
  });

  it("records fixture geometry as a fixture, never as measured accuracy", () => {
    const measurement = ar();
    measurement.method = "fixture";
    measurement.from.hit = "fixture";
    measurement.to.hit = "fixture";
    expect(validateMeasurement(measurement, context())).toMatchObject({ qualityRecorded: true, accuracy: "unknown" });
  });

  it("records manual values only with endpoint labels and evidence", () => {
    const measurement: Measurement = { id: "M2", targetId: "P1", unit: "m", method: "manual", valueMeters: 1.25, fromLabel: "A outer end", toLabel: "B outer end", evidenceIds: ["from-image"] };
    expect(validateMeasurement(measurement, context())).toMatchObject({ qualityRecorded: true, valueMeters: 1.25, accuracy: "unknown" });
    expect(validateMeasurement({ ...measurement, fromLabel: "" }, context()).status).toBe("unknown");
    expect(validateMeasurement({ ...measurement, valueMeters: NaN }, context()).status).toBe("unknown");
  });
});
