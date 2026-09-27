import { describe, expect, it } from "vitest";
import { evaluateProject } from "../../src/project-evaluator.js";
import type { Fact } from "../../src/types.js";
import type { ProjectEvaluationRequest, ProjectEvidence } from "../../src/project-contract.js";

const projectId = "sf-project";
const supportId = "support-1";
const project = { id: projectId, revision: 7, asOf: "2026-09-26" };
const doc = (documentId: string) => ({ documentId, revision: "ISSUED-1" });
const fact = <T>(value: T, evidenceIds: string[], confirmed = true, source: Fact<T>["source"] = "fixture"): Fact<T> => ({ value, confirmed, evidenceIds, source });

function evidence(id: string, kind: ProjectEvidence["kind"], subjectIds: string[], projectRef = projectId): ProjectEvidence {
  return {
    id, kind, projectId: projectRef, subjectIds,
    ...(kind === "photo" ? {} : { documentRevision: doc(id) }),
  } as ProjectEvidence;
}

const sfPermitFacts = {
  sfNfpa13: {
    jurisdiction: fact("san_francisco" as const, ["project-permit"]),
    standard: fact("nfpa13" as const, ["project-permit"]),
    permitKind: fact("new_building_site_permit" as const, ["project-permit"]),
    sitePermitCodeCycle: fact("2025" as const, ["project-permit"]),
    architecturalPermitCodeCycle: fact("2025" as const, ["project-permit"]),
    editionElection: fact("permit_basis" as const, ["project-permit"]),
  },
  systemType: fact("wet" as const, ["project-permit"]),
  sprinklerType: fact("standard_spray" as const, ["project-permit"]),
  storage: fact("non_storage" as const, ["project-permit"]),
};

function supportRequest(supportFacts: Record<string, unknown>, projectFacts: Record<string, unknown> = sfPermitFacts): ProjectEvaluationRequest {
  return {
    project,
    selectedRulePacks: ["sf-supports-2025"],
    facts: projectFacts as ProjectEvaluationRequest["facts"],
    supports: [{ id: supportId, facts: supportFacts as ProjectEvaluationRequest["supports"] extends (infer S)[] | undefined ? S extends { facts?: infer F } ? F : never : never }],
    evidence: [
      evidence("project-permit", "permit", [projectId]),
      evidence("support-use", "drawing", [supportId]),
      evidence("support-type", "drawing", [supportId]),
      evidence("support-state", "installation", [supportId]),
      evidence("support-move", "installation", [supportId]),
      evidence("support-hold", "inspection", [supportId]),
      evidence("support-substrate", "drawing", [supportId]),
      evidence("support-qualification", "drawing", [supportId]),
    ],
  };
}

function supportRule(input: ProjectEvaluationRequest, ruleId: string) {
  return evaluateProject(input).rules.find(result => result.ruleId === ruleId)!;
}

