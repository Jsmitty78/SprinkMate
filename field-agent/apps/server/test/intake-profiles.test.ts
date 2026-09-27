import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { WorkPackageSnapshot } from "@field-agent/core";
import { deriveWorkPackage, fabricationCatalog, STEEL_PAIRS } from "@field-agent/fabrication";
import { fabricationInput, planningPlan } from "../src/integration/model.js";
import { evaluateProfile } from "../src/integration/profiles.js";

async function saved() {
  return JSON.parse(await readFile(new URL("./fixtures/fs01-intake-snapshot.json", import.meta.url), "utf8")) as WorkPackageSnapshot;
}
function evaluate(s: WorkPackageSnapshot, product: string | null) {
  s.baselinePlan!.entities.find(e => e.id === "p1")!.productId = product;
  const input = fabricationInput(s, s.baselinePlan!);
  const output = deriveWorkPackage(input, fabricationCatalog(s.configVersion));
  const plan = planningPlan(s, input);
  return evaluateProfile(s, input, output, plan, plan);
}
it("uses actual intake steel requirement and scoped size rather than fixture-only aliases", async () => {
  const s = await saved();
  const profile = evaluate(s, "spears/CP-010");
  expect(profile.checks.find(c => c.id === "MATERIAL-CONFLICT-p1")).toMatchObject({ status: "fail", sourceRefs: ["ui-materialRequirement.material"] });
  expect(profile.checks.find(c => c.id === "NOMINAL-SIZE-CONFLICT-p1")).toMatchObject({ status: "fail", sourceRefs: ["ui-nominalSize.p1"] });
  expect(profile.checks.find(c => c.id === "SOURCE-REQUIREMENT-p1-materialRequirement")?.reason).toContain("Schedule 40 black steel");
  expect(profile.checks.find(c => c.id === "SOURCE-REQUIREMENT-p1-nominalSize")?.reason).toContain("2 inch");
  expect(profile.project.basis).toBeUndefined();
  expect(profile.checks.some(c => /2025/.test(c.reason))).toBe(false);
});
it("keeps matching steel selection subject to product suitability and missing physical measurements", async () => {
  const s = await saved();
  const profile = evaluate(s, STEEL_PAIRS.find(p => p.size === "NPS 2")!.pipeId);
  expect(profile.checks.some(c => c.id.startsWith("MATERIAL-CONFLICT") || c.id.startsWith("NOMINAL-SIZE-CONFLICT"))).toBe(false);
  expect(profile.checks.find(c => c.id === "CUT-p1")?.status).toBe("unknown");
  expect(profile.checks.find(c => c.id === "SOURCE-REQUIREMENT-p1-materialRequirement")?.status).toBe("unknown");
  expect(profile.checks.filter(c => c.id.startsWith("PRODUCT-SUITABILITY")).every(c => c.status === "unknown")).toBe(true);
});
it("does not widen another entity's requirement or enforce an unconfirmed assumption", async () => {
  const s = await saved();
  s.detailing.find(f => f.field === "materialRequirement.material")!.subjectIds = ["h1"];
  s.detailing.find(f => f.field === "nominalSize")!.confirmation = "proposed";
  const profile = evaluate(s, "spears/CP-010");
  expect(profile.checks.some(c => c.id.startsWith("MATERIAL-CONFLICT") || c.id.startsWith("NOMINAL-SIZE-CONFLICT"))).toBe(false);
  expect(profile.checks.find(c => c.id === "SOURCE-REQUIREMENT-p1-nominalSize")?.reason).toContain("unconfirmed source input");
});
it("does not elevate synthetic confirmed flags into authoritative source conflicts", async () => {
  const s = await saved();
  for (const f of s.detailing.filter(f => ["materialRequirement.material", "nominalSize"].includes(f.field))) {
    f.provenance = "synthetic_assumption";
    f.confirmation = "confirmed"; // Old or manually submitted clients cannot bypass provenance.
  }
  const profile = evaluate(s, "spears/CP-010");
  expect(profile.checks.some(c => c.id.startsWith("MATERIAL-CONFLICT") || c.id.startsWith("NOMINAL-SIZE-CONFLICT"))).toBe(false);
  expect(profile.checks.find(c => c.id === "SOURCE-REQUIREMENT-p1-materialRequirement.material")?.reason).toContain("unconfirmed source input");
});

it.each(["spears/CP-010", "wheatland/a53-sch40-black-nps2"])("flags explicit copper requirement against %s", async product => {
  const s = await saved();
  s.detailing.find(f => f.field === "materialRequirement.material")!.value = "copper";
  const profile = evaluate(s, product);
  expect(profile.checks.find(c => c.id === "MATERIAL-CONFLICT-p1")).toMatchObject({ status: "fail", sourceRefs: ["ui-materialRequirement.material"] });
  expect(profile.project.basis).toBeUndefined();
});

it.each(['1-1/2"', '1 1/2 in', 'NPS 1-1/2', '1/2 inch', '1.5 inches'])("detects source size conflict for %s", async value => {
  const s = await saved();
  s.detailing.find(f => f.field === "nominalSize")!.value = value;
  expect(evaluate(s, "spears/CP-010").checks.find(c => c.id === "NOMINAL-SIZE-CONFLICT-p1")).toMatchObject({ status: "fail" });
});
it.each(['2/2 in', '1 0/2"', '1/0 in', 'unknown'])("does not invent a size conflict for matching or unparseable %s", async value => {
  const s = await saved();
  s.detailing.find(f => f.field === "nominalSize")!.value = value;
  expect(evaluate(s, "spears/CP-010").checks.some(c => c.id === "NOMINAL-SIZE-CONFLICT-p1")).toBe(false);
});
