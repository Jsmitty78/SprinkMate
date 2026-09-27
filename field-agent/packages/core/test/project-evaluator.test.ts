import { describe, expect, it } from "vitest";
import { emptyFacts, validateRules, type Fact, type HeadFacts, type RuleContext } from "../src/index.js";
import { evaluateProject } from "../src/index.js";
import { ProjectInputError, type ProjectEvaluationRequest, type ProjectEvidence } from "../src/project-contract.js";

const projectId = "project-1";
const headId = "head-1";
const project = { id: projectId, revision: 4, asOf: "2026-09-26" };
const ref = (documentId: string) => ({ documentId, revision: "R1" });

function record(id: string, kind: ProjectEvidence["kind"], subjectIds = [headId], extra: Partial<ProjectEvidence> = {}): ProjectEvidence {
  return {
    id,
    kind,
    projectId,
    subjectIds,
    ...(kind === "photo" ? {} : { documentRevision: ref(id) }),
    ...extra,
  } as ProjectEvidence;
}

function fact<T>(value: T, evidenceIds = ["photo"]): Fact<T> {
  return { value, confirmed: true, evidenceIds, source: "fixture" };
}

function evidenceSet(): ProjectEvidence[] {
  return [
    record("photo", "photo"),
    record("install", "installation"),
    record("permit", "permit"),
    record("inspection", "inspection"),
    record("calculation", "calculation"),
  ];
}

function validHeadFacts(overrides: Record<string, unknown> = {}): HeadFacts {
  return {
    ...emptyFacts(),
    model: fact("TY3231"),
    installation: fact("installed", ["install"]),
    mounting: fact("standard"),
    orientation: fact("pendent"),
    verticalReference: fact("gravity"),
    escutcheon: fact("style_10"),
    bulbCondition: fact("intact", ["inspection"]),
    installationWrench: fact("w_type_6", ["install"]),
    threadStandard: fact("npt"),
    installationTorqueFtLb: fact(10, ["install"]),
    construction: fact("retrofit", ["permit"]),
    fieldFinish: fact("factory_only", ["inspection"]),
    leakage: fact("absent", ["inspection"]),
    corrosion: fact("absent", ["inspection"]),
    workingPressurePsi: fact(175, ["calculation"]),
    approvalBasis: fact("ul_cul", ["calculation"]),
    pressureBasis: fact("system_maximum", ["calculation"]),
    ...overrides,
  } as HeadFacts;
}

function validRequest(selectedRulePacks: string[] = ["tyco-tfp171-head"]): ProjectEvaluationRequest {
  const legacy = validHeadFacts();
  const projectFacts = {
    model: legacy.model,
    installation: legacy.installation,
    mounting: legacy.mounting,
    orientation: legacy.orientation,
    verticalReference: legacy.verticalReference,
    escutcheon: legacy.escutcheon,
    bulbCondition: legacy.bulbCondition,
    installationWrench: legacy.installationWrench,
    threadStandard: legacy.threadStandard,
    installationTorque: fact({ value: 10, unit: "ft_lb" as const }, ["install"]),
    construction: legacy.construction,
    fieldFinish: legacy.fieldFinish,
    leakage: legacy.leakage,
    corrosion: legacy.corrosion,
    workingPressure: fact({ value: 175, unit: "psi" as const }, ["calculation"]),
    approvalBasis: legacy.approvalBasis,
    pressureBasis: legacy.pressureBasis,
  };
  return {
    project,
    selectedRulePacks: selectedRulePacks as ProjectEvaluationRequest["selectedRulePacks"],
    heads: [{ id: headId, facts: projectFacts }],
    evidence: evidenceSet(),
  };
}

function resultFor(input: ProjectEvaluationRequest, ruleId: string) {
  return evaluateProject(input).rules.find(result => result.ruleId === ruleId)!;
}

function legacyContext(input: ProjectEvaluationRequest): RuleContext {
  return {
    targetId: headId,
    taskRevision: project.revision,
    observations: (input.evidence ?? [])
      .filter(item => item.projectId === projectId && item.subjectIds.includes(headId))
      .map(item => ({ id: item.id, targetId: headId, ...(item.superseded ? { superseded: true } : {}) })),
  };
}

