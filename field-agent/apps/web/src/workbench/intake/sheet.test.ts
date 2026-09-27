import { describe, expect, it } from "vitest";
import {
  buildTracePlan, parseRatioNumber, planToSheet, rotationToAxis, scaleFromPrinted, scaleFromTwoPoints, sheetToPlan,
  spanLengths, traceFromPlan, traceProblems, type Trace, type ViewTransform,
} from "./sheet.js";

// FS-01 acceptance oracle (#1): N27 (12544.2133, 9620.5040) mm to N28 (12544.2133, 12668.1653) mm in the
// crop-local frame with Y down; 1/8 in = 1 ft, so 1 PDF point = 33.8666666667 mm. Crop origin [1460, 1500] pt.
const N27 = { x: 12544.2133, y: 9620.5040 }, N28 = { x: 12544.2133, y: 12668.1653 };
const MM_PER_PT = 33.8666666667;
const pt = (p: { x: number; y: number }) => ({ x: 1460 + p.x / MM_PER_PT, y: 1500 + p.y / MM_PER_PT });

const fs01 = (a: { x: number; y: number }, b: { x: number; y: number }): Trace => ({
  nodes: [{ kind: "interface", at: a, head: true, label: "H1" }, { kind: "interface", at: b, head: true, label: "H3" }],
  context: [], pipeLabels: ["P27"],
});

describe("view transform", () => {
  it("maps a PDF page to plan millimetres with Y flipped to a right-handed Z-up frame, and back", () => {
    const t: ViewTransform = { scale: MM_PER_PT, origin: { x: 1460, y: 1500 }, rotationDeg: 0 };
    const a = sheetToPlan(pt(N27), t);
    expect(a.x).toBeCloseTo(N27.x, 3);
    expect(a.y).toBeCloseTo(-N27.y, 3);
    const back = planToSheet(a, t);
    expect(back.x).toBeCloseTo(pt(N27).x, 6);
    expect(back.y).toBeCloseTo(pt(N27).y, 6);
  });

  it("gets 1/8 in = 1 ft as 33.8667 mm per PDF point", () => {
    expect(scaleFromPrinted({ value: parseRatioNumber("1/8")!, unit: "in" }, { value: 1, unit: "ft" })).toBeCloseTo(MM_PER_PT, 9);
  });

  it("gives the same scale from a calibration entered in mm or in ft", () => {
    const a = { x: 10, y: 10 }, b = { x: 190, y: 10 };
    expect(scaleFromTwoPoints(a, b, 3048, "mm")).toBeCloseTo(scaleFromTwoPoints(a, b, 10, "ft")!, 12);
    expect(scaleFromTwoPoints(a, a, 10, "ft")).toBeNull();
  });

  it("reads fractions and mixed numbers, and rejects other text", () => {
    expect(parseRatioNumber("3/16")).toBeCloseTo(0.1875);
    expect(parseRatioNumber("1 1/2")).toBe(1.5);
    expect(parseRatioNumber("0.25")).toBe(0.25);
    expect(parseRatioNumber("abc")).toBeNull();
    expect(parseRatioNumber("0")).toBeNull();
  });
});

