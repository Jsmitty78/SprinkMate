import { describe, expect, it } from "vitest";
import { adaptationExample, confirmed, drawingExample } from "../examples/fixtures.js";
import { compareWorkPackages, deriveWorkPackage, ELBOW_ID, isFresh, PIPE_ID, spearsCatalog, toLocalPlanGeometry, toMeters } from "../src/index.js";
import type { Catalog, FabricationInput } from "../src/types.js";
const catalog = () => spearsCatalog("example-config-1");
const derive = (input = drawingExample(), products = catalog()) => deriveWorkPackage(input, products);

describe("manufacturer-backed dimensions with invented drawing (not field validation)", () => {
  it("matches independent inch arithmetic and reconciles parts, ports, sources and operations", () => {
    const result = derive();
    // Hand oracle: 24 - 1 5/16 = 22 11/16 in; 18 - 1 5/16 = 16 11/16 in.
    expect(result.cuts.map(c => c.centerline.value)).toEqual([0.6095999999999999, 0.4572]);
    expect(result.cuts[0].cutLength.value).toBeCloseTo(0.5762625, 10);
    expect(result.cuts[1].cutLength.value).toBeCloseTo(0.4238625, 10);
    expect(result.cuts[0].takeouts[1]).toMatchObject({ fittingId: "f1", portId: "in", centerToFaceM: 0.060325 });
    expect(result.cuts[0].takeouts[1].insertionM).toBeCloseTo(0.0269875, 10);
    expect(result.cuts[0].takeouts[1].netTakeout.value).toBeCloseTo(0.0333375, 10);
    expect(result.materials.find(m => m.productId === PIPE_ID)?.quantity.value).toBe(2);
    expect(result.materials.find(m => m.productId === PIPE_ID)?.cutLength?.value).toBeCloseTo(1.000125, 10);
    expect(result.materials.find(m => m.productId === ELBOW_ID)?.quantity.value).toBe(1);
    expect(result.materials.find(m => m.kind === "consumable")?.quantity.value).toBeNull();
    expect(result.joints.map(j => [j.id, j.pieceId, j.orientation])).toEqual([["f1/in", "p1", "-X"], ["f1/out", "p2", "+Y"]]);
    expect(result.operations.map(o => o.code)).toEqual([
      "cut_square", "deburr_bevel", "cut_square", "deburr_bevel",
      "inspect_dry_fit_clean", "apply_cement", "insert_rotate_hold", "set_and_cure",
      "inspect_dry_fit_clean", "apply_cement", "insert_rotate_hold", "set_and_cure",
    ]);
    expect(result.operations.every(o => o.status === "planned")).toBe(true);
    result.operations.forEach((o, i) => {
      expect(o.number).toBe(i + 1);
      expect(o.predecessorId).toBe(i === 0 ? null : `op-${i}`);
      expect(o.pieceIds.every(id => result.cuts.some(c => c.pieceId === id))).toBe(true);
      expect(o.jointIds.every(id => result.joints.some(j => j.id === id))).toBe(true);
      expect(o.sourceIds.every(id => result.sources.some(s => s.id === id))).toBe(true);
    });
    expect(result.cuts[0].sourceSegmentIds).toEqual(["source-1"]);
    expect(result.subassemblies).toEqual([{ id: "spool-1", pieceIds: ["p1", "p2"], jointIds: ["f1/in", "f1/out"] }]);
    expect(result.constructionApproval).toBe("not_assessed");
    expect(result.evidenceClass).toBe("manufacturer_document");
  });
  it("has identical calculation and assembly in either intent and does not mutate inputs", () => {
    const original = drawingExample(), snapshot = structuredClone(original);
    const first = derive(original); const second = derive({ ...original, intent: "adapt_to_site" });
    for (const key of ["materials", "cuts", "joints", "operations"] as const) expect(second[key]).toEqual(first[key]);
    expect(original).toEqual(snapshot);
  });
  it("handles mixed explicit units without using nominal diameter as actual OD", () => {
    const input = drawingExample();
    input.nodes[1].position.value = { x: 2, y: 0, z: 0, unit: "ft", frameId: "example-room" };
    input.nodes[2].position.value = { x: 609.6, y: 457.2, z: 0, unit: "mm", frameId: "example-room" };
    expect(derive(input).cuts[1].cutLength.value).toBeCloseTo(0.4238625, 10);
    expect(toMeters({ value: 1, unit: "ft" })).toBe(0.3048);
    expect(toLocalPlanGeometry(input, catalog()).segments[0].outsideDiameter.value).toEqual({ value: 1.315, unit: "in" });
  });
});