describe("project evaluation contract", () => {
  it("executes no pack by default and has no aggregate pass field", () => {
    const result = evaluateProject({ project, selectedRulePacks: [] });
    expect(result.rules).toEqual([]);
    expect(result.basis).toBeUndefined();
    expect("status" in result).toBe(false);
    expect(result.coverage.some(entry => entry.state === "supported")).toBe(true);
    expect(result.coverage.some(entry => entry.state === "source_pending")).toBe(true);
    expect(result.coverage.some(entry => entry.state === "unimplemented")).toBe(true);
    expect(result.coverage.every(entry => entry.selected === false)).toBe(true);
  });

  it("reports the required local-change payload when that pack is selected", () => {
    const result = evaluateProject({ project, selectedRulePacks: ["sf-local-change-2025"] });
    expect(result.rules).toEqual([]);
    expect(result.missingInputs).toContain("localChange");
  });

  it("keeps broad TFP and NFPA coverage incomplete while exposing supported bounded subentries", () => {
    const input = validRequest(["tyco-tfp171-extra", "sf-supports-2025"]);
    const output = evaluateProject(input);
    for (const id of [
      "TFP171_INSTALLATION_PROCEDURE_REMAINDERS",
      "TFP171_RECESSED_FITMENT_REMAINDERS",
      "TFP171_APPROVAL_AND_TEMPERATURE_REMAINDERS",
    ]) expect(output.coverage.find(entry => entry.id === id)?.state).toBe("unimplemented");
    for (const removedId of [
      "TFP171_PHYSICAL_DAMAGE_OR_ALTERATION_V1",
      "TFP171_COMBUSTION_RESIDUE_CLEANABILITY_V1",
      "TFP171_RECESSED_CLOSURE_CEILING_CONTACT_V1",
      "TFP171_BULB_COLOR_TEMPERATURE_PAIR_V1",
    ]) expect(output.coverage.some(entry => entry.id === removedId)).toBe(false);
    expect(output.coverage.find(entry => entry.id === "TFP171_INSTALL_SEALANT_HANDTIGHTEN_SEQUENCE_V1")).toMatchObject({ state: "supported", selected: true });
    expect(output.coverage.find(entry => entry.id === "TFP171_LISTED_TEMPERATURE_APPROVAL_COMBINATION_V1")).toMatchObject({ state: "supported", selected: true });
    expect(output.coverage.find(entry => entry.id === "N06")?.state).toBe("source_pending");
    expect(output.coverage.find(entry => entry.id === "SFFD_AB415_CRACKED_CONCRETE_FASTENERS_I4_V1")).toMatchObject({ state: "supported", selected: true });
  });

  it("preserves the ten-rule legacy API while selecting six design-relevant head checks", () => {
    const input = validRequest();
    const results = evaluateProject(input).rules;
    const legacy = validateRules(validHeadFacts(), legacyContext(input));
    const selected = legacy.filter(result => [
      "TFP171_INSTALL_ORIENTATION_V2",
      "TFP171_RECESSED_ESCUTCHEON_V1",
      "TFP171_INSTALLATION_WRENCH_V1",
      "TFP171_NPT_INSTALLATION_TORQUE_V1",
      "TFP171_RETROFIT_ONLY_V1",
      "TFP171_WORKING_PRESSURE_V1",
    ].includes(result.ruleId));
    expect(legacy).toHaveLength(10);
    expect(results).toHaveLength(6);
    for (const [index, result] of results.entries()) {
      expect(result).toMatchObject(selected[index]!);
      expect(result.packId).toBe("tyco-tfp171-head");
      expect(result.subjectIds).toEqual([headId]);
      expect(result.requirementLevel).toBe("requirement");
    }
    expect(evaluateProject(input).coverage.filter(entry => entry.area === "tfp171" && entry.packId === "tyco-tfp171-head").map(entry => entry.id)).toEqual(selected.map(rule => rule.ruleId));
    expect(results.find(result => result.ruleId === "TFP171_WORKING_PRESSURE_V1")?.sourceRefs[0]).toMatchObject({
      documentId: "TFP171", revision: "August 2026", page: 8,
    });
    expect(results.find(result => result.ruleId === "TFP171_WORKING_PRESSURE_V1")?.sourceRefs[0]?.edition).toBeUndefined();
  });

  it("does not let a photo stand in for installation or inspection records", () => {
    const input = validRequest();
    const head = input.heads![0]!;
    head.facts!.installationWrench = fact("w_type_6", ["photo"]);
    head.facts!.installationTorque = fact({ value: 10, unit: "ft_lb" }, ["photo"]);
    const results = evaluateProject(input).rules;
    const wrench = results.find(result => result.ruleId === "TFP171_INSTALLATION_WRENCH_V1")!;
    const torque = results.find(result => result.ruleId === "TFP171_NPT_INSTALLATION_TORQUE_V1")!;
    expect(wrench).toMatchObject({ status: "unknown", missingInputs: ["installationWrench.evidenceKinds:installation"] });
    expect(torque).toMatchObject({ status: "unknown", missingInputs: ["installationTorque.evidenceKinds:installation"] });
    expect(results.some(result => result.ruleId === "TFP171_LEAKAGE_V1")).toBe(false);
    const legacyLeakage = validateRules(validHeadFacts({ leakage: fact("absent", ["photo"]) }), legacyContext(input)).find(result => result.ruleId === "TFP171_LEAKAGE_V1");
    expect(legacyLeakage?.status).toBe("pass");
  });

  it("keeps wrong-project, wrong-subject, and superseded evidence unresolved", () => {
    for (const alter of [
      { projectId: "another-project" },
      { subjectIds: ["another-head"] },
      { superseded: true },
    ]) {
      const input = validRequest();
      input.evidence = input.evidence!.map(item => item.id === "install" ? { ...item, ...alter } as ProjectEvidence : item);
      input.heads![0]!.facts!.installationWrench = fact("w_type_6", ["install"]);
      expect(resultFor(input, "TFP171_INSTALLATION_WRENCH_V1").status).toBe("unknown");
    }
  });

  it("rejects explicitly invalidated evidence without inferring expiry from its dates", () => {
    const invalidated = validRequest(["tyco-tfp171-head", "tyco-tfp171-extra"]);
    invalidated.evidence = invalidated.evidence!.map(item => item.id === "install" ? { ...item, invalidated: true } : item);
    invalidated.heads![0]!.manufacturerExtra = {
      installationWrenchEngagementArea: fact("wrench_flats", ["install"]),
    };
    expect(resultFor(invalidated, "TFP171_INSTALLATION_WRENCH_V1").status).toBe("unknown");
    expect(resultFor(invalidated, "TFP171_INSTALLATION_WRENCH_FLATS_V1").status).toBe("unknown");

    const oldButValid = validRequest();
    oldButValid.evidence = oldButValid.evidence!.map(item => item.id === "install" ? { ...item, capturedAt: "1999-01-01" } : item);
    expect(resultFor(oldButValid, "TFP171_INSTALLATION_WRENCH_V1").status).toBe("pass");
  });

  it("does not let model-originated head facts confirm themselves", () => {
    const input = validRequest();
    input.heads![0]!.facts!.model = { ...fact("TY3231"), source: "model" };
    const results = evaluateProject(input).rules;
    expect(results.every(result => result.status !== "pass")).toBe(true);
    expect(results.filter(result => result.applicability === "applicable").every(result => result.status === "unknown")).toBe(true);
  });

  it("rejects unknown packs, duplicate entity IDs, and invalid ISO dates", () => {
    expect(() => evaluateProject({ project, selectedRulePacks: ["not-a-pack"] })).toThrowError(ProjectInputError);
    try { evaluateProject({ project, selectedRulePacks: ["not-a-pack"] }); } catch (error) {
      expect(error).toMatchObject({ code: "unknown_pack" });
    }
    const duplicate = validRequest();
    duplicate.evidence!.push({ ...duplicate.evidence![0]!, id: headId });
    expect(() => evaluateProject(duplicate)).toThrowError(ProjectInputError);
    expect(() => evaluateProject({ project: { ...project, asOf: "2026-02-30" }, selectedRulePacks: [] })).toThrowError(ProjectInputError);
    expect(() => evaluateProject({ project: { ...project, asOf: "2026-9-26" }, selectedRulePacks: [] })).toThrowError(ProjectInputError);
  });

  it("requires document revisions on typed non-photo evidence", () => {
    const input = validRequest();
    input.evidence![1] = { id: "install", kind: "installation", projectId, subjectIds: [headId] } as ProjectEvidence;
    expect(() => evaluateProject(input)).toThrowError(ProjectInputError);
  });

  it.each([
    ["TY3231", 7, 7 * 1.3558179483314004, "N_m", "unknown"],
    ["TY3231", 14, 14 * 1.3558179483314004, "N_m", "pass"],
    ["TY3231", 7, 6.999, "ft_lb", "fail"],
    ["TY3231", 14, 14.001, "ft_lb", "fail"],
    ["TY3231", 14, 14.0000000000001, "ft_lb", "fail"],
    ["TY4231", 10, 10 * 1.3558179483314004, "N_m", "pass"],
    ["TY4231", 20, 20 * 1.3558179483314004, "N_m", "unknown"],
    ["TY4231", 10, 9.999, "ft_lb", "fail"],
    ["TY4231", 20, 20.001, "ft_lb", "fail"],
  ] as const)("compares published torque boundaries for %s (%s ft-lb)", (model, _boundary, value, unit, expected) => {
    const input = validRequest();
    input.heads![0]!.facts!.model = fact(model);
    input.heads![0]!.facts!.installationTorque = fact({ value, unit: unit as "N_m" | "ft_lb" }, ["install"]);
    const result = resultFor(input, "TFP171_NPT_INSTALLATION_TORQUE_V1");
    expect(result.status).toBe(expected);
    expect(result.quantityTrace?.[0]).toMatchObject({ input: { value, unit }, normalized: { unit: "ft_lb" } });
    if (unit === "N_m") expect(result.quantityTrace?.[0]?.comparisons).toHaveLength(2);
    if (expected === "unknown") expect(result.missingInputs).toContain("installationTorque.unitBoundaryConflict");
    if (expected === "pass") expect(result.quantityTrace?.[0]?.normalized.value).toBeCloseTo(_boundary, 10);
  });

  it.each([
    ["TY3231", 9.5, "pass"],
    ["TY3231", 9.495, "unknown"],
    ["TY3231", 19.0, "unknown"],
    ["TY4231", 13.4, "unknown"],
    ["TY4231", 26.8, "pass"],
    ["TY3231", 19.1, "fail"],
    ["TY3231", (14 + 1e-13) * 1.3558179483314004, "unknown"],
  ] as const)("retains the source's paired torque limits for %s at %s N-m", (model, value, expected) => {
    const input = validRequest();
    input.heads![0]!.facts!.model = fact(model);
    input.heads![0]!.facts!.installationTorque = fact({ value, unit: "N_m" }, ["install"]);
    const result = resultFor(input, "TFP171_NPT_INSTALLATION_TORQUE_V1");
    expect(result.status).toBe(expected);
    expect(result.quantityTrace?.[0]?.comparisons?.map(comparison => comparison.outcome)).toHaveLength(2);
    if (expected === "unknown") expect(result.reason).toContain("paired-unit limits");
  });

  it.each([
    [175, 1206.5825263044, "kPa", "pass"],
    [175, 12.1, "bar", "pass"],
    [175, 12.1, "bar", "unknown", "TY2231"],
    [175, 12.2, "bar", "fail", "TY2231"],
    [250, 17.2, "bar", "pass"],
    [250, 17.23689323292, "bar", "unknown"],
    [250, 17.3, "bar", "fail"],
    [250, 250.01, "psi", "fail"],
  ] as const)("compares the published pressure boundary %s psi from %s %s", (boundary, value, unit, expected, model: string = "TY3231") => {
    const input = validRequest();
    input.heads![0]!.facts!.model = fact(model);
    input.heads![0]!.facts!.workingPressure = fact({ value, unit: unit as "kPa" | "bar" | "psi" }, ["calculation"]);
    const result = resultFor(input, "TFP171_WORKING_PRESSURE_V1");
    expect(result.status).toBe(expected);
    expect(result.quantityTrace?.[0]?.normalized?.unit).toBe("psi");
    expect(Number.isFinite(result.quantityTrace?.[0]?.normalized?.value)).toBe(true);
    expect(result.quantityTrace?.[0]?.comparisons).toHaveLength(unit === "psi" ? 1 : 2);
    if (expected === "unknown") expect(result.missingInputs).toContain("workingPressure.unitBoundaryConflict");
  });

  it("rejects quantity dimension mismatch and non-finite numeric JSON values", () => {
    const wrongUnit = validRequest();
    wrongUnit.heads![0]!.facts!.installationTorque = fact({ value: 10, unit: "psi" } as never, ["install"]);
    expect(() => evaluateProject(wrongUnit)).toThrowError(ProjectInputError);
    const invalidNumber = validRequest();
    invalidNumber.heads![0]!.facts!.workingPressure = fact({ value: Number.NaN, unit: "psi" }, ["calculation"]);
    expect(() => evaluateProject(invalidNumber)).toThrowError(ProjectInputError);
  });
});

