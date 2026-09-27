import { describe, expect, it } from "vitest";
import { evaluateLocalPlanGeometry } from "../../core/src/local-change-geometry.js";
import { createLocalGeometryPort, deriveCandidatePackages, generateCandidates, selectCandidate } from "../src/index.js";
import type { GeometryPort, Point } from "../src/index.js";
import { ductFixture, EXPECTED, fact } from "../fixtures/duct.js";

const engine = createLocalGeometryPort(evaluateLocalPlanGeometry);

describe("bounded generator", () => {
  it("produces two independent alternatives without a supplied reroute; shorter addition comes first", () => {
    const input = ductFixture(), before = structuredClone(input);
    const set = generateCandidates(input, engine);
    expect(input).toEqual(before);
    expect(set.state).toBe("ready");
    expect(set.candidates.map(c => c.template)).toEqual(["detour:y+", "detour:y-"]);
    expect(set.searchedTemplates).toEqual(["direct", "detour:y-", "detour:y+", "detour:z-", "detour:z+"]);
    expect(set.rejected.find(r => r.template === "direct")?.reasons[0]?.code).toBe("geometry_interference");
    expect(set.selection).toBeNull();
    for (const candidate of set.candidates) {
      const expected = EXPECTED[candidate.template as "detour:y+" | "detour:y-"];
      const points = [candidate.plan.nodes.find(n => n.id === "a")!, ...candidate.proposedNodeIds.map(id => candidate.plan.nodes.find(n => n.id === id)!), candidate.plan.nodes.find(n => n.id === "b")!];
      points.forEach((node, i) => ["x", "y", "z"].forEach((axis, j) => expect(node.position.value![axis as "x"]).toBeCloseTo(expected.points[i]![j]!)));
      expect(candidate.geometry.totalCenterlineLengthM).toBeCloseTo(expected.centerline);
      expect(candidate.geometry.totalCutLengthM).toBeCloseTo(expected.cut);
      candidate.geometry.segments.forEach((segment, i) => expect(segment.cutLengthM).toBeCloseTo(expected.cuts[i]!));
      expect(candidate.comparison.centerlineLengthDeltaM).toBeCloseTo(expected.delta);
      expect(candidate.comparison.cutLengthDeltaM).toBeCloseTo(expected.cut - 9.9);
      expect(candidate.comparison.addedFittings).toBe(4);
      expect(candidate.comparison.lineage).toHaveLength(5);
      expect(candidate.comparison.changedSegmentIds).toEqual(["pipe"]);
      expect(candidate.comparison.proposedReuse).toBeNull();
      expect(candidate.plan.heads).toEqual(input.baseline.heads);
      expect(candidate.plan.ducts).toEqual(input.baseline.ducts);
      expect(candidate.plan.nodes.filter(n => ["a", "b"].includes(n.id))).toEqual(input.baseline.nodes);
      expect(points.slice(1, -1).every(n => !n.position.confirmed && n.position.evidenceIds.length === 0)).toBe(true);
      expect(candidate.plan.fittings.every(f => !f.kind.confirmed)).toBe(true);
      expect(candidate.unresolved.join(" ")).toContain("Fitting-body");
    }
    expect(generateCandidates(input, engine)).toEqual(set);
  });

  it("returns a single candidate or no candidate by changing only the work envelope", () => {
    const input = ductFixture();
    input.workEnvelope.value!.min.y = -0.5;
    const one = generateCandidates(input, engine);
    expect(one.candidates.map(c => c.template)).toEqual(["detour:y+"]);
    input.workEnvelope.value!.max.y = 0.5;
    const none = generateCandidates(input, engine);
    expect(none.state).toBe("no_candidate");
    expect(none.candidates).toEqual([]);
    expect(none.searchedTemplates).toHaveLength(5);
    expect(none.reasons[0]?.message).toContain("not proof of global infeasibility");
  });

  it.each(["workEnvelope", "requiredPipeClearance"] as const)("keeps missing %s distinct from no candidate", key => {
    const input = ductFixture(); input[key].value = null;
    const set = generateCandidates(input, engine);
    expect(set.state).toBe("input_missing"); expect(set.searchedTemplates).toEqual([]);
    expect(set.reasons[0]?.path).toBe(key);
  });

  it("does not infer confirmed dimensions from model or unevidenced values", () => {
    const input = ductFixture(); input.baseline.nodes[0]!.position.source = "model";
    expect(generateCandidates(input, engine).state).toBe("input_missing");
    input.baseline.nodes[0]!.position.source = "manual"; input.baseline.nodes[0]!.position.evidenceIds = [];
    expect(generateCandidates(input, engine).state).toBe("input_missing");
  });

  it("rejects protected edits, unsupported geometry and broken connections distinctly", () => {
    let input = ductFixture(); input.protectedSegmentIds = ["pipe"];
    expect(generateCandidates(input, engine).state).toBe("unsupported");
    input = ductFixture(); input.baseline.nodes[1]!.position.value!.y = 1;
    expect(generateCandidates(input, engine).state).toBe("unsupported");
    input = ductFixture(); input.baseline.segments[0]!.endNodeId = "absent";
    expect(generateCandidates(input, engine).state).toBe("invalid_connection");
    input = ductFixture(); input.fixedConnectionNodeIds = ["a", "a"];
    expect(generateCandidates(input, engine).state).toBe("invalid_connection");
    input = ductFixture(); input.baseline.heads[0]!.attachedNodeId = "absent";
    expect(generateCandidates(input, engine).state).toBe("invalid_connection");
    input = ductFixture(); input.baseline.ducts[0]!.geometry = fact({ kind: "unsupported" });
    expect(generateCandidates(input, engine).state).toBe("unsupported");
  });

  it("normalizes mixed mm/ft/in inputs without moving fixed context", () => {
    const input = ductFixture();
    const convert = (p: Point, unit: "mm" | "ft", scale: number) => {
      p.x /= scale; p.y /= scale; p.z /= scale; p.unit = unit;
    };
    input.baseline.nodes.forEach(n => convert(n.position.value!, "mm", 0.001));
    input.baseline.heads.forEach(h => convert(h.position.value!, "mm", 0.001));
    convert(input.workEnvelope.value!.min, "ft", 0.3048); convert(input.workEnvelope.value!.max, "ft", 0.3048);
    input.baseline.segments[0]!.outsideDiameter = fact({ value: 0.2 / 0.0254, unit: "in" });
    const set = generateCandidates(input, engine);
    expect(set.candidates).toHaveLength(2);
    expect(set.candidates[0]!.comparison.centerlineLengthDeltaM).toBeCloseTo(2.8);
    expect(set.candidates[0]!.plan.nodes[0]!.position.value!.unit).toBe("mm");
  });

  it("rejects invalid numbers, frame mismatch and mismatched product binding", () => {
    let input = ductFixture(); input.baseline.nodes[0]!.position.value!.x = NaN;
    expect(generateCandidates(input, engine).state).toBe("invalid_input");
    input = ductFixture(); input.workEnvelope.value!.min.frameId = "another";
    expect(generateCandidates(input, engine).state).toBe("invalid_input");
    input = ductFixture(); input.baseline.segments[0]!.productId = "other";
    expect(generateCandidates(input, engine).state).toBe("invalid_input");
  });
});

