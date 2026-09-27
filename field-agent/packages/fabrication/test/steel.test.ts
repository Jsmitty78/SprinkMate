import { expect, it } from "vitest";
import { confirmed, drawingExample } from "../examples/fixtures.js";
import { deriveWorkPackage, fabricationCatalog, steelCatalog, STEEL_PAIRS, toLocalPlanGeometry, toPlanningProduct, compareWorkPackages } from "../src/index.js";

/** Invented open spool, NOT a measurement or complete construction acceptance. */
function specimen(pair = STEEL_PAIRS[0] as typeof STEEL_PAIRS[number]) {
  const input = drawingExample();
  input.sourceDrawing.approval = "unknown";
  input.pieces.forEach(p => p.productId = pair.pipeId);
  input.fittings[0].productId = pair.elbowId;
  input.fittings[0].ports.forEach((p, i) => p.threadMakeup = {
    pipeProductId: pair.pipeId, fittingProductId: pair.elbowId,
    axialEngagement: confirmed({ value: i === 0 ? 12 : 15, unit: "mm" }),
  });
  input.assemblyConditions.curePlan = { value: null, status: "unknown", reason: "Not CPVC", evidenceIds: [] };
  input.assemblyConditions.threadedJointPlan = Object.fromEntries(["f1/in", "f1/out"].map(id => [id, {
    pipeProductId: pair.pipeId, fittingProductId: pair.elbowId,
    plan: confirmed("Invented joint review"), movement: confirmed(true),
  }]));
  return input;
}
const derive = (input = specimen()) => deriveWorkPackage(input, steelCatalog(input.configVersion));

it.each([
  [STEEL_PAIRS[0], 0.56445, 0.41505, 0.060325],
  [STEEL_PAIRS[1], 0.5835, 0.4341, 0.033401],
] as const)("uses catalog data for %s with independently computed asymmetric end engagement", (pair, first, second, od) => {
  // NPS2 B=2.25in=57.15mm; cuts = 609.6-57.15+12, 457.2-57.15+15.
  // NPS1 B=1.5in=38.1mm; cuts = 609.6-38.1+12, 457.2-38.1+15.
  const input = specimen(pair), out = derive(input);
  expect(out.cuts[0].cutLength.value).toBeCloseTo(first, 10);
  expect(out.cuts[1].cutLength.value).toBeCloseTo(second, 10);
  expect(out.materials[0].quantity.value).toBe(2);
  expect(out.materials[1].quantity.value).toBe(1);
  expect(out.joints.map(j => j.id)).toEqual(["f1/in", "f1/out"]);
  expect(out.cuts[0].sourceSegmentIds).toEqual(["source-1"]);
  expect(out.operations.filter(o => o.jointIds.length).map(o => o.code)).toEqual([
    "inspect_threads", "apply_thread_sealant", "thread_joint", "inspect_threads", "apply_thread_sealant", "thread_joint",
  ]);
  expect(out.operations.some(o => /cement|plastic|quarter|cure/i.test(o.instruction))).toBe(false);
  expect(out.materials.some(m => m.kind === "consumable")).toBe(false);
  // Unknown preparation/listing suitability is not a fabricated fully executable package.
  expect(out.operations.some(o => o.status === "unsupported")).toBe(true);
  expect(toPlanningProduct(steelCatalog(input.configVersion), pair.pipeId).insertionOrThreadMakeup.value).toBeNull();
  const geometry = toLocalPlanGeometry(input, steelCatalog(input.configVersion));
  expect(geometry.fittings[0].ports[0].insertionOrThreadMakeup.value?.value).toBeCloseTo(0.012, 10);
  expect(geometry.fittings[0].ports[0].insertionOrThreadMakeup.evidenceIds).toContain("example-inputs");
  expect(toPlanningProduct(steelCatalog(input.configVersion), pair.pipeId).centerToFace.value?.value).toBeCloseTo(pair === STEEL_PAIRS[0] ? 0.05715 : 0.0381, 10);
  expect(geometry.segments[0].outsideDiameter.value!.value * 0.0254).toBeCloseTo(od, 10);
  const adaptation = derive({ ...input, intent: "adapt_to_site" });
  expect(adaptation.cuts).toEqual(out.cuts);
  expect(compareWorkPackages(out, adaptation).cutLengthDeltaM).toBe(0);
});

it("keeps known geometry when engagement is missing, foreign, proposed or bound to a previous product", () => {
  const input = specimen(), port = input.fittings[0].ports[0];
  port.threadMakeup!.axialEngagement.evidenceIds = ["foreign"];
  expect(derive(input).cuts[0].cutLength.value).toBeNull();
  expect(derive(input).cuts[1].cutLength.value).toBeCloseTo(0.41505);
  port.threadMakeup!.axialEngagement = { ...confirmed({ value: 12, unit: "mm" }), status: "proposed" };
  expect(derive(input).cuts[0].cutLength.basis).toBe("proposed_inputs");
  expect(toLocalPlanGeometry(input, steelCatalog(input.configVersion)).fittings[0].ports[0].insertionOrThreadMakeup.confirmed).toBe(false);
  port.threadMakeup!.pipeProductId = STEEL_PAIRS[1].pipeId;
  expect(derive(input).cuts[0].cutLength.value).toBeNull();
  const review = input.assemblyConditions.threadedJointPlan!["f1/out"];
  review.pipeProductId = STEEL_PAIRS[1].pipeId;
  expect(derive(input).operations.filter(o => o.jointIds.includes("f1/out")).every(o => o.status === "needs_confirmation")).toBe(true);
  delete port.threadMakeup;
  const out = derive(input);
  expect(out.cuts[0].centerline.value).toBeCloseTo(0.6096);
  expect(out.cuts[0].cutLength.reasons.join()).toContain("thread engagement");
});

it("does not silently select any catalog product or socket strategy for unknown projects/methods", () => {
  expect(toPlanningProduct(fabricationCatalog("v1")).compatibility.value).toBeNull();
  expect(toPlanningProduct(fabricationCatalog("v1"), null).compatibility.value).toBeNull();
  const input = specimen(); input.pieces.forEach(p => p.productId = "unknown-msu-product");
  expect(derive(input).cuts.every(c => c.cutLength.value === null && c.centerline.value !== null)).toBe(true);
  const catalog = steelCatalog(input.configVersion);
  input.pieces.forEach(p => p.productId = STEEL_PAIRS[0].pipeId);
  catalog.products.forEach(p => p.connection = "unsupported");
  const out = deriveWorkPackage(input, catalog);
  expect(out.cuts.every(c => c.cutLength.value === null)).toBe(true);
  expect(out.joints.every(j => j.procedureId === null)).toBe(true);
});

it("rejects impossible engagement and keeps the CPVC catalog separate", () => {
  const input = specimen();
  input.fittings[0].ports[0].threadMakeup!.axialEngagement = confirmed({ value: 57.15, unit: "mm" });
  expect(() => derive(input)).toThrow("Invalid thread engagement");
  const cpvc = drawingExample();
  const out = deriveWorkPackage(cpvc, fabricationCatalog(cpvc.configVersion));
  expect(out.cuts[0].cutLength.value).toBeCloseTo(0.5762625, 10);
  expect(out.cuts[1].cutLength.value).toBeCloseTo(0.4238625, 10);
  expect(out.operations.every(o => o.status === "planned")).toBe(true);
});
