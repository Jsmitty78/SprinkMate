import { describe, expect, it } from "vitest";
import { emptyFacts, type Fact, type HeadFacts, type RuleContext } from "../../src/types.js";
import { ProjectInputError, type ProjectEvidence } from "../../src/project-contract.js";
import { evaluateManufacturerExtraRules, type ManufacturerExtraFacts } from "../../src/project-rules/manufacturer-extra.js";

const projectId = "sf-project";
const headId = "head-1";
const rev = (documentId: string) => ({ documentId, revision: "1" });

function evidence(id: string, kind: ProjectEvidence["kind"] = "inspection", overrides: Partial<ProjectEvidence> = {}): ProjectEvidence {
  const base = { id, projectId, subjectIds: [headId], documentRevision: rev(id), ...overrides };
  return { ...base, kind } as ProjectEvidence;
}

function fact<T>(value: T, evidenceId: string): Fact<T> {
  return { value, confirmed: true, evidenceIds: [evidenceId], source: "manual" };
}

function baseFacts(overrides: Partial<HeadFacts> = {}): HeadFacts {
  const facts = emptyFacts();
  facts.model = fact("TY2231", "model-record");
  facts.installation = fact("installed", "installation-record");
  facts.mounting = fact("standard", "mounting-inspection");
  facts.threadStandard = fact("npt", "thread-record");
  return { ...facts, ...overrides };
}

function baseEvidence(): ProjectEvidence[] {
  return [
    evidence("model-record"), evidence("installation-record", "installation"),
    evidence("mounting-inspection"), evidence("thread-record"),
  ];
}

function candidateFacts(overrides: Partial<HeadFacts> = {}): HeadFacts {
  const facts = emptyFacts();
  facts.model = fact("TY2231", "candidate-drawing");
  facts.mounting = fact("standard", "candidate-drawing");
  facts.threadStandard = fact("npt", "candidate-drawing");
  return { ...facts, ...overrides };
}

function candidateEvidence(...more: ProjectEvidence[]): ProjectEvidence[] {
  return [evidence("candidate-drawing", "drawing"), ...more];
}

function evaluate(extraFacts: ManufacturerExtraFacts, options: {
  facts?: HeadFacts;
  evidence?: ProjectEvidence[];
  projectId?: string;
} = {}) {
  const records = options.evidence ?? [
    evidence("model-record"),
    evidence("installation-record", "installation"),
    evidence("mounting-inspection"),
    evidence("thread-record"),
  ];
  const context: RuleContext = {
    targetId: headId,
    taskRevision: 7,
    observations: records.map(record => ({
      id: record.id,
      targetId: record.subjectIds.includes(headId) ? headId : "other-head",
      ...(record.superseded ? { superseded: true } : {}),
    })),
  };
  return evaluateManufacturerExtraRules({
    projectId: options.projectId ?? projectId,
    facts: options.facts ?? baseFacts(),
    extraFacts,
    context,
    evidence: records,
  });
}

const rule = (results: ReturnType<typeof evaluate>, id: string) => results.find(result => result.ruleId === id)!;
const wrenchId = "TFP171_INSTALLATION_WRENCH_FLATS_V1";
const sequenceId = "TFP171_INSTALL_SEALANT_HANDTIGHTEN_SEQUENCE_V1";
const distanceId = "TFP171_RECESSED_FITTING_SURFACE_DIMENSION_V1";
const approvalId = "TFP171_LISTED_TEMPERATURE_APPROVAL_COMBINATION_V1";
const bodyFinishId = "TFP171_SPRINKLER_BODY_FINISH_TEMPERATURE_AVAILABILITY_V1";

