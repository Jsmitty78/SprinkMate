import { getLocale, setLocale } from "../locale.js";
import { beforeEach, afterEach, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Snapshot } from "../api.js";
import { FactRow } from "../inputs.js";
import { upsertFacts } from "../model.js";
import { PRODUCT_SETS, applyRunProducts } from "../products.js";
import { intakeTracePatch, sourceRequirementsPatch, SourceRequirements } from "./IntakeInputs.js";
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
    expect(patch.detailing.find(f => f.field === "nominalSize")).toMatchObject({ value: values.size, provenance: "synthetic_assumption", confirmation: "proposed", source: nominal.source });
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

function independentRequirements(nominalSynthetic: boolean) {
  const { s } = fixture();
  const nominal = s.detailing.find(f => f.field === "nominalSize")!;
  nominal.provenance = nominalSynthetic ? "synthetic_assumption" : "confirmed_evidence";
  nominal.confirmation = nominalSynthetic ? "proposed" : "confirmed";
  const provenance = nominalSynthetic ? "confirmed_evidence" as const : "synthetic_assumption" as const;
  Object.assign(s, upsertFacts(s, [
    ...["materialRequirement", "materialRequirement.material"].map((field, i) => ({ field, value: ["Schedule 40 steel", "steel"][i], confirmation: provenance === "confirmed_evidence" ? "confirmed" as const : "proposed" as const, provenance, context: "detailing" as const, source: "Read by you from FS02 notes", assetId: "source", page: 2 })),
  ]));
  return s;
}
it.each([true, false])("saving unrelated requirements preserves independent provenance (synthetic nominal=%s)", nominalSynthetic => {
  const s = independentRequirements(nominalSynthetic);
  const before = structuredClone(s);
  const values = { size: "2 inch", text: "Schedule 40 steel", mat: "steel", nominalProvenance: nominalSynthetic ? "synthetic_assumption" as const : "confirmed_evidence" as const, provenance: nominalSynthetic ? "confirmed_evidence" as const : "synthetic_assumption" as const, materialProvenance: nominalSynthetic ? "confirmed_evidence" as const : "synthetic_assumption" as const, source: "Read by you from FS02 notes", page: 2 };
  const patch = sourceRequirementsPatch(s, values);
  expect(patch).toEqual({ detailing: before.detailing, siteFacts: before.siteFacts });
  const edited = sourceRequirementsPatch(s, { ...values, size: "1-1/2 inch" });
  for (const field of ["materialRequirement", "materialRequirement.material"]) expect(edited.detailing.find(f => f.field === field && !f.subjectIds.length)).toEqual(before.detailing.find(f => f.field === field && !f.subjectIds.length));
  expect(edited.detailing.find(f => f.field === "nominalSize")?.provenance).toBe(values.nominalProvenance);
  const reloaded = JSON.parse(JSON.stringify({ ...s, ...edited })) as Snapshot;
  expect(sourceRequirementsPatch(reloaded, { ...values, size: "1-1/2 inch" })).toEqual(edited);
});
it("locks only each synthetic field and displays independent provenance controls", () => {
  const s = independentRequirements(true);
  const html = renderToStaticMarkup(createElement(SourceRequirements, { s, act: async () => true, busy: "", unit: "mm", setNotice: () => {}, intake: { sheet: { pages: 2 } } as never, showSheet: () => {}, nominal: s.detailing.find(f => f.field === "nominalSize"), requirement: s.detailing.find(f => f.field === "materialRequirement" && !f.subjectIds.length), material: s.detailing.find(f => f.field === "materialRequirement.material" && !f.subjectIds.length) }));
  const nominalControl = html.split('Nominal size provenance')[1].split('</select>')[0];
  const materialControl = html.split('Material provenance')[1].split('</select>')[0];
  const textControl = html.split('Requirement text provenance')[1].split('</select>')[0];
  expect(nominalControl).toContain('disabled=""');
  expect(nominalControl).toContain('value="synthetic_assumption" selected=""');
  for (const control of [materialControl, textControl]) {
    expect(control).not.toContain('disabled=""');
    expect(control).toContain('value="confirmed_evidence" selected=""');
  }
});
it("editing requirement text or its source does not rewrite independent nominal evidence", () => {
  const s = independentRequirements(true), nominal = s.detailing.find(f => f.field === "nominalSize");
  const edited = sourceRequirementsPatch(s, { size: "2 inch", text: "Revised material note", mat: "steel", provenance: "confirmed_evidence", nominalProvenance: "synthetic_assumption", materialProvenance: "confirmed_evidence", source: "Read by you from corrected FS02 notes", page: 2, updateSource: true });
  expect(edited.detailing.find(f => f.field === "nominalSize")).toEqual(nominal);
  expect(edited.detailing.find(f => f.field === "materialRequirement")?.source.description).toBe("Read by you from corrected FS02 notes");
});

