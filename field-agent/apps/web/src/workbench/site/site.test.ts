import { describe, expect, it } from "vitest";
import { geometryFactUsable } from "@field-agent/core";
import type { PackageInputs, PackagePlan } from "@field-agent/core";
import { boxGaps, reopenSiteGeometry, requirements, siteFrameOf } from "../model.js";
import { siteEvidence, frameFormulas, frameFromYaw, spanFrame } from "./SiteInputs.js";

// FS-01 P27 traced in the drawing-plan frame: N27 (12544.2133, 9620.5040) to N28 (12544.2133, 12668.1653)
// drawing mm, Y down the sheet, so plan Y is negated.
const at = (x: number, y: number) => ({ x, y: -y, z: 0 });
const plan: PackagePlan = {
  id: "baseline", coordinateFrame: { id: "drawing-plan", lengthUnit: "mm", axes: "right_handed_z_up" }, confirmation: "confirmed",
  entities: [{ id: "p1", kind: "pipe", productId: null, ports: [{ id: "start", position: at(12544.2133, 9620.504), unknownReason: null }, { id: "end", position: at(12544.2133, 12668.1653), unknownReason: null }] }],
  connections: [],
};
type Fact = PackageInputs["siteFacts"][number];
const f = (field: string, value: Fact["value"], extra: Partial<Fact> = {}): Fact => ({
  id: field, field, value, subjectIds: [], unit: typeof value === "number" ? "mm" : null, unknownReason: value === null ? "Not measured" : null,
  confirmation: value === null ? "proposed" : "confirmed", context: "observed", source: { description: "ASSUMPTION: test", assetId: null, page: null }, ...extra,
});
const box = (prefix: string, v: Array<number | null>) => ["min.x", "min.y", "min.z", "max.x", "max.y", "max.z"].map((k, i) => f(`${prefix}.${k}`, v[i]));

describe("site frame", () => {
  it("pins a right-handed frame to the FS-01 span", () => {
    const span = spanFrame(plan, "p1");
    if (!span) throw new Error("no frame");
    expect(span.length).toBeCloseTo(3047.6613, 6);
    expect(span.yaw).toBe(-90);
    const frame = frameFromYaw(span.origin, span.yaw);
    expect(frameFormulas(frame, { rotationDeg: 0, originMm: { x: 0, y: 0 } }).plan).toBe("Plan (mm) = (12544.2133 + Y, −9620.504 − X, Z)");
    expect(frameFormulas(frame, { rotationDeg: 0, originMm: { x: 0, y: 0 } }).drawing).toBe("Drawing XY (mm from the sheet origin, Y down the sheet) = (12544.2133 + Y, 9620.504 + X)");
  });

  it("adds the plan origin's sheet offset to the drawing formula", () => {
    const frame = frameFromYaw({ x: 100, y: -200, z: 0 }, 0);
    expect(frameFormulas(frame, { rotationDeg: 0, originMm: { x: 50, y: 30 } }).drawing).toBe("Drawing XY (mm from the sheet origin, Y down the sheet) = (150 + X, 230 − Y)");
  });

  it("reads boxes in the saved adaptationFrame facts and names missing faces", () => {
    const frame = [f("adaptationFrame.origin.x", 12544.2133), f("adaptationFrame.origin.y", -9620.504), f("adaptationFrame.origin.z", 0), f("adaptationFrame.yaw", -90, { unit: "deg" })];
    const s = { detailing: frame, siteFacts: box("duct", [1200, -250, null, 1800, 250, null]), baselinePlan: plan };
    const site = siteFrameOf(s);
    expect(site?.reason).toBeNull();
    const d = site!.toDrawing!({ x: 1200, y: 250, z: 0 });
    expect(d.x).toBeCloseTo(12794.2133, 6);
    expect(d.y).toBeCloseTo(-10820.504, 6);
    expect(boxGaps(s, "duct", true)).toEqual(["height (Z): both faces missing"]);
  });

  it("reopens the frame and boxes when the affected span changes", () => {
    const frame = [f("adaptationFrame.origin.x", 0), f("adaptationFrame.origin.y", 0), f("adaptationFrame.origin.z", 0), f("adaptationFrame.yaw", 0, { unit: "deg" })];
    const out = reopenSiteGeometry({ detailing: frame, siteFacts: [...box("duct", [1, 1, 1, 2, 2, 2]), f("requiredPipeClearance", 100)] });
    expect([...out.detailing, ...out.siteFacts].filter(x => x.confirmation === "confirmed").map(x => x.field)).toEqual(["requiredPipeClearance"]);
    expect(siteFrameOf(out)?.reason).toBeTruthy();
  });

  it("reports an incomplete frame instead of guessing", () => {
    const s = { detailing: [f("adaptationFrame.yaw", -90, { unit: "deg" })], siteFacts: [], baselinePlan: plan };
    expect(siteFrameOf(s)?.reason).toBeTruthy();
  });

  it("asks for each missing box face by name in adaptation", () => {
    const s = { id: "x", intent: "adapt_to_site", detailing: [], siteFacts: box("workEnvelope", [-150, null, -200, 3197.6613, 1200, 200]), baselinePlan: plan, scope: null, sourceDrawing: null, changeRequest: null } as unknown as Parameters<typeof requirements>[0];
    const labels = requirements(s).filter(r => r.group === "Site" && !r.done).map(r => r.label);
    expect(labels).toContain("Work boundary north-south (Y): the low face missing");
    expect(labels).toContain("Obstacle geometry (all six faces)");
  });
});


it("keeps site test values proposed and synthetic even through measurement confirmation", () => {
  const saved = f("duct.min.x", 100, { confirmation: "proposed", provenance: "synthetic_assumption" });
  expect(siteEvidence(saved, "measured", true, "Edited note")).toMatchObject({ provenance: "synthetic_assumption", confirmation: "proposed" });
  expect(siteEvidence(undefined, "assumption", true, "Test geometry")).toMatchObject({ provenance: "synthetic_assumption", confirmation: "proposed" });
  expect(siteEvidence(undefined, "measured", false, "Tape")).toMatchObject({ provenance: "user_entered", confirmation: "proposed" });
  expect(siteEvidence(undefined, "measured", true, "Tape")).toMatchObject({ provenance: "confirmed_evidence", confirmation: "confirmed" });
});
it("invalidates usable proposed synthetic geometry when the affected span changes", () => {
  const assumption = f("duct.min.x", 100, { confirmation: "proposed", provenance: "synthetic_assumption" });
  expect(geometryFactUsable(assumption)).toBe(true);
  const changed = reopenSiteGeometry({ detailing: [assumption], siteFacts: [] });
  expect(changed.detailing[0]).toMatchObject({ value: null, provenance: "synthetic_assumption", confirmation: "proposed" });
  expect(geometryFactUsable(changed.detailing[0])).toBe(false);
});