describe("TFP171 manufacturer extra rules", () => {
  it("returns five scoped results with source-page provenance", () => {
    const results = evaluate({});
    expect(results.map(result => result.ruleId)).toEqual([wrenchId, sequenceId, distanceId, approvalId, bodyFinishId]);
    expect(results.every(result => result.packId === "tyco-tfp171-extra")).toBe(true);
    expect(rule(results, wrenchId).sourceRefs[0]?.page).toBe(5);
    expect(rule(results, sequenceId).sourceRefs[0]?.page).toBe(5);
    expect(rule(results, distanceId).sourceRefs.map(ref => ref.page)).toEqual([3, 4]);
    expect(rule(results, approvalId).sourceRefs.map(ref => ref.page)).toContain(6);
    expect(rule(results, bodyFinishId).sourceRefs[0]?.page).toBe(8);
    expect(results.every(result => result.subjectIds.length === 1 && result.subjectIds[0] === headId)).toBe(true);
  });

  it("keeps unresolved model sentinels unknown instead of treating them as outside the product sheet", () => {
    const facts = baseFacts({ model: fact("UNKNOWN", "model-record") });
    const results = evaluate({}, { facts });
    expect(results.every(result => result.status === "unknown" && result.applicability === "unknown")).toBe(true);
  });

  it("passes wrench-flat contact only from an installation record", () => {
    const results = evaluate({ installationWrenchEngagementArea: fact("wrench_flats", "installation-record") });
    expect(rule(results, wrenchId).status).toBe("pass");
    expect(rule(results, wrenchId).requirementLevel).toBe("requirement");
  });

  it("fails an independently recorded wrench location outside the flats", () => {
    const records = [
      evidence("model-record"), evidence("installation-record", "installation"),
      evidence("mounting-inspection"), evidence("thread-record"),
    ];
    const results = evaluate({ installationWrenchEngagementArea: fact("other_area", "installation-record") }, { evidence: records });
    expect(rule(results, wrenchId).status).toBe("fail");
  });

  it("keeps a photo-only or ISO 7-1 wrench-location claim unknown", () => {
    const photoRecords = [
      evidence("model-record"), evidence("installation-record", "photo"),
      evidence("mounting-inspection"), evidence("thread-record"),
    ];
    const photoResult = rule(evaluate({ installationWrenchEngagementArea: fact("wrench_flats", "installation-record") }, { evidence: photoRecords }), wrenchId);
    expect(photoResult.status).toBe("unknown");
    expect(photoResult.missingInputs).toContain("installationWrenchEngagementArea.evidenceIds.kind");

    const isoFacts = baseFacts({ threadStandard: fact("iso7_1", "thread-record") });
    const isoResult = rule(evaluate({ installationWrenchEngagementArea: fact("wrench_flats", "installation-record") }, { facts: isoFacts }), wrenchId);
    expect(isoResult.status).toBe("unknown");
    expect(isoResult.reason).toContain("application to the confirmed special ISO 7-1 connection has not been established");
  });

  it("rejects evidence from another project, subject, or a superseded record", () => {
    for (const altered of [
      evidence("installation-record", "installation", { projectId: "other-project" }),
      evidence("installation-record", "installation", { subjectIds: ["other-head"] }),
      evidence("installation-record", "installation", { superseded: true }),
    ]) {
      const records = [evidence("model-record"), altered, evidence("mounting-inspection"), evidence("thread-record")];
      const results = evaluate({ installationWrenchEngagementArea: fact("wrench_flats", "installation-record") }, { evidence: records });
      expect(rule(results, wrenchId).status).toBe("unknown");
    }
  });

  it("keeps a duplicate evidence ID ambiguous", () => {
    const records = [
      evidence("model-record"), evidence("installation-record", "installation"),
      evidence("installation-record", "inspection"), evidence("mounting-inspection"), evidence("thread-record"),
    ];
    const results = evaluate({ installationWrenchEngagementArea: fact("wrench_flats", "installation-record") }, { evidence: records });
    expect(rule(results, wrenchId).status).toBe("unknown");
  });

  it("passes standard installation sequence only when sealant and hand-tightening precede wrench-tightening", () => {
    const results = evaluate({
      pipeThreadSealantAppliedBeforeHandTightening: fact("yes", "installation-record"),
      headHandTightenedBeforeWrenchTightening: fact("yes", "installation-record"),
    });
    expect(rule(results, sequenceId).status).toBe("pass");
    expect(rule(results, sequenceId).sourceRefs[0]?.clauses).toContain("Installation: Series TY-FRB Upright and Pendent Sprinklers, Steps 2-3");
  });

  it("requires the recessed plate before hand-tightening but imposes no plate/sealant relative order", () => {
    const facts = baseFacts({ mounting: fact("recessed", "mounting-inspection") });
    const records = [evidence("model-record"), evidence("installation-record", "installation"), evidence("mounting-inspection"), evidence("thread-record")];
    const pass = evaluate({
      pipeThreadSealantAppliedBeforeHandTightening: fact("yes", "installation-record"),
      headHandTightenedBeforeWrenchTightening: fact("yes", "installation-record"),
      mountingPlateInstalledBeforeHandTightening: fact("yes", "installation-record"),
    }, { facts, evidence: records });
    expect(rule(pass, sequenceId).status).toBe("pass");

    const missingPlate = evaluate({
      pipeThreadSealantAppliedBeforeHandTightening: fact("yes", "installation-record"),
      headHandTightenedBeforeWrenchTightening: fact("yes", "installation-record"),
    }, { facts, evidence: records });
    expect(rule(missingPlate, sequenceId).status).toBe("unknown");
  });

  it.each([
    ["pipeThreadSealantAppliedBeforeHandTightening", "sealant"],
    ["headHandTightenedBeforeWrenchTightening", "hand-tightening"],
  ] as const)("fails a confirmed %s sequence violation even when other steps are missing", (field, expectedReason) => {
    const results = evaluate({ [field]: fact("no", "installation-record") } as ManufacturerExtraFacts);
    expect(rule(results, sequenceId).status).toBe("fail");
    expect(rule(results, sequenceId).reason.toLowerCase()).toContain(expectedReason);
  });

  it("keeps sequence claims unknown without installation-history evidence or for ISO connections", () => {
    const photoRecords = [evidence("model-record"), evidence("installation-record", "photo"), evidence("mounting-inspection"), evidence("thread-record")];
    const photoResult = evaluate({
      pipeThreadSealantAppliedBeforeHandTightening: fact("yes", "installation-record"),
      headHandTightenedBeforeWrenchTightening: fact("yes", "installation-record"),
    }, { evidence: photoRecords });
    expect(rule(photoResult, sequenceId).status).toBe("unknown");
    const isoFacts = baseFacts({ threadStandard: fact("iso7_1", "thread-record") });
    const isoResult = evaluate({
      pipeThreadSealantAppliedBeforeHandTightening: fact("yes", "installation-record"),
      headHandTightenedBeforeWrenchTightening: fact("yes", "installation-record"),
    }, { facts: isoFacts });
    expect(rule(isoResult, sequenceId).status).toBe("unknown");
  });

  function recessedFacts(style: "style_10" | "style_20" | "style_30" | "style_40" = "style_10"): HeadFacts {
    return baseFacts({
      mounting: fact("recessed", "mounting-inspection"),
      escutcheon: fact(style, "mounting-inspection"),
    });
  }

  it("passes the full measurement interval when it is within the TY2231 Style 10 range", () => {
    const results = evaluate({ recessedFittingFaceToMountingSurfaceInterval: fact({ lower: 0.4, upper: 0.8, unit: "in", phase: "as_built" }, "measurement") }, {
      facts: recessedFacts(),
      evidence: [evidence("model-record"), evidence("installation-record", "installation"), evidence("mounting-inspection"), evidence("thread-record"), evidence("measurement", "inspection")],
    });
    expect(rule(results, distanceId).status).toBe("pass");
    expect(rule(results, distanceId).reason).toContain("0.375-0.875 in.");
  });

  it.each([
    [{ lower: 3 / 8, upper: 0.4, unit: "in", phase: "as_built" }, "lower"],
    [{ lower: 0.87, upper: 7 / 8, unit: "in", phase: "as_built" }, "upper"],
  ] as const)("accepts a measurement interval touching the inclusive %s boundary", (interval, _edge) => {
    const results = evaluate({ recessedFittingFaceToMountingSurfaceInterval: fact(interval, "measurement") }, {
      facts: recessedFacts(),
      evidence: [evidence("model-record"), evidence("installation-record", "installation"), evidence("mounting-inspection"), evidence("thread-record"), evidence("measurement", "inspection")],
    });
    expect(rule(results, distanceId).status).toBe("pass");
  });

  it.each([
    [{ lower: 0.2, upper: 0.3, unit: "in", phase: "as_built" }, "below"],
    [{ lower: 0.9, upper: 1.0, unit: "in", phase: "as_built" }, "above"],
  ] as const)("fails when the whole measurement interval is %s the allowed range", (interval, _position) => {
    const results = evaluate({ recessedFittingFaceToMountingSurfaceInterval: fact(interval, "measurement") }, {
      facts: recessedFacts(),
      evidence: [evidence("model-record"), evidence("installation-record", "installation"), evidence("mounting-inspection"), evidence("thread-record"), evidence("measurement", "inspection")],
    });
    expect(rule(results, distanceId).status).toBe("fail");
  });

  it("keeps a measurement uncertainty interval that overlaps a limit unknown", () => {
    const results = evaluate({ recessedFittingFaceToMountingSurfaceInterval: fact({ lower: 0.37, upper: 0.39, unit: "in", phase: "as_built" }, "measurement") }, {
      facts: recessedFacts(),
      evidence: [evidence("model-record"), evidence("installation-record", "installation"), evidence("mounting-inspection"), evidence("thread-record"), evidence("measurement", "inspection")],
    });
    expect(rule(results, distanceId).status).toBe("unknown");
    expect(rule(results, distanceId).missingInputs).toContain("recessedFittingFaceToMountingSurfaceInterval");
  });

  it("keeps unsupported model/style pairs unresolved and standard installations not applicable", () => {
    const unsupported = evaluate({ recessedFittingFaceToMountingSurfaceInterval: fact({ lower: 0.4, upper: 0.8, unit: "in", phase: "as_built" }, "measurement") }, {
      facts: recessedFacts("style_30"),
      evidence: [evidence("model-record"), evidence("installation-record", "installation"), evidence("mounting-inspection"), evidence("thread-record"), evidence("measurement", "inspection")],
    });
    expect(rule(unsupported, distanceId).status).toBe("unknown");
    expect(rule(evaluate({}), distanceId).status).toBe("not_applicable");
  });

  it.each([
    { lower: -0.1, upper: 0.2, unit: "in", phase: "as_built" },
    { lower: 0.1, upper: Number.POSITIVE_INFINITY, unit: "in", phase: "as_built" },
    { lower: 0.4, upper: 0.2, unit: "in", phase: "as_built" },
    { lower: 0.4, upper: 0.5, unit: "cm", phase: "as_built" },
  ] as const)("rejects an invalid physical measurement interval: %s", interval => {
    expect(() => evaluate({ recessedFittingFaceToMountingSurfaceInterval: fact(interval as never, "measurement") }, { facts: recessedFacts() })).toThrowError(ProjectInputError);
  });

  it.each([
    [{ value: 155, unit: "F" }, "ul"],
    [{ value: 68, unit: "C" }, "ul"],
  ] as const)("accepts either exact printed member of the 155F/68C pair for an uninstalled drawing selection", (rating, agency) => {
    const results = evaluate({
      manufacturerTemperatureRating: fact(rating, "candidate-drawing"),
      manufacturerListedAgency: fact(agency, "candidate-drawing"),
    }, { facts: candidateFacts(), evidence: candidateEvidence() });
    expect(rule(results, approvalId).status).toBe("pass");
    expect(rule(results, approvalId).reason).toContain("table membership only");
    expect(rule(results, approvalId).reason).toContain("does not authenticate an installed unit");
  });

  it("uses recessed model/style rows and preserves the LPCB 007k/04 sensitivity caveat", () => {
    const ty2231Facts = candidateFacts({
      mounting: fact("recessed", "candidate-drawing"),
      escutcheon: fact("style_10", "candidate-drawing"),
    });
    const absentRating = evaluate({
      manufacturerTemperatureRating: fact({ value: 286, unit: "F" }, "candidate-drawing"),
      manufacturerListedAgency: fact("ul", "candidate-drawing"),
    }, { facts: ty2231Facts, evidence: candidateEvidence() });
    expect(rule(absentRating, approvalId).status).toBe("fail");
    expect(rule(absentRating, approvalId).reason).toContain("no row");

    const ty4231Facts = candidateFacts({
      model: fact("TY4231", "candidate-drawing"),
      mounting: fact("recessed", "candidate-drawing"),
      escutcheon: fact("style_40", "candidate-drawing"),
    });
    const lpcb = evaluate({
      manufacturerTemperatureRating: fact({ value: 175, unit: "F" }, "candidate-drawing"),
      manufacturerListedAgency: fact("lpcb_007k_04", "candidate-drawing"),
    }, { facts: ty4231Facts, evidence: candidateEvidence() });
    expect(rule(lpcb, approvalId).status).toBe("unknown");
    expect(rule(lpcb, approvalId).reason).toContain("does not rate recessed-sprinkler thermal sensitivity");
    expect(rule(lpcb, approvalId).sourceRefs.some(ref => ref.clauses?.includes("Note 4"))).toBe(true);
  });

  it("fails a selected agency absent from the exact standard model row and leaves generic LPCB unresolved", () => {
    const absentAgency = evaluate({
      manufacturerTemperatureRating: fact({ value: 200, unit: "F" }, "candidate-drawing"),
      manufacturerListedAgency: fact("fm", "candidate-drawing"),
    }, { facts: candidateFacts(), evidence: candidateEvidence() });
    expect(rule(absentAgency, approvalId).status).toBe("fail");
    expect(rule(absentAgency, approvalId).reason).toContain("does not show the selected agency fm");

    const ambiguousAgency = evaluate({
      manufacturerTemperatureRating: fact({ value: 200, unit: "F" }, "candidate-drawing"),
      manufacturerListedAgency: fact("lpcb_unspecified", "candidate-drawing"),
    }, { facts: candidateFacts(), evidence: candidateEvidence() });
    expect(rule(ambiguousAgency, approvalId).status).toBe("unknown");
  });

  it("checks Table E exceptions and requires evidence for Pure White sales hemisphere", () => {
    const tableEvidence = candidateEvidence(evidence("region-record", "permit"));
    const allowed = evaluate({
      manufacturerTemperatureRating: fact({ value: 135, unit: "F" }, "candidate-drawing"),
      sprinklerBodyFinish: fact("natural_brass", "candidate-drawing"),
    }, { facts: candidateFacts(), evidence: tableEvidence });
    expect(rule(allowed, bodyFinishId).status).toBe("pass");
    expect(rule(allowed, bodyFinishId).sourceRefs.map(ref => ref.page)).toEqual([8, 6]);

    const exception = evaluate({
      manufacturerTemperatureRating: fact({ value: 286, unit: "F" }, "candidate-drawing"),
      sprinklerBodyFinish: fact("natural_brass", "candidate-drawing"),
    }, { facts: candidateFacts({ model: fact("TY2231", "candidate-drawing") }), evidence: tableEvidence });
    expect(rule(exception, bodyFinishId).status).toBe("fail");
    expect(rule(exception, bodyFinishId).reason).toContain("Note 1 excludes Natural Brass");

    const pureWhite = evaluate({
      manufacturerTemperatureRating: fact({ value: 155, unit: "F" }, "candidate-drawing"),
      sprinklerBodyFinish: fact("pure_white_polyester", "candidate-drawing"),
    }, { facts: candidateFacts(), evidence: candidateEvidence() });
    expect(rule(pureWhite, bodyFinishId).status).toBe("unknown");
    expect(rule(pureWhite, bodyFinishId).missingInputs).toContain("sprinklerSalesHemisphere");

    const eastern = evaluate({
      manufacturerTemperatureRating: fact({ value: 155, unit: "F" }, "candidate-drawing"),
      sprinklerBodyFinish: fact("pure_white_polyester", "candidate-drawing"),
      sprinklerSalesHemisphere: fact("eastern", "region-record"),
    }, { facts: candidateFacts(), evidence: tableEvidence });
    expect(rule(eastern, bodyFinishId).status).toBe("pass");
    const outsideRegion = evaluate({
      manufacturerTemperatureRating: fact({ value: 155, unit: "F" }, "candidate-drawing"),
      sprinklerBodyFinish: fact("pure_white_polyester", "candidate-drawing"),
      sprinklerSalesHemisphere: fact("other", "region-record"),
    }, { facts: candidateFacts(), evidence: tableEvidence });
    expect(rule(outsideRegion, bodyFinishId).status).toBe("fail");
  });

  it.each([
    ["TY3131", 135, "natural_brass"],
    ["TY3231", 200, "pure_white_polyester"],
    ["TY3131", 175, "signal_white_polyester"],
    ["TY3231", 135, "chrome_plated"],
  ] as const)("fails the Table E exception for %s, %dF, %s", (model, degrees, finish) => {
    const facts = candidateFacts({ model: fact(model, "candidate-drawing") });
    const result = rule(evaluate({
      manufacturerTemperatureRating: fact({ value: degrees, unit: "F" }, "candidate-drawing"),
      sprinklerBodyFinish: fact(finish, "candidate-drawing"),
    }, { facts, evidence: candidateEvidence() }), bodyFinishId);
    expect(result.status).toBe("fail");
    expect(result.sourceRefs.some(ref => ref.page === 8)).toBe(true);
  });

  it("requires drawing evidence for candidate table selection and never treats installation evidence as a design schedule", () => {
    const facts = candidateFacts({
      model: fact("TY2231", "model-record"),
      mounting: fact("standard", "mounting-inspection"),
    });
    const results = evaluate({
      manufacturerTemperatureRating: fact({ value: 155, unit: "F" }, "rating-label"),
      manufacturerListedAgency: fact("ul", "agency-label"),
    }, { facts, evidence: baseEvidence().concat([evidence("rating-label"), evidence("agency-label")]) });
    expect(rule(results, approvalId).status).toBe("unknown");
    expect(rule(results, approvalId).missingInputs).toContain("model.evidenceIds.kind");
  });

  it("checks a planned recessed dimension from drawing evidence without treating it as as-built", () => {
    const facts = candidateFacts({
      model: fact("TY2231", "candidate-drawing"),
      mounting: fact("recessed", "candidate-drawing"),
      escutcheon: fact("style_10", "candidate-drawing"),
      threadStandard: fact("npt", "candidate-drawing"),
    });
    const results = evaluate({ recessedFittingFaceToMountingSurfaceInterval: fact({ lower: 0.4, upper: 0.8, unit: "in", phase: "planned" }, "candidate-drawing") }, {
      facts,
      evidence: candidateEvidence(),
    });
    expect(rule(results, distanceId).status).toBe("pass");
    expect(rule(results, distanceId).reason).toContain("planned drawing dimension");
  });

});