describe("port outcomes and adoption boundary", () => {
  it("preserves null cuts and an input_missing outcome without losing known route lengths", () => {
    const port: GeometryPort = h => {
      const check = engine(h);
      if (check.ok && h.proposedNodeIds.length) return { ok: true, result: { ...check.result,
        state: "input_missing", totalCutLengthM: null, missingInputs: ["makeup"] } };
      return check;
    };
    const set = generateCandidates(ductFixture(), port);
    expect(set.state).toBe("input_missing"); expect(set.candidates).toHaveLength(2);
    expect(set.candidates[0]!.comparison.cutLengthDeltaM).toBeNull();
    expect(set.candidates[0]!.comparison.centerlineLengthDeltaM).toBeCloseTo(2.8);
  });

  it("records negative-cut and connectivity rejections separately", () => {
    for (const code of ["insufficient_dimensions", "invalid_connection"] as const) {
      const set = generateCandidates(ductFixture(), h => h.proposedNodeIds.length
        ? { ok: false, code, reason: "Injected engine diagnostic", path: "segment" } : engine(h));
      expect(set.candidates).toEqual([]);
      expect(set.rejected.filter(r => r.reasons[0]?.code === code)).toHaveLength(2);
    }
  });

  it("fails closed on incomplete clearance reports and propagates unexpected exceptions", () => {
    const set = generateCandidates(ductFixture(), h => {
      const check = engine(h);
      if (check.ok) check.result.ductClearances = [];
      return check;
    });
    expect(set.state).toBe("input_missing"); expect(set.candidates).toEqual([]);
    expect(() => generateCandidates(ductFixture(), () => { throw new Error("engine broken"); })).toThrow("engine broken");
  });

  it("uses the same derivation callback for baseline and candidates and guards stale selection", () => {
    const input = ductFixture(), set = generateCandidates(input, engine);
    const derived = deriveCandidatePackages(input, set, value => ({ planId: value.plan.id, revision: value.inputRevision }));
    expect(derived.baseline).toEqual({ planId: input.baseline.id, revision: 7 });
    expect(derived.candidates).toHaveLength(2);
    expect(selectCandidate(set, set.candidates[0]!.id, input).ok).toBe(true);
    expect(selectCandidate(set, set.candidates[0]!.id, { ...input, inputRevision: 8 }).ok).toBe(false);
    expect(selectCandidate(set, set.candidates[0]!.id, { ...input, configVersion: "new" }).ok).toBe(false);
    expect(selectCandidate(set, set.candidates[0]!.id, { ...input, packageId: "other" }).ok).toBe(false);
    expect(selectCandidate(set, "absent", input).ok).toBe(false);
    expect(() => deriveCandidatePackages({ ...input, inputRevision: 8 }, set, () => null)).toThrow("stale");
    const fresh = generateCandidates({ ...input, inputRevision: 8 }, engine);
    expect(fresh.candidates[0]!.id).not.toBe(set.candidates[0]!.id);
    expect(selectCandidate(fresh, set.candidates[0]!.id, { ...input, inputRevision: 8 }).ok).toBe(false);
  });

  it("the legacy adapter never confirms a persisted proposal or swallows engine bugs", () => {
    const set = generateCandidates(ductFixture(), engine), candidate = set.candidates[0]!;
    const before = structuredClone(candidate.plan);
    const adapter = createLocalGeometryPort(plan => {
      expect(plan.nodes.find(n => n.id === candidate.proposedNodeIds[0])!.position.confirmed).toBe(true);
      return candidate.geometry;
    });
    adapter({ plan: candidate.plan, proposedNodeIds: candidate.proposedNodeIds, proposedFittingIds: candidate.proposedFittingIds });
    expect(candidate.plan).toEqual(before);
    const broken = createLocalGeometryPort(() => { throw new Error("bug"); });
    expect(() => broken({ plan: candidate.plan, proposedNodeIds: [], proposedFittingIds: [] })).toThrow("bug");
  });
});