describe("FS-01 P27 traced through the manual path", () => {
  it("reproduces the frozen projected length from a PDF trace", () => {
    const t: ViewTransform = { scale: MM_PER_PT, origin: { x: 1460, y: 1500 }, rotationDeg: 0 };
    const trace = fs01(pt(N27), pt(N28));
    expect(spanLengths(trace, t)[0]).toBeCloseTo(3047.6613, 3);
    const built = buildTracePlan(trace, t, { pipe: null, elbow: null });
    if ("problems" in built) throw new Error(built.problems.join());
    const p1 = built.plan.entities.find(e => e.id === "p1")!;
    expect(p1.productId).toBeNull();
    expect(p1.ports[0].position!.x).toBeCloseTo(N27.x, 3);
    // Heads stay outside the work, unconnected; the span ends at two interfaces, not physical ends.
    expect(built.scope.excludedEntityIds).toEqual(["h1", "h2"]);
    expect(built.scope.tieInEntityIds).toEqual(["t1", "t2"]);
    expect(built.plan.connections.every(c => ![c.from.entityId, c.to.entityId].some(id => id.startsWith("h")))).toBe(true);
    expect(built.labels).toEqual([{ subjectId: "p1", label: "P27" }, { subjectId: "h1", label: "H1" }, { subjectId: "h2", label: "H3" }]);
  });

  it("gives the same length from a 2 px/pt raster copy calibrated by two points in ft", () => {
    const px = (p: { x: number; y: number }) => ({ x: p.x / (MM_PER_PT / 2), y: p.y / (MM_PER_PT / 2) });
    // 10 ft printed dimension picked along a line on the raster.
    const scale = scaleFromTwoPoints({ x: 100, y: 50 }, { x: 100 + 3048 / (MM_PER_PT / 2), y: 50 }, 10, "ft")!;
    const t: ViewTransform = { scale, origin: { x: 0, y: 0 }, rotationDeg: 0 };
    expect(spanLengths(fs01(px(N27), px(N28)), t)[0]).toBeCloseTo(3047.6613, 3);
  });

  it("gives the same geometry from a rotated copy once the plan axis is picked along the same reference", () => {
    // Copy rotated 90 degrees clockwise on a 1120 px square: (x, y) -> (1120 - y, x).
    const px = (p: { x: number; y: number }) => ({ x: p.x / (MM_PER_PT / 2), y: p.y / (MM_PER_PT / 2) });
    const rot = (p: { x: number; y: number }) => ({ x: 1120 - p.y, y: p.x });
    const upright: ViewTransform = { scale: MM_PER_PT / 2, origin: px(N27), rotationDeg: rotationToAxis(px(N27), px(N28))! };
    const turned: ViewTransform = { scale: MM_PER_PT / 2, origin: rot(px(N27)), rotationDeg: rotationToAxis(rot(px(N27)), rot(px(N28)))! };
    const a = buildTracePlan(fs01(px(N27), px(N28)), upright, { pipe: null, elbow: null });
    const b = buildTracePlan(fs01(rot(px(N27)), rot(px(N28))), turned, { pipe: null, elbow: null });
    if ("problems" in a || "problems" in b) throw new Error("trace failed");
    const end = (x: typeof a) => x.plan.entities.find(e => e.id === "p1")!.ports[1].position!;
    expect(end(a).x).toBeCloseTo(3047.6613, 3);
    expect(end(a).y).toBeCloseTo(0, 6);
    expect(end(b).x).toBeCloseTo(end(a).x, 6);
    expect(end(b).y).toBeCloseTo(end(a).y, 6);
    // And the saved plan maps back onto the rotated sheet where the user clicked.
    expect(planToSheet(end(b), turned).x).toBeCloseTo(rot(px(N28)).x, 6);
  });
});

describe("trace topology", () => {
  const t: ViewTransform = { scale: 10, origin: { x: 0, y: 0 }, rotationDeg: 0 };
  it("turns an L branch into two spans, one elbow, an outlet interface and a terminal head", () => {
    const trace: Trace = {
      nodes: [{ kind: "interface", at: { x: 0, y: 0 }, head: false, label: "outlet" }, { kind: "elbow", at: { x: 0, y: 100 }, head: false, label: "" },
        { kind: "interface", at: { x: 80, y: 100 }, head: true, label: "terminal" }],
      context: [{ kind: "pipe", points: [{ x: -50, y: 0 }, { x: 50, y: 0 }], label: "existing main" }], pipeLabels: ["", ""],
    };
    const built = buildTracePlan(trace, t, { pipe: null, elbow: null });
    if ("problems" in built) throw new Error(built.problems.join());
    expect(built.plan.entities.map(e => `${e.id}:${e.kind}`)).toEqual(["p1:pipe", "p2:pipe", "t1:tie_in", "f1:fitting", "t2:tie_in", "h1:head", "c1:pipe"]);
    expect(built.scope.includedEntityIds).toEqual(["p1", "p2", "t1", "f1", "t2"]);
    expect(built.scope.excludedEntityIds).toEqual(["h1", "c1"]);
    expect(spanLengths(trace, t)).toEqual([1000, 800]);
    const back = traceFromPlan(built.plan, built.scope, t, id => ({ t1: "outlet", h1: "terminal", c1: "existing main" } as Record<string, string>)[id] ?? "");
    expect(back).toEqual(trace);
  });

  it("explains an unusable trace instead of building a plan", () => {
    expect(traceProblems({ nodes: [{ kind: "elbow", at: { x: 0, y: 0 }, head: false, label: "" }], context: [], pipeLabels: [] }).length).toBe(2);
    const same: Trace = { nodes: [{ kind: "interface", at: { x: 1, y: 1 }, head: false, label: "" }, { kind: "open_end", at: { x: 1, y: 1 }, head: false, label: "" }], context: [], pipeLabels: [] };
    expect(buildTracePlan(same, t, { pipe: null, elbow: null })).toEqual({ problems: ["Points 1 and 2 are at the same place."] });
  });

  it("keeps each project's plan independent of fixture ids", () => {
    const a = buildTracePlan(fs01({ x: 0, y: 0 }, { x: 0, y: 10 }), t, { pipe: null, elbow: null });
    const b = buildTracePlan(fs01({ x: 5, y: 5 }, { x: 25, y: 5 }), t, { pipe: "spears/CP-010", elbow: "spears/4206-010S" });
    if ("problems" in a || "problems" in b) throw new Error("trace failed");
    expect(a.plan.entities.find(e => e.id === "p1")!.productId).toBeNull();
    expect(b.plan.entities.find(e => e.id === "p1")!.productId).toBe("spears/CP-010");
    expect(JSON.stringify(a.plan)).not.toContain("P27\"");
  });
});