describe("2025 SFFD AB 4.15 bounded support rules", () => {
  it("passes qualifying existing powder-driven studs and cracked-concrete fasteners", () => {
    const input = supportRequest({
      use: fact("hanger" as const, ["support-use"]),
      fastenerType: fact("powder_driven_stud" as const, ["support-type"]),
      installationState: fact("existing" as const, ["support-state"]),
      pipeMovedOrAltered: fact("no" as const, ["support-move"]),
      hangerHoldsProperly: fact("yes" as const, ["support-hold"]),
      substrate: fact("concrete" as const, ["support-substrate"]),
      crackedConcreteQualification: fact("prequalified" as const, ["support-qualification"]),
    });
    const output = evaluateProject(input);
    expect(output.rules.map(rule => rule.status)).toEqual(["pass", "pass"]);
    expect(output.rules[0]?.evidenceIds).toEqual(expect.arrayContaining(["support-use", "support-type", "support-state", "support-move", "support-hold"]));
    expect(output.rules[1]?.evidenceIds).toEqual(expect.arrayContaining(["support-use", "support-substrate", "support-qualification"]));
    expect(output.rules[1]?.sourceRefs[0]).toMatchObject({ documentId: "SFFD AB 4.15", revision: "2025", page: 1, clauses: ["I.4"] });
    expect(output.rules.every(rule => rule.sourceRefs[0]?.url === "https://sf-fire.org/media/3979")).toBe(true);
    expect(output.coverage.find(entry => entry.id === "N06")?.state).toBe("source_pending");
  });

  it("fails new studs and concrete fasteners with no cracked-concrete qualification", () => {
    const input = supportRequest({
      use: fact("sway_brace" as const, ["support-use"]),
      fastenerType: fact("powder_driven_stud" as const, ["support-type"]),
      installationState: fact("new" as const, ["support-state"]),
      substrate: fact("concrete" as const, ["support-substrate"]),
      crackedConcreteQualification: fact("neither" as const, ["support-qualification"]),
    });
    expect(supportRule(input, "SFFD_AB415_POWDER_DRIVEN_STUDS_I2_I3_V1").status).toBe("fail");
    expect(supportRule(input, "SFFD_AB415_CRACKED_CONCRETE_FASTENERS_I4_V1").status).toBe("fail");
  });

  it("keeps missing and model-originated scope/condition facts unknown", () => {
    const missingProfile = { ...sfPermitFacts, storage: undefined };
    const missing = supportRequest({ use: fact("hanger" as const, ["support-use"]) }, missingProfile);
    expect(evaluateProject(missing).rules.every(rule => rule.status === "unknown")).toBe(true);

    const modelProfile = { ...sfPermitFacts, systemType: fact("wet" as const, ["project-permit"], true, "model") };
    const model = supportRequest({ use: fact("hanger" as const, ["support-use"]) }, modelProfile);
    expect(evaluateProject(model).rules.every(rule => rule.status === "unknown")).toBe(true);

    const unknownStorageProfile = { ...sfPermitFacts, storage: fact("unknown" as const, ["project-permit"]) };
    const unknownStorage = supportRequest({ use: fact("hanger" as const, ["support-use"]) }, unknownStorageProfile);
    expect(evaluateProject(unknownStorage).rules.every(rule => rule.status === "unknown")).toBe(true);

    const missingQualification = supportRequest({
      use: fact("hanger" as const, ["support-use"]),
      substrate: fact("concrete" as const, ["support-substrate"]),
    });
    expect(supportRule(missingQualification, "SFFD_AB415_CRACKED_CONCRETE_FASTENERS_I4_V1").status).toBe("unknown");
  });

  it("returns N/A only for confirmed out-of-scope conditions", () => {
    const otherSupport = supportRequest({ use: fact("other" as const, ["support-use"]) });
    expect(evaluateProject(otherSupport).rules.every(rule => rule.status === "not_applicable")).toBe(true);

    const otherSubstrate = supportRequest({
      use: fact("hanger" as const, ["support-use"]),
      substrate: fact("other" as const, ["support-substrate"]),
    });
    expect(supportRule(otherSubstrate, "SFFD_AB415_CRACKED_CONCRETE_FASTENERS_I4_V1").status).toBe("not_applicable");

    const outOfScopeProfile = { ...sfPermitFacts, systemType: fact("dry" as const, ["project-permit"]) };
    const outOfScope = supportRequest({ use: fact("hanger" as const, ["support-use"]) }, outOfScopeProfile);
    expect(evaluateProject(outOfScope).rules.every(rule => rule.status === "not_applicable")).toBe(true);
  });

  it("does not use explicitly invalidated support evidence", () => {
    const input = supportRequest({
      use: fact("hanger" as const, ["support-use"]),
      fastenerType: fact("powder_driven_stud" as const, ["support-type"]),
      installationState: fact("new" as const, ["support-state"]),
    });
    input.evidence = input.evidence!.map(record => record.id === "support-state" ? { ...record, invalidated: true } : record);
    expect(supportRule(input, "SFFD_AB415_POWDER_DRIVEN_STUDS_I2_I3_V1").status).toBe("unknown");
  });
});