it.each([false, true])("preserves mixed per-span nominal evidence across unrelated saves and edits (reversed=%s)", reversed => {
  const s = independentRequirements(false);
  const first = s.detailing.find(f => f.field === "nominalSize")!;
  const second = { ...structuredClone(first), id: "nominal-second", subjectIds: ["p2"], value: "3 inch", provenance: "synthetic_assumption" as const, confirmation: "proposed" as const, source: { ...first.source, description: "Synthetic second span", assetId: "supplement", page: 1 } };
  s.detailing.push(second);
  s.baselinePlan!.entities.push({ ...structuredClone(s.baselinePlan!.entities.find(e => e.id === "p1")!), id: "p2" });
  s.scope!.includedEntityIds = reversed ? ["p2", "p1"] : ["p1", "p2"];
  const shown = reversed ? second : first;
  const values = { size: String(shown.value), nominalProvenance: shown.provenance, text: "Updated requirement", mat: "steel", provenance: "synthetic_assumption" as const, materialProvenance: "synthetic_assumption" as const, source: "Notes", page: 2 };
  const unchanged = sourceRequirementsPatch(s, values);
  expect(unchanged.detailing.filter(f => f.field === "nominalSize")).toEqual([first, second]);
  const edited = sourceRequirementsPatch(s, { ...values, size: "4 inch" });
  for (const original of [first, second]) {
    expect(edited.detailing.find(f => f.field === "nominalSize" && f.subjectIds.includes(original.subjectIds[0]))).toMatchObject({ value: "4 inch", provenance: original.provenance, confirmation: original.confirmation, source: original.source });
  }
  const reloaded = JSON.parse(JSON.stringify({ ...s, ...edited })) as Snapshot;
  expect(sourceRequirementsPatch(reloaded, { ...values, size: "4 inch" })).toEqual(edited);
  const html = renderToStaticMarkup(createElement(SourceRequirements, { s, act: async () => true, busy: "", unit: "mm", setNotice: () => {}, intake: { sheet: { pages: 2 } } as never, showSheet: () => {}, nominal: shown, requirement: s.detailing.find(f => f.field === "materialRequirement"), material: s.detailing.find(f => f.field === "materialRequirement.material" && !f.subjectIds.length) }));
  const control = html.split('Nominal size provenance')[1].split('</select>')[0];
  expect(control).toContain('disabled=""');
  expect(control).toContain('value="mixed" selected=""');
  expect(html).toContain('Sizes vary by span.');
});

it.each([false, true])("preserves different span sizes when only provenance changes (reversed=%s)", reversed => {
  const s = independentRequirements(false);
  const first = s.detailing.find(f => f.field === "nominalSize")!;
  first.provenance = "user_entered";
  first.confirmation = "proposed";
  const second = { ...structuredClone(first), id: "nominal-second", subjectIds: ["p2"], value: "3 inch", source: { ...first.source, assetId: "supplement", page: 1 } };
  s.detailing.push(second);
  s.baselinePlan!.entities.push({ ...structuredClone(s.baselinePlan!.entities.find(e => e.id === "p1")!), id: "p2" });
  s.scope!.includedEntityIds = reversed ? ["p2", "p1"] : ["p1", "p2"];
  const values = { size: String((reversed ? second : first).value), text: "Schedule 40 steel", mat: "steel", provenance: "synthetic_assumption" as const, source: "Notes", page: 2 };
  for (const provenance of ["confirmed_evidence", "user_entered"] as const) {
    Object.assign(s, sourceRequirementsPatch(s, { ...values, nominalProvenance: provenance }));
    for (const original of [first, second]) {
      expect(s.detailing.find(f => f.field === "nominalSize" && f.subjectIds.includes(original.subjectIds[0]))).toMatchObject({
        value: original.value, source: original.source, provenance,
        confirmation: provenance === "confirmed_evidence" ? "confirmed" : "proposed",
      });
    }
  }
});

it("retains nominal evidence for subjects outside the edited scope", () => {
  const s = independentRequirements(true);
  const nominal = s.detailing.find(f => f.field === "nominalSize")!;
  nominal.subjectIds.push("outside-scope");
  nominal.id = "ui-nominalSize.p1";
  nominal.source.assetId = "supplement";
  const patch = sourceRequirementsPatch(s, { size: "4 inch", text: "Schedule 40 steel", mat: "steel", provenance: "confirmed_evidence", source: "Notes", page: 2 });
  expect(patch.detailing.find(f => f.field === "nominalSize" && f.subjectIds.includes("outside-scope"))).toEqual({ ...nominal, subjectIds: ["outside-scope"] });
  expect(patch.detailing.find(f => f.field === "nominalSize" && f.subjectIds.includes("p1"))).toMatchObject({ value: "4 inch", provenance: "synthetic_assumption", source: nominal.source });
  const ids = [...patch.detailing, ...patch.siteFacts].map(f => f.id);
  expect(new Set(ids).size).toBe(ids.length);
});

const initialLocale = getLocale();
beforeEach(() => setLocale("en"));
afterEach(() => setLocale(initialLocale));