describe("unknowns, evidence, and access", () => {
  it("keeps known counts and centerlines when socket data is missing", () => {
    const products = catalog(); const elbow = products.products[1];
    if (elbow.kind === "elbow_90") elbow.centerToSocketBottom = null;
    const result = derive(drawingExample(), products);
    expect(result.cuts).toHaveLength(2);
    expect(result.cuts.every(c => c.cutLength.value === null && c.centerline.value !== null)).toBe(true);
    expect(result.materials[0].quantity.value).toBe(2);
    expect(result.materials[0].cutLength?.value).toBeNull();
    expect(result.operations.some(o => o.status === "needs_confirmation")).toBe(true);
  });
  it("preserves unsupported pipe/fitting/head/support/coupling rows", () => {
    const input = drawingExample(); input.pieces[0].productId = "unsupported-pipe"; input.fittings[0].productId = "unsupported-elbow";
    input.accessories = (["head", "support", "coupling"] as const).map((kind, i) => ({ id: kind, kind, productId: null,
      quantity: i === 1 ? { value: null, status: "unknown", reason: "Count not confirmed", evidenceIds: [] } : confirmed(1),
      attachedPieceIds: ["p1"], reason: "Outside supported catalog" }));
    input.evidence[0].subjectIds.push("head", "support", "coupling");
    const result = derive(input);
    expect(result.materials.filter(m => m.status === "unsupported")).toHaveLength(5);
    expect(result.materials.find(m => m.id === "support")?.quantity.value).toBeNull();
    expect(result.materials.find(m => m.id === "head")?.quantity.value).toBe(1);
    expect(result.cuts[0].centerline.value).toBeCloseTo(0.6096);
    expect(result.cuts[0].cutLength.value).toBeNull();
    expect(result.operations.filter(o => o.code === "resolve_accessory")).toHaveLength(3);
  });
  it("does not accept another subject's confirmation evidence", () => {
    const input = drawingExample(); input.evidence[0].subjectIds = ["unrelated"];
    const result = derive(input);
    expect(result.cuts.every(c => c.centerline.value === null)).toBe(true);
    expect(result.gaps.some(g => g.reason.includes("another subject"))).toBe(true);
  });
  it("retains proposal calculations without marking proposal or selection as confirmation", () => {
    const input = adaptationExample(); const result = derive(input);
    expect(result.cuts.every(c => c.cutLength.value !== null && c.cutLength.basis === "proposed_inputs")).toBe(true);
    expect(result.operations.every(o => o.status === "needs_confirmation")).toBe(true);
    expect(result.sourceDrawing).toEqual(input.sourceDrawing);
    expect(result.selectedPlanId).toBe("candidate-a");
    expect(result.constructionApproval).toBe("not_assessed");
    expect(toLocalPlanGeometry(input, catalog()).nodes[1].position).toMatchObject({ confirmed: false, source: "model" });
  });
  it("requires scoped insertion/rotation and cure confirmation; false is not true", () => {
    const input = drawingExample();
    input.assemblyConditions.jointMovement["f1/in"] = confirmed(false);
    input.assemblyConditions.curePlan = { value: null, status: "unknown", evidenceIds: [], reason: "Temperature missing" };
    const result = derive(input);
    expect(result.operations.filter(o => o.jointIds.includes("f1/in")).every(o => o.status === "needs_confirmation")).toBe(true);
    expect(result.gaps.some(g => g.reason.includes("quarter-turn"))).toBe(true);
    expect(result.gaps.some(g => g.reason.includes("Temperature missing"))).toBe(true);
    expect(result.cuts[0].cutLength.value).toBeCloseTo(0.5762625);
  });
  it("keeps field tie-ins visible and requires offsets and a closure procedure", () => {
    const input = drawingExample(); input.nodes[0].datum = "tie_in";
    let result = derive(input);
    expect(result.cuts[0].cutLength.value).toBeNull();
    expect(result.cuts[1].cutLength.value).not.toBeNull();
    expect(result.joints[0]).toMatchObject({ id: "p1/start/tie-in", location: "field", procedureId: null });
    input.nodes[0].netCutOffset = confirmed({ value: 10, unit: "mm" });
    result = derive(input);
    expect(result.cuts[0].cutLength.value).toBeCloseTo(0.5662625);
    expect(result.operations.some(o => o.code === "resolve_connection" && o.status === "unsupported")).toBe(true);
  });
  it("does not silently approve proposed reuse", () => {
    const input = drawingExample(); input.pieces[0].disposition = "proposed_reuse";
    expect(derive(input).operations.filter(o => o.pieceIds.includes("p1")).every(o => o.status === "needs_confirmation")).toBe(true);
  });
});

describe("independent synthetic arithmetic only", () => {
  it("subtracts source-independent H minus insertion at both ends", () => {
    const input = adaptationExample(); const products: Catalog = catalog();
    products.evidenceClass = "synthetic_arithmetic";
    const elbow = products.products[1];
    if (elbow.kind === "elbow_90") { elbow.centerToFace = { value: 100, unit: "mm" }; elbow.centerToSocketBottom = { value: 70, unit: "mm" }; }
    const result = derive(input, products);
    // Middle piece: 24in = 609.6mm, two net takeouts of 70mm => 469.6mm.
    expect(result.cuts[1].cutLength.value).toBeCloseTo(0.4696, 10);
    expect(result.cuts[1].takeouts[0].insertionM).toBeCloseTo(0.03, 10);
    expect(result.evidenceClass).toBe("synthetic_arithmetic");
    expect(result.joints.every(j => j.procedureId === null)).toBe(true);
  });
});

