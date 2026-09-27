import { describe, expect, it } from "vitest";
import {
  compareLocalPlanGeometry,
  evaluateLocalPlanGeometry,
  LocalGeometryInputError,
  type LocalDuctBox,
  type LocalElbowPort,
  type LocalFitting,
  type LocalLength,
  type LocalPlanGeometry,
  type LocalPlanNode,
  type LocalPoint3,
  type LocalPipeSegment,
} from "../src/local-change-geometry.js";
import type { Fact } from "../src/types.js";

const fact = <T>(value: T, id = "fixture-evidence"): Fact<T> => ({ value, confirmed: true, evidenceIds: [id], source: "fixture" });
const uncertain = <T>(value: T, id = "fixture-evidence"): Fact<T> => ({ value, confirmed: false, evidenceIds: [id], source: "fixture" });
const length = (value: number, unit: LocalLength["unit"] = "m") => fact<LocalLength>({ value, unit });
const point = (x: number, y: number, z: number, unit: LocalPoint3["unit"] = "m", frameId = "frame-1"): Fact<LocalPoint3> => fact({ x, y, z, unit, frameId });

function tieIn(id: string, xyz: [number, number, number], takeout = 0, unit: LocalPoint3["unit"] = "m"): LocalPlanNode {
  return { id, kind: "tie_in", position: point(...xyz, unit), tieInNetCutOffset: length(takeout, unit) };
}

function elbowPort(segmentId: string, endpoint: LocalElbowPort["endpoint"], nodeId: string, centerToFace = 0.05, makeup = 0.02, unit: LocalLength["unit"] = "m"): LocalElbowPort {
  return { segmentId, endpoint, nodeId, centerToFace: length(centerToFace, unit), insertionOrThreadMakeup: length(makeup, unit) };
}

function segment(id: string, startNodeId: string, endNodeId: string, od = 0.05, unit: LocalLength["unit"] = "m"): LocalPipeSegment {
  const datum = fact<"center_to_center" | "physical_pipe_end">("center_to_center");
  return { id, startNodeId, endNodeId, outsideDiameter: length(od, unit), cutEndDatumAtStart: datum, cutEndDatumAtEnd: { ...datum } };
}

function ductBox(id: string, min: [number, number, number], max: [number, number, number], unit: LocalPoint3["unit"] = "m"): LocalDuctBox {
  return {
    id,
    roomId: "room-1",
    geometry: fact({
      kind: "axis_aligned_box",
      min: { x: min[0], y: min[1], z: min[2], unit, frameId: "frame-1" },
      max: { x: max[0], y: max[1], z: max[2], unit, frameId: "frame-1" },
    }),
  };
}

function syntheticRoute(id: string, mm = false): LocalPlanGeometry {
  const unit: LocalPoint3["unit"] = mm ? "mm" : "m";
  const lengthUnit: LocalLength["unit"] = unit;
  const coordinates: [number, number, number][] = [
    [0, 0, 3],
    [1, 0, 3],
    [1, 1, 3],
    [3, 1, 3],
    [3, 0, 3],
    [4, 0, 3],
  ].map(([x, y, z]) => mm ? [x * 1000, y * 1000, z * 1000] : [x, y, z]) as [number, number, number][];
  const nodes: LocalPlanNode[] = coordinates.map((xyz, index) => index === 0 || index === 5
    ? tieIn(`${id}-n${index}`, xyz, 0, unit)
    : { id: `${id}-n${index}`, kind: "fitting_center", fittingId: `${id}-f${index}`, position: point(...xyz, unit) });
  const segments = coordinates.slice(0, -1).map((_, index) => segment(`${id}-p${index}`, `${id}-n${index}`, `${id}-n${index + 1}`, mm ? 50 : 0.05, lengthUnit));
  const fittings: LocalFitting[] = [1, 2, 3, 4].map(nodeIndex => ({
    id: `${id}-f${nodeIndex}`,
    kind: fact("elbow_90" as const),
    centerNodeId: `${id}-n${nodeIndex}`,
    ports: [
      elbowPort(`${id}-p${nodeIndex - 1}`, "end", `${id}-n${nodeIndex}`, mm ? 50 : 0.05, mm ? 20 : 0.02, lengthUnit),
      elbowPort(`${id}-p${nodeIndex}`, "start", `${id}-n${nodeIndex}`, mm ? 50 : 0.05, mm ? 20 : 0.02, lengthUnit),
    ],
  }));
  const ducts = [ductBox("fixed-duct", mm ? [1500, -300, 2700] : [1.5, -0.3, 2.7], mm ? [2500, 300, 3300] : [2.5, 0.3, 3.3], unit)];
  return {
    id,
    coordinateFrame: fact({ id: "frame-1", lengthUnit }),
    nodes,
    segments,
    fittings,
    ducts,
  };
}