describe("San Francisco edition basis in project evaluation", () => {
  const projectEvidence: ProjectEvidence = {
    id: "sf-permit",
    kind: "permit",
    projectId,
    subjectIds: [projectId],
    documentRevision: { documentId: "permit-record", revision: "issued" },
  };
  const permitFact = <T>(value: T): Fact<T> => fact<T>(value, ["sf-permit"]);
  const facts = {
    sfNfpa13: {
      jurisdiction: permitFact<"san_francisco">("san_francisco"),
      standard: permitFact<"nfpa13">("nfpa13"),
      permitKind: permitFact<"new_building_site_permit">("new_building_site_permit"),
      sitePermitCodeCycle: permitFact<"2022">("2022"),
      architecturalPermitCodeCycle: permitFact<"2022">("2022"),
      editionElection: permitFact<"permit_basis">("permit_basis"),
    },
    systemType: { ...fact<"wet">("wet"), confirmed: false },
    sprinklerType: fact<"standard_spray">("standard_spray"),
    storage: fact<"non_storage">("non_storage"),
  };

  it("returns edition resolution separately, using permit evidence and source clause metadata", () => {
    const result = evaluateProject({ project, selectedRulePacks: ["sf-project-basis"], facts, evidence: [projectEvidence] });
    expect(result.rules).toEqual([]);
    expect(result.basis).toMatchObject({ status: "resolved", nfpa13Edition: "2022", targetId: projectId, taskRevision: 4 });
    expect(result.basis?.sourceRefs[0]).toMatchObject({ documentId: "SFFD AB 2.04", revision: "2025", page: 1, clauses: ["Note 1.A", "Note 1.B", "Note 1.C"] });
  });

  it("keeps absent or photo-backed permit facts unknown", () => {
    const absent = evaluateProject({ project, selectedRulePacks: ["sf-project-basis"] });
    expect(absent.basis).toMatchObject({ status: "unknown", nfpa13Edition: null });
    const photoOnly = evaluateProject({
      project,
      selectedRulePacks: ["sf-project-basis"],
      facts,
      evidence: [{ ...projectEvidence, kind: "photo", documentRevision: undefined }],
    });
    expect(photoOnly.basis).toMatchObject({ status: "unknown", nfpa13Edition: null });
    expect(photoOnly.missingInputs).toContain("sfNfpa13.evidenceKinds:permit");
  });

  it("round-trips the same JSON input deterministically for an explicit asOf date", () => {
    const input = validRequest(["tyco-tfp171-head", "sf-project-basis"]);
    input.facts = facts;
    input.evidence!.push(projectEvidence);
    const first = evaluateProject(input);
    const second = evaluateProject(JSON.parse(JSON.stringify(input)));
    expect(second).toEqual(first);
    expect(first.asOf).toBe("2026-09-26");
  });
});