describe("reject malformed structure, retain unsupported geometry", () => {
  it.each([
    ["duplicate ID", (i: FabricationInput) => { i.pieces[1].id = "p1"; }],
    ["bad reference", (i: FabricationInput) => { i.fittings[0].ports[0].pieceId = "ghost"; }],
    ["wrong endpoint", (i: FabricationInput) => { i.fittings[0].ports[0].end = "start"; }],
    ["frame", (i: FabricationInput) => { i.nodes[1].position.value!.frameId = "other"; }],
    ["NaN", (i: FabricationInput) => { i.nodes[1].position.value!.x = NaN; }],
    ["no pipe remains", (i: FabricationInput) => { i.nodes[0].position.value!.x = 23; }],
    ["bad revision", (i: FabricationInput) => { i.inputRevision = 1.5; }],
  ])("rejects %s", (_, change) => { const input = drawingExample(); change(input); expect(() => derive(input)).toThrow(); });
  it("does not detail a nonorthogonal or collinear elbow", () => {
    const input = drawingExample(); input.nodes[2].position.value!.x = 25;
    const result = derive(input);
    expect(result.cuts[0].centerline.value).not.toBeNull();
    expect(result.cuts.every(c => c.cutLength.value === null)).toBe(true);
    input.nodes[2].position.value = { x: 48, y: 0, z: 0, unit: "in", frameId: "example-room" };
    expect(derive(input).cuts.every(c => c.cutLength.value === null)).toBe(true);
  });
});

describe("delta, lineage and freshness", () => {
  it("reconciles hand-counted baseline and candidate without removing source lineage", () => {
    const before = derive(), after = derive(adaptationExample()); const result = compareWorkPackages(before, after);
    // Same 42in total centerline; two additional G takeouts => -2.625in.
    expect(result.centerlineDeltaM).toBeCloseTo(0);
    expect(result.cutLengthDeltaM).toBeCloseTo(-0.066675, 10);
    expect(result.materials.find(m => m.id === `pipe:${PIPE_ID}`)?.quantityDelta).toBe(1);
    expect(result.materials.find(m => m.id === `fitting:${ELBOW_ID}`)?.quantityDelta).toBe(1);
    expect(result.jointCountDelta).toBe(2); expect(result.operationCountDelta).toBe(10);
    expect(result.lineage.find(l => l.sourceSegmentId === "source-1")).toMatchObject({ state: "piece_split_or_merge", candidatePieceIds: ["q1", "q2"] });
    expect(result.lineage.every(l => l.state !== "removed")).toBe(true);
  });
  it("keeps unknown deltas null but known count deltas available", () => {
    const input = drawingExample(); input.nodes[0].datum = "tie_in";
    const result = compareWorkPackages(derive(), derive(input));
    expect(result.cutLengthDeltaM).toBeNull();
    expect(result.materials[0].quantityDelta).toBe(0);
    expect(result.pieces[0].state).toBe("unknown");
  });
  it("binds freshness and comparison to package, plan, revision and configuration", () => {
    const input = drawingExample(), result = derive(input);
    expect(isFresh(result, input)).toBe(true);
    for (const changed of [{ inputRevision: 2 }, { configVersion: "new" }, { packageId: "another" }, { planId: "another" }]) {
      expect(isFresh(result, { ...input, ...changed })).toBe(false);
    }
    expect(() => derive({ ...input, configVersion: "new" })).toThrow(/configVersion/);
    expect(() => compareWorkPackages(result, { ...result, packageId: "other" })).toThrow();
  });
});

describe("planning product bridge", () => {
  it("maps G to insertion H-G without inventing thread makeup", async () => {
    const { toPlanningProduct } = await import("../src/index.js");
    const port = toPlanningProduct(catalog());
    expect(port.compatibility.value).toEqual({ pipeProductId: PIPE_ID, elbowProductId: ELBOW_ID, connectionMethod: "cpvc_socket_solvent" });
    expect(port.centerToFace.value).toEqual({ value: 0.060325, unit: "m" });
    expect(port.insertionOrThreadMakeup.value?.value).toBeCloseTo(0.0269875, 10);
    const products = catalog(); const elbow = products.products[1];
    if (elbow.kind === "elbow_90") elbow.centerToSocketBottom = null;
    expect(toPlanningProduct(products).insertionOrThreadMakeup.value).toBeNull();
    products.evidenceClass = "synthetic_arithmetic";
    expect(toPlanningProduct(products).compatibility.confirmed).toBe(false);
  });
});
