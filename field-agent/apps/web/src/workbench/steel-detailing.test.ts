import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveWorkPackage, fabricationCatalog } from "../../../../packages/fabrication/src/index.js";
import { fabricationInput } from "../../../server/src/integration/model.js";
import type { Snapshot } from "./api.js";
import { callouts, findFact, upsertFacts } from "./model.js";
import { sampleInputs } from "./sample.js";
import { PRODUCT_SETS } from "./products.js";
import { detailFactPatch, DetailingInputs, steelDetailRows } from "./inputs.js";

function fixture(): Snapshot {
  const s = { ...sampleInputs("prepare", "source"), id: "steel-ui", projectId: "test", intent: "prepare_from_drawing", inputRevision: 1, configVersion: "test", selectedPlan: null, detailing: [], siteFacts: [] } as unknown as Snapshot;
  for (const e of s.baselinePlan!.entities) e.productId = e.kind === "pipe" ? PRODUCT_SETS.steel_nps2.pipe : e.kind === "fitting" ? PRODUCT_SETS.steel_nps2.elbow : null;
  return s;
}
it("renders separate steel endpoint controls alongside a mixed catalog without CPVC joint instructions", () => {
  const s = fixture();
  s.baselinePlan!.entities.find(e => e.id === "p2")!.productId = PRODUCT_SETS.cpvc.pipe;
  const html = renderToStaticMarkup(createElement(DetailingInputs, { s, callouts: callouts(s.baselinePlan), act: async () => true, busy: "", unit: "mm", setNotice: () => {} }));
  expect(html).toContain("Steel threaded joints");
  expect(html).toContain("in: final axial engagement");
  expect(html).toContain("out: final axial engagement");
  expect(html).toContain(PRODUCT_SETS.cpvc.pipe!);
  expect(html).toContain("threaded joint preparation and assembly plan");
  expect(html).not.toContain("full insertion and quarter turn possible");
});
it("saves scoped engagement and plan product bindings, keeping synthetic evidence proposed", () => {
  const s = fixture();
  const rows = steelDetailRows(s, callouts(s.baselinePlan));
  for (const field of ["threadMakeup.in", "threadedJointPlan.in"]) {
    const row = rows.find(r => r.field === field)!;
    Object.assign(s, detailFactPatch(s, row, field.startsWith("threadMakeup") ? 12 : "Invented review", "synthetic_assumption", "Synthetic software fixture, not measured"));
    expect(findFact(s, field, "f1")).toMatchObject({ provenance: "synthetic_assumption", confirmation: "proposed", subjectIds: ["f1"] });
    expect(findFact(s, `${field}.pipeProductId`, "f1")).toMatchObject({ value: PRODUCT_SETS.steel_nps2.pipe, provenance: "synthetic_assumption", confirmation: "proposed" });
    expect(findFact(s, `${field}.fittingProductId`, "f1")?.value).toBe(PRODUCT_SETS.steel_nps2.elbow);
    Object.assign(s, detailFactPatch(s, row, 15, "confirmed_evidence", "Attempted promotion"));
    expect(findFact(s, field, "f1")?.confirmation).toBe("proposed");
  }
});
it("the saved UI payload reaches steel arithmetic and a changed catalog cannot reuse its binding", () => {
  const s = fixture();
  const source = "Automated contract test only: simulate user supplied confirmed evidence, not real field acceptance";
  Object.assign(s, upsertFacts(s, ["p1", "p2"].flatMap(id => ["start", "end"].map(end => ({ field: `datum.${end}`, subjectIds: [id], value: (id === "p1" && end === "start") || (id === "p2" && end === "end") ? "physical_pipe_end" : "center_to_center", confirmation: "confirmed" as const, provenance: "confirmed_evidence" as const, context: "detailing" as const, source })))));
  for (const row of steelDetailRows(s, callouts(s.baselinePlan)).filter(r => r.field.startsWith("threadMakeup.")))
    Object.assign(s, detailFactPatch(s, row, row.field.endsWith("in") ? 12 : 15, "confirmed_evidence", source));
  const derive = () => deriveWorkPackage(fabricationInput(s, s.baselinePlan!), fabricationCatalog(s.configVersion));
  expect(derive().cuts.map(c => c.cutLength.value)).toEqual([0.56445, 0.41505]);
  s.baselinePlan!.entities.find(e => e.id === "p1")!.productId = PRODUCT_SETS.steel_nps1.pipe;
  expect(derive().cuts.find(c => c.pieceId === "p1")!.cutLength.value).toBeNull();
});

it.each([0, -1, 57.15, 60, NaN])("keeps invalid saved engagement %s actionable while preserving the other cut", amount => {
  const s = fixture();
  const source = "Automated contract test of explicit checked evidence; not field acceptance";
  Object.assign(s, upsertFacts(s, ["p1", "p2"].flatMap(id => ["start", "end"].map(end => ({ field: `datum.${end}`, subjectIds: [id], value: (id === "p1" && end === "start") || (id === "p2" && end === "end") ? "physical_pipe_end" : "center_to_center", confirmation: "confirmed" as const, provenance: "confirmed_evidence" as const, context: "detailing" as const, source })))));
  for (const row of steelDetailRows(s, callouts(s.baselinePlan)).filter(r => r.field.startsWith("threadMakeup.")))
    Object.assign(s, detailFactPatch(s, row, row.field.endsWith("in") ? amount : 15, "confirmed_evidence", source));
  // NaN cannot pass the package API schema; this also protects internal adapter callers.
  const input = fabricationInput(s, s.baselinePlan!);
  expect(input.fittings[0].ports.find(p => p.id === "in")!.threadMakeup!.axialEngagement).toMatchObject({ value: null, status: "unknown" });
  const output = deriveWorkPackage(input, fabricationCatalog(s.configVersion));
  expect(output.cuts[0].cutLength.value).toBeNull();
  expect(output.cuts[0].cutLength.reasons.join(" ")).toContain("greater than 0 and less than 57.15 mm");
  expect(output.cuts[1].cutLength.value).toBe(0.41505);
  expect(output.cuts[0].centerline.value).toBe(0.6096);
});
