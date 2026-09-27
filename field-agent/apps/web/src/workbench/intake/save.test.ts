import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Snapshot } from "../api.js";
import { FactRow } from "../inputs.js";
import { upsertFacts } from "../model.js";
import { PRODUCT_SETS, applyRunProducts } from "../products.js";
import { intakeTracePatch, sourceRequirementsPatch } from "./IntakeInputs.js";
import { buildTracePlan } from "./sheet.js";

function fixture() {
  const trace = { nodes: [{ kind: "open_end" as const, at: { x: 0, y: 0 }, head: false, label: "" }, { kind: "open_end" as const, at: { x: 100, y: 0 }, head: false, label: "" }], pipeLabels: ["P27"], context: [] };
  const built = buildTracePlan(trace, { scale: 1, origin: { x: 0, y: 0 }, rotationDeg: 0 }, PRODUCT_SETS.steel_nps2);
  if ("problems" in built) throw new Error(built.problems.join());
  const facts = upsertFacts({ detailing: [], siteFacts: [] }, [
    ...["requiredPipeSpecification", "requiredConnectionMethod", "materialRequirement.material", "nominalSize"].map((field, i) => ({ field, value: ["Schedule 40", "steel_threaded", "steel", "2 inch"][i], subjectIds: ["p1"], confirmation: "confirmed" as const, provenance: "confirmed_evidence" as const, context: "detailing" as const, source: "Source drawing", assetId: "source", page: 2 })),
    { field: "clearance", value: 10, unit: "mm", subjectIds: ["p1"], confirmation: "proposed", provenance: "synthetic_assumption", context: "detailing", source: "Synthetic geometry" },
  ]);
  const s = { ...facts, baselinePlan: built.plan, scope: built.scope, sourceDrawing: { drawingId: "FS01", assetId: "source", page: 1 } } as Snapshot;
  return { s, built };
}
it("preserves scoped source requirements, nominal provenance and site assumptions on product-only saves", () => {
  const { s, built } = fixture();
  const patch = intakeTracePatch(s, { ...built, plan: applyRunProducts(built.plan, built.scope.includedEntityIds, PRODUCT_SETS.cpvc) });
  for (const fact of s.detailing) expect(patch.detailing).toContainEqual(fact);
  expect(patch).not.toHaveProperty("changeRequest");
  expect(patch.detailing?.find(f => f.field === "sourceLabel")).toMatchObject({ value: "P27", provenance: "confirmed_evidence", source: { page: 1, assetId: "source" } });
});
it.each(["confirmed_evidence", "synthetic_assumption"] as const)("retains %s nominal provenance when geometry is rebuilt", provenance => {
  const { s, built } = fixture();
  const nominal = s.detailing.find(f => f.field === "nominalSize")!;
  nominal.provenance = provenance;
  nominal.confirmation = provenance === "synthetic_assumption" ? "proposed" : "confirmed";
  const changed = structuredClone(built);
  changed.plan.entities[0].ports[0].position!.x += 10;
  const patch = intakeTracePatch(s, changed);
  expect(patch.detailing?.find(f => f.field === "nominalSize")).toMatchObject({ provenance, confirmation: nominal.confirmation, source: nominal.source });
  expect(patch.detailing?.some(f => f.field === "clearance")).toBe(false);
  expect(patch.changeRequest).toBeNull();
});
it.each([['yd', 'Unknown'], ['mm', '3 mm']] as const)("renders confirmed numeric unit %s truthfully", (unit, expected) => {
  const { s } = fixture();
  Object.assign(s, upsertFacts(s, [{ field: "length", value: 3, unit, confirmation: "confirmed", context: "detailing", provenance: "confirmed_evidence", source: "Imported record" }]));
  const html = renderToStaticMarkup(createElement(FactRow, { s, act: async () => true, busy: "", unit: "mm", setNotice: () => {}, spec: { field: "length", label: "Length", kind: { type: "length" } } }));
  expect(html).toContain(expected);
  if (unit === "yd") expect(html).not.toContain('0 mm');
});


it.each(["synthetic_assumption", "legacy_synthetic"])("requirements saving cannot promote an existing %s nominal size", kind => {
  const { s } = fixture();
  const nominal = s.detailing.find(f => f.field === "nominalSize")!;
  nominal.provenance = kind === "legacy_synthetic" ? undefined : "synthetic_assumption";
  nominal.confirmation = "proposed";
  nominal.source.description = "SYNTHETIC test size";
  const values = { size: "1-1/2 inch", text: "Updated notes", mat: "steel", provenance: "confirmed_evidence" as const, source: "Drawing notes", page: 2 };
  const first = sourceRequirementsPatch(s, values);
  const reloaded = JSON.parse(JSON.stringify({ ...s, ...first })) as Snapshot;
  const second = sourceRequirementsPatch(reloaded, values);
  for (const patch of [first, second]) {
    expect(patch.detailing.find(f => f.field === "nominalSize")).toMatchObject({ value: values.size, provenance: "synthetic_assumption", confirmation: "proposed", source: { assetId: "source", page: 1 } });
  }
});
it.each(["synthetic_assumption", "user_entered", "machine_proposal", "confirmed_evidence"] as const)("requirements saving applies selected %s provenance to a new nominal size", provenance => {
  const { s } = fixture();
  s.detailing = s.detailing.filter(f => f.field !== "nominalSize");
  const patch = sourceRequirementsPatch(s, { size: "2 inch", text: "Notes", mat: "steel", provenance, source: "Drawing notes", page: 2 });
  expect(patch.detailing.find(f => f.field === "nominalSize")).toMatchObject({ provenance, confirmation: provenance === "confirmed_evidence" ? "confirmed" : "proposed", source: { page: 1 } });
  expect(patch.detailing.find(f => f.field === "materialRequirement")).toMatchObject({ provenance, source: { page: 2 } });
  expect(patch.detailing).toContainEqual(s.detailing.find(f => f.field === "requiredPipeSpecification"));
});
