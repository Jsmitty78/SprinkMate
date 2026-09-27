import { describe, expect, it } from "vitest";
import type { WorkPackageSnapshot } from "@field-agent/core";
import { countText, feetInches, lengthInput, lengthText, parseLength } from "./format.js";
import { buildRun, callouts, dropOrphanFacts, findFact, groupChecks, requirements, routeOptions, runBlockers, runChanged, runNodes, upsertFacts, type RunNode } from "./model.js";
import { sampleInputs } from "./sample.js";

describe("display formatting", () => {
  it("never renders an unknown length or quantity as zero", () => {
    const cut = lengthText({ value: null, unit: "m", reason: "End datum not confirmed", basis: "unknown" });
    expect(cut).toEqual({ known: false, primary: "Unknown", reason: "End datum not confirmed" });
    expect(countText({ value: null, unit: "each", reason: "x", basis: "unknown" })).toBe("Unknown");
    expect(lengthText(undefined).primary).toBe("Unknown");
    expect(lengthText({ value: 0, unit: "furlong", basis: "confirmed_inputs" }).primary).toBe("Unknown");
  });

  it("rounds server metres to the nearest 1/16 inch for display", () => {
    expect(feetInches(0.5762625)).toBe("1′-10 11/16″");
    expect(feetInches(9.9)).toBe("32′-5 3/4″");
    expect(feetInches(-0.0254, true)).toBe("−1″");
    expect(lengthText({ value: 2.8, unit: "m", basis: "proposed_inputs" }, true)).toMatchObject({ primary: "+9′-2 1/4″", secondary: "+2,800 mm" });
  });

  it("parses lengths typed in feet-inches or millimetres", () => {
    expect(parseLength(`10' 2-1/2"`)).toBeCloseTo(3111.5);
    expect(parseLength(`24"`)).toBeCloseTo(609.6);
    expect(parseLength("3.1 m")).toBe(3100);
    expect(parseLength("457.2")).toBe(457.2);
    expect(parseLength("18", "in")).toBeCloseTo(457.2);
    expect(parseLength(lengthInput(-400, "in"), "in")).toBeCloseTo(-400, 0);
    expect(parseLength(lengthInput(-2800, "in"), "in")).toBeCloseTo(-2800, 0);
    expect(parseLength("abc")).toBeNull();
    expect(parseLength("")).toBeNull();
  });
});

describe("run editor", () => {
  it("builds the same plan structure as the server fixture for an open spool", () => {
    const built = buildRun([{ kind: "open_end", x: 0, y: 0 }, { kind: "elbow", x: 609.6, y: 0 }, { kind: "open_end", x: 609.6, y: 457.2 }]);
    if ("problems" in built) throw new Error(built.problems.join());
    expect(built.plan.entities.map(e => [e.id, e.kind, e.productId])).toEqual([
      ["p1", "pipe", "spears/CP-010"], ["p2", "pipe", "spears/CP-010"], ["f1", "fitting", "spears/4206-010S"],
    ]);
    expect(built.plan.connections).toEqual([
      { id: "f1-in", from: { entityId: "p1", portId: "end" }, to: { entityId: "f1", portId: "in" } },
      { id: "f1-out", from: { entityId: "p2", portId: "start" }, to: { entityId: "f1", portId: "out" } },
    ]);
    expect(built.datums.map(d => `${d.field}:${d.subjectIds}:${d.value}`)).toEqual([
      "datum.start:p1:physical_pipe_end", "datum.end:p1:center_to_center", "datum.start:p2:center_to_center", "datum.end:p2:physical_pipe_end",
    ]);
    expect(built.scope.tieInEntityIds).toEqual([]);
    expect(runNodes(built.plan)).toEqual([{ kind: "open_end", x: 0, y: 0 }, { kind: "elbow", x: 609.6, y: 0 }, { kind: "open_end", x: 609.6, y: 457.2 }]);
  });

  it("connects tie-ins to the pipe ends", () => {
    const built = buildRun([{ kind: "tie_in", x: 0, y: 0 }, { kind: "tie_in", x: 10000, y: 0 }]);
    if ("problems" in built) throw new Error(built.problems.join());
    expect(built.scope.tieInEntityIds).toEqual(["t1", "t2"]);
    expect(built.plan.connections.map(c => `${c.from.entityId}/${c.from.portId}>${c.to.entityId}`)).toEqual(["p1/start>t1", "p1/end>t2"]);
  });

  it("reports incomplete runs instead of guessing", () => {
    const built = buildRun([{ kind: "tie_in", x: 0, y: null }, { kind: "open_end", x: 0, y: 5 }, { kind: "elbow", x: 1, y: 1 }]);
    expect("problems" in built && built.problems).toEqual([
      "Point 1 needs both X and Y.", "Point 2 is between two pipes, so it must be an elbow.", "Point 3 is an end, so it must be a tie-in or an open end.",
    ]);
  });
});

