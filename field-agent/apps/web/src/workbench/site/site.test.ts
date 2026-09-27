import { describe, expect, it } from "vitest";
import { siteFrameFor, type PackageInputs, type PackagePlan } from "@field-agent/core";
import { boxGaps, planBox, requirements, siteFrameOf } from "../model.js";
import { frameFormulas } from "./SiteInputs.js";

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
  it("reproduces the FS-01 acceptance mapping with Y to the right of the pipe", () => {
    const frame = siteFrameFor(plan, "p1", "right");
    if ("reason" in frame) throw new Error(frame.reason);
    expect(frame.length).toBeCloseTo(3047.6613, 6);
    expect(frameFormulas(frame, 0).drawing).toBe("Drawing XY (mm from the sheet origin, Y down the sheet) = (12544.2133 − Y, 9620.504 + X)");
    expect(frameFormulas(frame, 0).plan).toBe("Plan (mm) = (12544.2133 − Y, −9620.504 − X, Z)");
  });

  it("draws the duct in the plan frame and names missing faces", () => {
    const s = { detailing: [], siteFacts: [f("siteFrame", "right", { subjectIds: ["p1"] }), ...box("duct", [1200, -250, null, 1800, 250, null])], baselinePlan: plan };
    expect(siteFrameOf(s)?.frame?.spanId).toBe("p1");
    expect(planBox(s, "duct")).toBeNull();
    expect(boxGaps(s, "duct", true)).toEqual(["height (Z): both faces missing"]);
    const full = { ...s, siteFacts: [s.siteFacts[0], ...box("duct", [1200, -250, -300, 1800, 250, 300])] };
    expect(planBox(full, "duct")).toEqual({ min: { x: 12294.2133, y: -11420.504, z: -300 }, max: { x: 12794.2133, y: -10820.504, z: 300 } });
  });

  it("asks for each missing box face by name in adaptation", () => {
    const s = { id: "x", intent: "adapt_to_site", detailing: [], siteFacts: box("workEnvelope", [-150, null, -200, 3197.6613, 1200, 200]), baselinePlan: plan, scope: null, sourceDrawing: null, changeRequest: null } as unknown as Parameters<typeof requirements>[0];
    const labels = requirements(s).filter(r => r.group === "Site" && !r.done).map(r => r.label);
    expect(labels).toContain("Work boundary north-south (Y): the low face missing");
    expect(labels).toContain("Obstacle entered and confirmed (all six faces)");
  });
});