describe("core geometry integration", () => {
  it("rejects actual negative cuts", () => {
    const input = ductFixture(); input.product.centerToFace = fact({ value: 1.55, unit: "m" });
    const set = generateCandidates(input, engine);
    expect(set.state).toBe("no_candidate");
    expect(set.rejected.filter(r => r.reasons[0]?.code === "insufficient_dimensions")).toHaveLength(2);
  });
  it("keeps missing makeup unknown through actual calculations", () => {
    const input = ductFixture(); input.product.insertionOrThreadMakeup.value = null;
    const set = generateCandidates(input, engine);
    expect(set.state).toBe("input_missing"); expect(set.candidates).toHaveLength(2);
    expect(set.candidates.every(c => c.geometry.totalCutLengthM === null)).toBe(true);
  });
  it("checks all confirmed ducts rather than only the routing box", () => {
    const input = ductFixture();
    const extra = structuredClone(input.baseline.ducts[0]!); extra.id = "blocking-duct";
    const geometry = extra.geometry.value!;
    if (geometry.kind === "axis_aligned_box") { geometry.min.x = -0.1; geometry.max.x = 0.1; }
    input.baseline.ducts = [...input.baseline.ducts, extra];
    expect(generateCandidates(input, engine).candidates).toEqual([]);
  });
  it("accepts reversed tie-ins without turning the connection directions around", () => {
    const input = ductFixture();
    input.baseline.segments[0]!.startNodeId = "b"; input.baseline.segments[0]!.endNodeId = "a";
    const set = generateCandidates(input, engine);
    expect(set.candidates).toHaveLength(2);
    expect(set.candidates[0]!.geometry.totalCenterlineLengthM).toBeCloseTo(12.8);
    expect(set.candidates[0]!.plan.segments[0]!.startNodeId).toBe("b");
  });
  it.each(["y", "z"] as const)("rotates the supported span to the %s axis", axis => {
    const input = ductFixture();
    const rotate = (p: Point) => { const previous = p.x; p.x = p[axis]; p[axis] = previous; };
    input.baseline.nodes.forEach(n => rotate(n.position.value!));
    input.baseline.heads.forEach(h => rotate(h.position.value!));
    input.baseline.ducts.forEach(d => {
      const box = d.geometry.value!;
      if (box.kind === "axis_aligned_box") { rotate(box.min); rotate(box.max); }
    });
    rotate(input.workEnvelope.value!.min); rotate(input.workEnvelope.value!.max);
    const set = generateCandidates(input, engine);
    expect(set.candidates).toHaveLength(2);
    expect(set.candidates[0]!.geometry.totalCenterlineLengthM).toBeCloseTo(12.8);
  });
  it("does not substitute zero for a missing tie-in datum", () => {
    const input = ductFixture(); input.baseline.nodes[0]!.tieInNetCutOffset!.value = null;
    const set = generateCandidates(input, engine);
    expect(set.state).toBe("input_missing"); expect(set.candidates).toHaveLength(2);
    expect(set.baselineGeometry!.totalCutLengthM).toBeNull();
    expect(set.candidates[0]!.comparison.cutLengthDeltaM).toBeNull();
  });
  it("retains a direct candidate when the measured duct does not intersect the span", () => {
    const input = ductFixture(), duct = input.baseline.ducts[0]!.geometry.value!;
    if (duct.kind === "axis_aligned_box") { duct.min.y = 4; duct.max.y = 5; }
    const set = generateCandidates(input, engine);
    expect(set.candidates[0]!.template).toBe("direct");
    expect(set.candidates[0]!.comparison.addedFittings).toBe(0);
    expect(set.candidates[0]!.comparison.centerlineLengthDeltaM).toBe(0);
    expect(set.candidates[0]!.comparison.retainedSegmentIds).toEqual(["pipe"]);
  });
});