describe("run preconditions", () => {
  it("asks for confirmed open ends before the server would fail", () => {
    const built = buildRun([{ kind: "open_end", x: 0, y: 0 }, { kind: "elbow", x: 600, y: 0 }, { kind: "tie_in", x: 600, y: 400 }]);
    if ("problems" in built) throw new Error();
    const s = { sourceDrawing: { assetId: "a" }, baselinePlan: built.plan, scope: built.scope, detailing: [], siteFacts: [] } as unknown as WorkPackageSnapshot;
    expect(runBlockers(s)).toEqual(["Confirm that the start of p1 is a physical pipe end (Confirm dimensions)."]);
    const confirmed = { ...s, ...upsertFacts(s, built.datums.map(d => ({ ...d, confirmation: "confirmed" as const }))) };
    expect(runBlockers(confirmed)).toEqual([]);
  });
});

describe("facts", () => {
  it("replaces a fact with the same field and subject across both lists", () => {
    const s = { detailing: [], siteFacts: [] } as unknown as WorkPackageSnapshot;
    const once = upsertFacts(s, [{ field: "duct.min.x", value: 4000, unit: "mm", confirmation: "confirmed", context: "detailing", source: "a" }]);
    const twice = upsertFacts({ ...s, ...once }, [{ field: "duct.min.x", value: 4100, unit: "mm", confirmation: "confirmed", context: "observed", source: "b" }]);
    expect(twice.detailing).toHaveLength(0);
    expect(twice.siteFacts).toHaveLength(1);
    expect(findFact(twice as WorkPackageSnapshot, "duct.min.x")?.value).toBe(4100);
  });

  it("stores an unmeasured value as unknown, never as a confirmed zero", () => {
    const s = { detailing: [], siteFacts: [] } as unknown as WorkPackageSnapshot;
    const out = upsertFacts(s, [{ field: "requiredPipeClearance", value: null, unit: "mm", confirmation: "confirmed", context: "observed", source: "x" }]);
    expect(out.siteFacts[0]).toMatchObject({ value: null, confirmation: "proposed", unknownReason: "Not measured yet" });
  });
});

describe("sample inputs", () => {
  it("are labelled as sample and satisfy every presence check", () => {
    for (const kind of ["prepare", "adapt"] as const) {
      const inputs = sampleInputs(kind, "asset-1");
      const s = { ...inputs, intent: kind === "prepare" ? "prepare_from_drawing" : "adapt_to_site" } as unknown as WorkPackageSnapshot;
      expect(requirements(s).filter(r => !r.done)).toEqual([]);
      expect([...inputs.detailing, ...inputs.siteFacts].every(f => f.source.description.startsWith("SAMPLE"))).toBe(true);
    }
  });
});

