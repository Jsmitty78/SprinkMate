import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { WorkPackageSnapshot } from "@field-agent/core";
import { deriveWorkPackage, fabricationCatalog, STEEL_PAIRS } from "@field-agent/fabrication";
import { fabricationInput, planningPlan } from "../src/integration/model.js";
import { deriveFabricationProfile } from "../src/integration/profiles.js";

async function saved() {
  return JSON.parse(await readFile(new URL("./fixtures/fs01-intake-snapshot.json", import.meta.url), "utf8")) as WorkPackageSnapshot;
}
function evaluate(s: WorkPackageSnapshot, product: string | null) {
  s.baselinePlan!.entities.find(e => e.id === "p1")!.productId = product;
  const input = fabricationInput(s, s.baselinePlan!);
  const output = deriveWorkPackage(input, fabricationCatalog(s.configVersion));
  const plan = planningPlan(s, input);
  return deriveFabricationProfile(s, input, output, plan, plan);
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

it.each([true, false, 2, 0])("retains non-text source requirement %s as an actionable unknown without crashing", async value => {
  const s = await saved();
  const fields = ["requiredConnectionMethod", "requiredPipeSpecification", "materialRequirement", "materialRequirement.material", "nominalSize"];
  const template = s.detailing.find(f => f.field === "materialRequirement")!;
  s.detailing = s.detailing.filter(f => !fields.includes(f.field));
  s.detailing.push(...fields.map(field => ({ ...template, id: `malformed-${field}`, field, value, unit: typeof value === "number" ? "mm" : null, subjectIds: ["p1"] })));
  const profile = evaluate(s, STEEL_PAIRS[0].pipeId);
  expect(profile.checks.some(c => c.id.startsWith("MATERIAL-CONFLICT") || c.id.startsWith("NOMINAL-SIZE-CONFLICT"))).toBe(false);
  for (const field of fields) {
    expect(profile.checks.find(c => c.id === `SOURCE-REQUIREMENT-p1-${field}`)).toMatchObject({
      status: "unknown", state: "invalid_input", sourceRefs: [`malformed-${field}`],
    });
    expect(profile.checks.find(c => c.id === `SOURCE-REQUIREMENT-p1-${field}`)?.reason).toContain(String(value));
  }
});

it("uses only scoped confirmed head observations, leaving another head unknown", async () => {
  const { evaluateProfile } = await import("../src/integration/profiles.js");
  const s = await saved();
  s.scope!.excludedEntityIds = [];
  s.scope!.includedEntityIds.push("h1", "h2");
  const template = s.detailing[0];
  const observations = {model:"TY3231",installation:"installed",mounting:"standard",orientation:"sideways",verticalReference:"gravity"};
  s.detailing.push(...Object.entries(observations).map(([field,value]) => ({...template,id:`observed-${field}`,field,value,subjectIds:["h1"],provenance:"confirmed_evidence" as const,confirmation:"confirmed" as const,unit:null,source:{description:"Independent observed head record",assetId:null,page:null}})));
  const input = fabricationInput(s,s.baselinePlan!), output = deriveWorkPackage(input,fabricationCatalog(s.configVersion)), plan = planningPlan(s,input);
  const profile = evaluateProfile(s,input,output,plan,plan,"TFP171_INSTALL_ORIENTATION_V2");
  expect(profile.project.rules.find(r=>r.subjectIds.includes("h1"))?.status).toBe("fail");
  expect(profile.project.rules.find(r=>r.subjectIds.includes("h2"))?.status).toBe("unknown");
  expect(profile.checks.filter(c=>c.id.startsWith("TFP171_INSTALL_ORIENTATION_V2")).map(c=>c.id)).toEqual(expect.arrayContaining(["TFP171_INSTALL_ORIENTATION_V2-h1","TFP171_INSTALL_ORIENTATION_V2-h2"]));
  s.detailing.find(f=>f.id === "observed-model")!.provenance = "synthetic_assumption";
  expect(evaluateProfile(s,fabricationInput(s,s.baselinePlan!),output,plan,plan,"TFP171_INSTALL_ORIENTATION_V2").project.rules.find(r=>r.subjectIds.includes("h1"))?.status).toBe("unknown");
});

it("publishes selected basis uncertainty, missing inputs and sources in UI and PDF findings without implicitly evaluating it for other rules", async () => {
  const facts = {jurisdiction:"san_francisco",standard:"nfpa13",permitKind:"revision",originalNfpa13Edition:"2022",originalFirePermitNumber:"F-123"};
  const { evaluateProfile } = await import("../src/integration/profiles.js");
  const s = await saved();
  const fields = ["jurisdiction","standard","permitKind","originalNfpa13Edition","originalFirePermitNumber"];
  const template = s.detailing[0];
  s.detailing = s.detailing.filter(f => !fields.includes(f.field));
  s.siteFacts = s.siteFacts.filter(f => !fields.includes(f.field));
  s.detailing.push(...Object.entries(facts).map(([field,value]) => ({...template,id:`basis-${field}`,field,value,subjectIds:[],unit:null,provenance:"confirmed_evidence" as const,confirmation:"confirmed" as const,source:{description:"Independent original permit record",assetId:null,page:null}})));
  const input = fabricationInput(s,s.baselinePlan!), output = deriveWorkPackage(input,fabricationCatalog(s.configVersion)), plan = planningPlan(s,input);
  const selected = evaluateProfile(s,input,output,plan,plan,"N01_SF_EDITION_BASIS");
  const check = selected.checks.find(c=>c.id === "N01_SF_EDITION_BASIS")!;
  expect(check.status).toBe("unknown");
  expect(check.reason).toContain("sfNfpa13.evidenceKinds:permit");
  expect(check.subjectIds).toEqual([s.projectId]);
  expect(check.reason).toContain(selected.project.basis!.reason);
  expect(check.sourceRefs).toEqual(selected.project.basis!.sourceRefs.map(r=>r.url));
  expect(check.sourceRefs.length).toBeGreaterThan(0);
  for (const missing of selected.project.basis!.missingInputs) expect(check.reason).toContain(missing);
  expect(selected.required).toContainEqual({id:check.id,subjectIds:check.subjectIds});
  const { exportSnapshot } = await import("../src/integration/snapshot.js");
  const snapshot = exportSnapshot(s,{inputRevision:s.inputRevision,configVersion:s.configVersion,refs:[],details:[{id:"basis-check",input,fabrication:output,plan,profile:selected}]})!;
  expect(snapshot.findings.find(f=>f.id === check.id)).toMatchObject({status:"unknown",description:expect.stringContaining(check.reason),sourceIds:check.sourceRefs});
  const other = evaluateProfile(s,input,output,plan,plan,"TFP171_INSTALL_ORIENTATION_V2");
  expect(other.project.basis).toBeUndefined();
  expect(other.checks.some(c=>c.id === "N01_SF_EDITION_BASIS")).toBe(false);
});
