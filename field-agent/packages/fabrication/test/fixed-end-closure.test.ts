import { describe, expect, it } from "vitest";
import { compareWorkPackages, deriveFixedEndClosure, deriveWorkPackage, spearsCatalog } from "../src/index.js";
import type { ClosureProposal, FabricationInput, Value } from "../src/index.js";
// Entire geometry/conditions are fictional; these are NOT positive installation acceptance.
const proposed = <T>(value: T): Value<T> => ({ value, status: "proposed", evidenceIds: [], reason: "Developer fixture" });
function fixture(length = 3000, station = 1000) {
  const input: FabricationInput = {
    projectId: "fictional-A", packageId: "package", planId: "selected", baselinePlanId: "baseline", intent: "adapt_to_site",
    inputRevision: 2, configVersion: "test", sourceDrawing: { id: "invented", revision: "1", approval: "unknown" },
    planRole: "candidate", selectedPlanId: "selected", siteEvidenceIds: [], frame: { id: "local", lengthUnit: "mm" },
    nodes: [0, length].map((x, i) => ({ id: `n${i}`, datum: "tie_in", position: proposed({ x, y: 0, z: 0, unit: "mm", frameId: "local" }),
      netCutOffset: { value: null, status: "unknown", evidenceIds: [], reason: "Scope interface is not a measured pipe end" } })),
    pieces: [{ id: "span", sourceSegmentIds: ["source-span"], productId: "unresolved-steel", startNodeId: "n0", endNodeId: "n1", subassemblyId: "run", disposition: "new" }],
    fittings: [], accessories: [], evidence: [],
    assemblyConditions: { workAreaAccess: proposed(true), jointMovement: {}, curePlan: proposed("Not applicable") },
  };
  const proposal: ClosureProposal = { id: "closure", binding: { projectId: input.projectId, packageId: input.packageId,
    planId: input.planId, inputRevision: input.inputRevision, configVersion: input.configVersion }, pipeProductId: "unresolved-steel",
    unionCandidateId: "anvil/487-black-nps2", splitPieceId: "span", station: proposed({ x: station, y: 0, z: 0, unit: "mm", frameId: "local" }),
    conditions: { physicalInterfaces: proposed(true), productCompatibility: proposed(true), rotationAndMovement: proposed(true), toolAndBoltAccess: proposed(true) } };
  return { input, proposal, catalog: spearsCatalog("test") };
}
const derive = (f = fixture()) => deriveFixedEndClosure(f.input, f.catalog, f.proposal);
describe("fixed-end draft accounting", () => {
  it.each([[3000, 1000, [1, 2]], [4200, 1700, [1.7, 2.5]]] as const)("splits %i mm with independent oracles", (length, station, expected) => {
    const f = fixture(length, station), snapshot = structuredClone(f.input), result = derive(f);
    expect(result.cuts.map(c => c.centerline.value)).toEqual(expected);
    expect(result.cuts.every(c => c.cutLength.value === null)).toBe(true);
    expect(result.materials.find(m => m.kind === "pipe")?.quantity.value).toBe(2);
    expect(result.materials.find(m => m.productId === f.proposal.unionCandidateId)?.quantity.value).toBe(1);
    expect(result.materials.find(m => m.id === "closure/gasket")?.quantity.value).toBe(1);
    expect(result.materials.find(m => m.id === "closure/bolts")?.quantity.value).toBe(4);
    // 2 outer interfaces + 2 union threads + 1 gasket connection.
    expect(result.joints).toHaveLength(5);
    expect(result.fittings[0].jointIds).toHaveLength(3);
    expect(result.cuts.map(c => c.callout)).toEqual([1, 2]);
    expect(result.cuts.every(c => c.sourceSegmentIds[0] === "source-span")).toBe(true);
    const delta = compareWorkPackages(deriveWorkPackage(f.input, f.catalog), result);
    expect(delta.jointCountDelta).toBe(3);
    expect(delta.centerlineDeltaM).toBeCloseTo(0, 12);
    expect(delta.operationCountDelta).toBe(10);
    expect(delta.lineage[0].state).toBe("piece_split_or_merge");
    expect(f.input).toEqual(snapshot);
  });
  it("preserves unknowns and unapproved proposal state through JSON handoff", () => {
    const result = JSON.parse(JSON.stringify(derive())) as ReturnType<typeof derive>;
    expect(result.constructionApproval).toBe("not_assessed");
    expect(result.sourceDrawing.approval).toBe("unknown");
    expect(result.operations.filter(o => o.code === "review_fixed_end_closure").every(o => o.status === "needs_confirmation")).toBe(true);
    for (const reason of ["physicalInterfaces", "productCompatibility", "rotationAndMovement", "toolAndBoltAccess", "practitioner", "axial datums"]) {
      expect(result.gaps.some(g => g.reason.includes(reason))).toBe(true);
    }
    expect(result.joints.at(-1)?.procedureId).toBeNull();
  });
  it("uses a second explicit size without adopting its datums", () => {
    const f = fixture(); f.proposal.unionCandidateId = "anvil/487-black-nps1";
    const result = derive(f);
    expect(result.materials.find(m => m.id === "closure/bolts")?.quantity.value).toBe(3);
    expect(result.cuts.every(c => c.cutLength.value === null)).toBe(true);
  });
  it("invalidates product-bound access and never turns confirmations into procedure approval", () => {
    const f = fixture();
    f.proposal.conditionProducts = { pipeProductId: f.proposal.pipeProductId, unionCandidateId: f.proposal.unionCandidateId };
    f.input.evidence.push({ id: "review", subjectIds: ["closure"], description: "Invented confirmation, not a practitioner review" });
    for (const key of Object.keys(f.proposal.conditions) as (keyof ClosureProposal["conditions"])[]) {
      f.proposal.conditions[key] = { value: true, status: "confirmed", evidenceIds: ["review"], reason: null };
    }
    expect(derive(f).gaps.some(g => g.reason.includes("practitioner"))).toBe(true);
    expect(derive(f).gaps.some(g => g.reason.includes("Confirm closure toolAndBoltAccess"))).toBe(false);
    f.proposal.unionCandidateId = "anvil/487-black-nps1";
    expect(derive(f).gaps.some(g => g.reason.includes("Confirm closure toolAndBoltAccess"))).toBe(true);
  });
  it("handles mixed units, translation and reversed axis", () => {
    const f = fixture();
    f.input.nodes[0].position = proposed({ x: 8, y: 4, z: 2, unit: "ft", frameId: "local" });
    f.input.nodes[1].position = proposed({ x: 8, y: -6, z: 2, unit: "ft", frameId: "local" });
    f.proposal.station = proposed({ x: 96, y: 0, z: 24, unit: "in", frameId: "local" });
    const result = derive(f);
    expect(result.cuts[0].centerline.value).toBeCloseTo(1.2192, 10);
    expect(result.cuts[1].centerline.value).toBeCloseTo(1.8288, 10);
  });
  it.each(["projectId", "packageId", "planId", "inputRevision", "configVersion"] as const)("rejects stale/foreign %s", key => {
    const f = fixture();
    if (key === "inputRevision") f.proposal.binding[key]++;
    else f.proposal.binding[key] += "-other";
    expect(() => derive(f)).toThrow("binding");
  });
  it("rejects wrong-subject access evidence, changed pipe and CPVC", () => {
    const f = fixture();
    f.proposal.conditions.toolAndBoltAccess = { value: true, status: "confirmed", evidenceIds: ["wrong"], reason: null };
    f.input.evidence.push({ id: "wrong", subjectIds: ["another"], description: "Invented" });
    expect(derive(f).gaps.some(g => g.reason.includes("toolAndBoltAccess"))).toBe(true);
    f.input.pieces[0].productId = "changed";
    expect(() => derive(f)).toThrow("selection changed");
    f.input.pieces[0].productId = f.proposal.pipeProductId = "spears/CP-010";
    expect(() => derive(f)).toThrow("CPVC");
  });
  it.each([{ x: 0 }, { x: 3000 }, { x: NaN }, { y: 1 }, { frameId: "foreign" }])("rejects invalid station %j", patch => {
    const f = fixture(); Object.assign(f.proposal.station.value!, patch);
    expect(() => derive(f)).toThrow();
  });
  it("rewires adjacent fittings and retained accessories", () => {
    const f = fixture(); f.input.nodes[1].datum = "fitting_center";
    f.input.nodes.push({ id: "n2", datum: "tie_in", position: proposed({ x: 3000, y: 800, z: 0, unit: "mm", frameId: "local" }) });
    f.input.pieces.push({ ...f.input.pieces[0], id: "leg", startNodeId: "n1", endNodeId: "n2" });
    f.input.fittings.push({ id: "corner", nodeId: "n1", productId: "unresolved-elbow", sourceEntityIds: ["corner"], ports: [
      { id: "in", pieceId: "span", end: "end", location: "shop" }, { id: "out", pieceId: "leg", end: "start", location: "shop" }] });
    f.input.accessories.push({ id: "support", kind: "support", productId: null, quantity: proposed(1), attachedPieceIds: ["span"], reason: "Support review pending" });
    const result = derive(f);
    expect(result.fittings.find(f => f.id === "corner")?.ports[0].pieceId).toBe("span/after-closure");
    expect(result.cuts).toHaveLength(3);
    expect(result.materials.find(m => m.id === "support")?.quantity.value).toBe(1);
  });
});

 it.each([false, true])("preserves run order for reversed pieces (preceding neighbor: %s)", preceding => {
   const f = fixture(); f.input.nodes[1].datum = "fitting_center";
   f.input.nodes.push({ id: "n2", datum: "tie_in", position: proposed({ x: 3000, y: 800, z: 0, unit: "mm", frameId: "local" }) });
   f.input.pieces[0].startNodeId = "n1"; f.input.pieces[0].endNodeId = "n0";
   const leg = { ...f.input.pieces[0], id: "leg", startNodeId: "n1", endNodeId: "n2" };
   if (preceding) { f.input.pieces[0].startNodeId = "n0"; f.input.pieces[0].endNodeId = "n1"; f.input.pieces.unshift(leg); }
   else f.input.pieces.push(leg);
   f.input.fittings.push({ id: "corner", nodeId: "n1", productId: "unresolved-elbow", sourceEntityIds: ["corner"], ports: [
     { id: "in", pieceId: "span", end: preceding ? "end" : "start", location: "shop" }, { id: "out", pieceId: "leg", end: "start", location: "shop" }] });
   expect(() => deriveWorkPackage(f.input, f.catalog)).not.toThrow();
   const out = derive(f);
   expect(out.cuts.map(c => c.pieceId)).toEqual(preceding ? ["leg", "span/after-closure", "span/before-closure"] : ["span/after-closure", "span/before-closure", "leg"]);
   expect(out.cuts.reduce((sum, c) => sum + c.centerline.value!, 0)).toBeCloseTo(3.8);
 });
 it("keeps proposed reuse on both closure halves", () => {
   const f = fixture(); f.input.pieces[0].disposition = "proposed_reuse";
   expect(derive(f).cuts.map(c => c.disposition)).toEqual(["proposed_reuse", "proposed_reuse"]);
 });
 it("rejects a collision with generated proposal evidence", () => {
   const f = fixture(); f.input.evidence.push({ id: "closure/proposal", subjectIds: ["closure"], description: "Existing evidence" });
   expect(() => derive(f)).toThrow("Closure evidence ID collides");
 });