describe("routes and checks", () => {
  const plan = (id: string, fittings: number) => ({
    id, coordinateFrame: { id: "room", lengthUnit: "mm" as const, axes: "right_handed_z_up" as const }, confirmation: "proposed" as const, connections: [],
    entities: Array.from({ length: fittings }, (_, i) => ({ id: `f${i}`, kind: "fitting" as const, productId: null, ports: [] })),
  });
  const metric = (value: number | null) => [{ name: "centerline_delta", quantity: value === null ? { value: null, unit: "m", reason: "Clearance above duct missing", basis: "unknown" as const } : { value, unit: "m", reason: null, basis: "proposed_inputs" as const } }];

  it("orders routes by fittings, then the planner's length delta, unknown last", () => {
    const set = { id: "c", inputRevision: 1, configVersion: "x", baselinePlanId: "baseline", searchDescription: "", rejected: [], gaps: [], candidates: [
      { plan: plan("slow", 4), metrics: metric(3.3) }, { plan: plan("unknown", 4), metrics: metric(null) }, { plan: plan("fast", 4), metrics: metric(2.8) },
    ] };
    const options = routeOptions(set, []);
    expect(options.map(o => `${o.letter}:${o.plan.id}`)).toEqual(["A:fast", "B:slow", "C:unknown"]);
    expect(options[2]).toMatchObject({ centerlineDeltaM: null, unknownReason: "Clearance above duct missing" });
  });

  it("merges repeated findings and keeps their sources", () => {
    const groups = groupChecks([
      { id: "1", subjectIds: [], status: "unknown", reason: "Pending", sourceRefs: ["a"] },
      { id: "2", subjectIds: [], status: "unknown", reason: "Pending", sourceRefs: ["b"] },
      { id: "3", subjectIds: ["p1"], status: "pass", reason: "Cut ok", sourceRefs: [] },
    ]);
    expect(groups).toEqual([
      { status: "unknown", reason: "Pending", sourceRefs: ["a", "b"], subjectIds: [], count: 2 },
      { status: "pass", reason: "Cut ok", sourceRefs: [], subjectIds: ["p1"], count: 1 },
    ]);
  });

  it("prefers the fabrication detail's callouts", () => {
    const built = buildRun([{ kind: "open_end", x: 0, y: 0 }, { kind: "elbow", x: 1, y: 0 }, { kind: "open_end", x: 1, y: 1 }]);
    if ("problems" in built) throw new Error();
    const c = callouts(built.plan, { cuts: [{ pieceId: "p2", callout: 7 }], fittings: [{ id: "f1", callout: "F9" }] });
    expect([c.piece.get("p1"), c.piece.get("p2"), c.fitting.get("f1")]).toEqual(["1", "7", "F9"]);
  });
});

describe("run edits", () => {
  const three: RunNode[] = [{ kind: "open_end", x: 0, y: 0 }, { kind: "elbow", x: 609.6, y: 0 }, { kind: "open_end", x: 609.6, y: 457.2 }];
  const two: RunNode[] = [{ kind: "open_end", x: 0, y: 0 }, { kind: "open_end", x: 609.6, y: 0 }];

  it("drops facts for entities removed from a shortened run", () => {
    const long = buildRun(three, "baseline", "test");
    const short = buildRun(two, "baseline", "test");
    if ("problems" in long || "problems" in short) throw new Error("bad run");
    const before = upsertFacts({ detailing: [], siteFacts: [] }, long.datums.map(d => ({ ...d, confirmation: "confirmed" as const, source: "test" })));
    expect(before.detailing.some(f => f.subjectIds.includes("p2"))).toBe(true);
    const after = dropOrphanFacts(before, short.plan);
    const ids = new Set(short.plan.entities.map(e => e.id));
    expect(after.detailing.length).toBeGreaterThan(0);
    expect(after.detailing.every(f => f.subjectIds.every(id => ids.has(id)))).toBe(true);
  });

  it("detects sub-millimetre edits before confirming dimensions", () => {
    const saved: RunNode[] = [{ kind: "open_end", x: 0, y: 0 }, { kind: "open_end", x: 1000, y: 0 }];
    expect(runChanged(saved, saved, "mm")).toBe(false);
    for (const x of [1000.1, 1000.5, 999.9]) {
      expect(runChanged([saved[0], { ...saved[1], x }], saved, "mm")).toBe(true);
    }
    expect(runChanged(two, three, "mm")).toBe(true);
    expect(runChanged(three, null, "mm")).toBe(true);
  });

  it.each(["mm", "in"] as const)("allows untouched %s display rounding but detects edits to it", unit => {
    const saved: RunNode[] = [{ kind: "open_end", x: 0, y: 0 }, { kind: "open_end", x: 1000.04, y: null }];
    const displayed = saved.map(n => ({ ...n, x: parseLength(lengthInput(n.x, unit), unit), y: parseLength(lengthInput(n.y, unit), unit) }));
    expect(runChanged(displayed, saved, unit)).toBe(false);
    expect(runChanged([displayed[0], { ...displayed[1], x: displayed[1].x! + 0.1 }], saved, unit)).toBe(true);
    expect(runChanged([displayed[0], { ...displayed[1], kind: "tie_in" }], saved, unit)).toBe(true);
    expect(runChanged([displayed[0], { ...displayed[1], y: 0 }], saved, unit)).toBe(true);
  });
});