function baseline(id: string): LocalPlanGeometry {
  return {
    id,
    coordinateFrame: fact({ id: "frame-1", lengthUnit: "m" }),
    nodes: [tieIn(`${id}-start`, [0, 0, 3]), tieIn(`${id}-end`, [4, 0, 3])],
    segments: [segment(`${id}-pipe`, `${id}-start`, `${id}-end`)],
    fittings: [],
    ducts: [ductBox("fixed-duct", [1.5, -0.3, 2.7], [2.5, 0.3, 3.3])],
  };
}

describe("local change deterministic geometry", () => {
  it("derives the synthetic route cut lengths, BOM counts, delta, and separate duct-envelope result", () => {
    const before = evaluateLocalPlanGeometry(baseline("before"));
    const after = evaluateLocalPlanGeometry(syntheticRoute("after"));
    const delta = compareLocalPlanGeometry(before, after);

    expect(after.unsupported).toEqual([]);
    expect(before.state).toBe("verified");
    expect(before.totalCenterlineLengthM).toBe(4);
    expect(before.totalCutLengthM).toBe(4);
    expect(before.ductClearances[0]?.state).toBe("collision");
    expect(after.state).toBe("verified");
    expect(after.totalCenterlineLengthM).toBe(6);
    expect(after.totalCutLengthM).toBeCloseTo(5.76, 12);
    expect(after.segmentCount).toBe(5);
    expect(after.elbowCount).toBe(4);
    expect(after.ductClearances.every(result => result.state === "clear")).toBe(true);
    expect(delta).toMatchObject({ state: "verified", pipeCountDelta: 4, elbowCountDelta: 4, centerlineLengthDeltaM: 2 });
    expect(delta.cutLengthDeltaM).toBeCloseTo(1.76, 12);
  });

  it("normalizes a millimetre-equivalent route to the same cut and clearance results", () => {
    const metric = evaluateLocalPlanGeometry(syntheticRoute("mm-route", true));
    const meters = evaluateLocalPlanGeometry(syntheticRoute("m-route"));
    expect(metric.totalCenterlineLengthM).toBeCloseTo(meters.totalCenterlineLengthM!, 12);
    expect(metric.totalCutLengthM).toBeCloseTo(meters.totalCutLengthM!, 12);
    expect(metric.ductClearances.map(item => item.state)).toEqual(meters.ductClearances.map(item => item.state));
  });

  it("keeps physical pipe-envelope clearance separate from fitting and sprinkler rules", () => {
    const route = syntheticRoute("duct-route");
    const result = evaluateLocalPlanGeometry(route);
    expect(result.ductClearances.map(item => item.state)).toEqual(["clear", "clear", "clear", "clear", "clear"]);
    expect(result).not.toHaveProperty("sprinklerCompliance");
  });

  it("uses exact segment-to-box distance instead of expanded AABB overlap at a corner", () => {
    const plan: LocalPlanGeometry = {
      id: "corner",
      coordinateFrame: fact({ id: "frame-1", lengthUnit: "m" }),
      nodes: [tieIn("a", [0, 0, 0]), tieIn("b", [1, 0, 0])],
      segments: [segment("p", "a", "b", 0.12)],
      fittings: [],
      ducts: [ductBox("d", [1.04, 0.05, 0], [1.14, 0.15, 1])],
    };
    const result = evaluateLocalPlanGeometry(plan);
    expect(result.ductClearances[0]?.distanceM).toBeCloseTo(Math.sqrt(0.04 ** 2 + 0.05 ** 2), 12);
    expect(result.ductClearances[0]?.state).toBe("clear");
  });

  it("returns unknown when a tie-in offset is not confirmed instead of assuming zero", () => {
    const plan = baseline("missing-offset");
    plan.nodes[0]!.tieInNetCutOffset = uncertain({ value: 0, unit: "m" });
    const result = evaluateLocalPlanGeometry(plan);
    expect(result.totalCenterlineLengthM).toBe(4);
    expect(result.totalCutLengthM).toBeNull();
    expect(result.state).toBe("input_missing");
    expect(result.missingInputs).toContain("nodes.missing-offset-start.tieInNetCutOffset");
  });

  it("does not derive cut length when one or both endpoint datums are unconfirmed", () => {
    const oneEnd = baseline("one-datum");
    oneEnd.segments[0]!.cutEndDatumAtStart = uncertain("center_to_center");
    const oneEndResult = evaluateLocalPlanGeometry(oneEnd);
    expect(oneEndResult.segments[0]).toMatchObject({ centerlineLengthM: 4, cutLengthM: null, outsideDiameterM: 0.05, state: "input_missing" });
    expect(oneEndResult.totalCenterlineLengthM).toBe(4);
    expect(oneEndResult.totalCutLengthM).toBeNull();
    expect(oneEndResult.ductClearances[0]?.state).toBe("collision");

    const bothEnds = baseline("both-datums");
    bothEnds.segments[0]!.cutEndDatumAtStart = uncertain("center_to_center");
    bothEnds.segments[0]!.cutEndDatumAtEnd = uncertain("center_to_center");
    const bothEndResult = evaluateLocalPlanGeometry(bothEnds);
    expect(bothEndResult.segments[0]?.cutLengthM).toBeNull();
    expect(bothEndResult.missingInputs).toEqual(expect.arrayContaining([
      "segments.both-datums-pipe.cutEndDatumAtStart",
      "segments.both-datums-pipe.cutEndDatumAtEnd",
    ]));
  });

  it("rejects null/model endpoint datum facts and does not normalize physical-end datums", () => {
    const nullDatum = baseline("null-datum");
    nullDatum.segments[0]!.cutEndDatumAtStart = { value: null, confirmed: false, evidenceIds: [], source: "manual" };
    expect(evaluateLocalPlanGeometry(nullDatum).totalCutLengthM).toBeNull();

    const modelDatum = baseline("model-datum");
    modelDatum.segments[0]!.cutEndDatumAtEnd = { ...fact("center_to_center"), source: "model" };
    expect(evaluateLocalPlanGeometry(modelDatum).totalCutLengthM).toBeNull();

    const physicalEnd = baseline("physical-end-datum");
    physicalEnd.segments[0]!.cutEndDatumAtStart = fact("physical_pipe_end");
    const physicalResult = evaluateLocalPlanGeometry(physicalEnd);
    expect(physicalResult.state).toBe("unsupported");
    expect(physicalResult.totalCenterlineLengthM).toBe(4);
    expect(physicalResult.totalCutLengthM).toBeNull();

    const inconsistent = baseline("inconsistent-datum");
    inconsistent.segments[0]!.cutEndDatumAtEnd = fact("physical_pipe_end");
    const inconsistentResult = evaluateLocalPlanGeometry(inconsistent);
    expect(inconsistentResult.state).toBe("unsupported");
    expect(inconsistentResult.segments[0]?.cutLengthM).toBeNull();
  });

  it("does not use model-origin confirmation as numeric evidence", () => {
    const plan = baseline("model-origin");
    plan.nodes[0]!.position = { ...point(0, 0, 3), source: "model" };
    const result = evaluateLocalPlanGeometry(plan);
    expect(result.state).toBe("input_missing");
    expect(result.totalCutLengthM).toBeNull();
  });

  it("keeps an unconfirmed elbow kind unknown instead of turning it into a graph error", () => {
    const plan = syntheticRoute("unknown-fitting");
    plan.fittings[0]!.kind = uncertain("elbow_90");
    const result = evaluateLocalPlanGeometry(plan);
    expect(result.state).toBe("input_missing");
    expect(result.totalCutLengthM).toBeNull();
    expect(result.missingInputs.some(path => path.includes("kind"))).toBe(true);
    expect(compareLocalPlanGeometry(evaluateLocalPlanGeometry(baseline("known-count-baseline")), result).elbowCountDelta).toBeNull();
  });

  it("keeps metrics invariant under a shared translation and 90-degree axis rotation", () => {
    const original = syntheticRoute("transform-original");
    const transformed = syntheticRoute("transform-copy");
    const transform = (p: LocalPoint3): LocalPoint3 => ({ ...p, x: -p.y + 11, y: p.x - 7, z: p.z + 2 });
    transformed.nodes = transformed.nodes.map(node => ({
      ...node,
      position: { ...node.position, value: transform(node.position.value!) },
    }));
    transformed.ducts = transformed.ducts.map(duct => {
      const geometry = duct.geometry.value!;
      if (geometry.kind !== "axis_aligned_box") throw new Error("fixture must be an axis-aligned box");
      const min = geometry.min;
      const max = geometry.max;
      const corners = [min.x, max.x].flatMap(x => [min.y, max.y].flatMap(y => [min.z, max.z]
        .map(z => transform({ x, y, z, unit: min.unit, frameId: min.frameId }))));
      const xs = corners.map(p => p.x);
      const ys = corners.map(p => p.y);
      const zs = corners.map(p => p.z);
      return {
        ...duct,
        geometry: { ...duct.geometry, value: {
          kind: "axis_aligned_box" as const,
          min: { ...min, x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) },
          max: { ...max, x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) },
        } },
      };
    });
    const before = evaluateLocalPlanGeometry(original);
    const after = evaluateLocalPlanGeometry(transformed);
    expect(after.totalCenterlineLengthM).toBeCloseTo(before.totalCenterlineLengthM!, 12);
    expect(after.totalCutLengthM).toBeCloseTo(before.totalCutLengthM!, 12);
    expect(after.ductClearances.map(item => item.state)).toEqual(before.ductClearances.map(item => item.state));
  });

  it("rejects duplicate IDs, mismatched frames, reversed boxes, and zero cut; unsupported axis geometry stays unknown", () => {
    const duplicate = baseline("duplicate");
    duplicate.nodes = [duplicate.nodes[0]!, duplicate.nodes[0]!];
    expect(() => evaluateLocalPlanGeometry(duplicate)).toThrow(LocalGeometryInputError);

    const diagonal = baseline("diagonal");
    diagonal.nodes[1]!.position = point(4, 0.1, 3);
    expect(evaluateLocalPlanGeometry(diagonal).state).toBe("unsupported");

    const wrongFrame = baseline("frame");
    wrongFrame.nodes[1]!.position = point(4, 0, 3, "m", "other-frame");
    expect(() => evaluateLocalPlanGeometry(wrongFrame)).toThrow(/Coordinate frame/);

    const reversed = baseline("box");
    const box = reversed.ducts[0]!.geometry.value!;
    if (box.kind !== "axis_aligned_box") throw new Error("fixture must be an axis-aligned box");
    reversed.ducts[0]!.geometry = fact({ ...box, min: { ...box.min, x: 3 }, max: { ...box.max, x: 2 } });
    expect(() => evaluateLocalPlanGeometry(reversed)).toThrow(/minimum must not exceed maximum/);

    const zeroCut = baseline("zero-cut");
    zeroCut.nodes[0]!.tieInNetCutOffset = length(2);
    zeroCut.nodes[1]!.tieInNetCutOffset = length(2);
    expect(() => evaluateLocalPlanGeometry(zeroCut)).toThrow(/positive pipe cut length/);
  });
});
