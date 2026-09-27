import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateProject, type ProjectEvaluationRequest } from "../src/index.js";
import type { ProjectEvidence } from "../src/project-contract.js";

const exampleUrl = new URL("../../../docs/local-change-evaluation.example.json", import.meta.url);

function example(): ProjectEvaluationRequest {
  return JSON.parse(readFileSync(exampleUrl, "utf8")) as ProjectEvaluationRequest;
}

function report(input: ProjectEvaluationRequest) {
  const result = evaluateProject(input);
  if (!result.localChange) throw new Error("fixture did not produce a local-change report");
  return { result, report: result.localChange };
}

function datumFacts(input: ProjectEvaluationRequest) {
  const plans = [input.localChange!.baseline, input.localChange!.proposed];
  return plans.flatMap(plan => plan.segments.map(segment => [segment.cutEndDatumAtStart, segment.cutEndDatumAtEnd]));
}

describe("local-change cut-end datum gates", () => {
  it("keeps confirmed center-to-center route and BOM outputs verified", () => {
    const { result, report: output } = report(example());
    expect(output.baseline.totalCutLengthM).toBeCloseTo(4, 12);
    expect(output.proposed.totalCutLengthM).toBeCloseTo(5.76, 12);
    expect(output.delta).toMatchObject({ state: "verified", pipeCountDelta: 4, elbowCountDelta: 4, centerlineLengthDeltaM: 2 });
    expect(output.delta.cutLengthDeltaM).toBeCloseTo(1.76, 12);
    expect(result.rules.find(rule => rule.ruleId === "LOCAL_CHANGE_BOM_ACCOUNTING_V1")?.status).toBe("pass");
  });

  it("withholds cut and BOM cut comparisons for unconfirmed endpoint datums while keeping independent quantities and centerlines", () => {
    const input = example();
    for (const [index, pair] of datumFacts(input).entries()) {
      const [start, end] = pair;
      if (index === 0) start!.confirmed = false;
      if (index === 1) end!.value = null;
    }
    const { result, report: output } = report(input);
    expect(output.baseline.totalCenterlineLengthM).toBe(4);
    expect(output.proposed.totalCenterlineLengthM).toBe(6);
    expect(output.delta).toMatchObject({ state: "input_missing", pipeCountDelta: 4, elbowCountDelta: 4, centerlineLengthDeltaM: 2, cutLengthDeltaM: null });
    expect(output.proposed.totalCutLengthM).toBeNull();
    expect(output.proposed.segments[0]).toMatchObject({ centerlineLengthM: 1, cutLengthM: null, outsideDiameterM: 0.06 });
    expect(result.rules.find(rule => rule.ruleId === "SFFD_LOCAL_CHANGE_ROUTE_GEOMETRY_V1")?.status).toBe("unknown");
    const bom = result.rules.find(rule => rule.ruleId === "LOCAL_CHANGE_BOM_ACCOUNTING_V1");
    expect(bom?.status).toBe("unknown");
    expect(output.bomDeltas.find(row => row.itemId === "pipe-a")).toMatchObject({
      baselineQuantity: 0,
      proposedQuantity: 1,
      quantityDelta: 1,
      baselineCutLengthM: 0,
      proposedCutLengthM: null,
      cutLengthDeltaM: null,
      state: "input_missing",
    });
  });

  it("requires current, same-project drawing evidence scoped to each segment and plan", () => {
    for (const mode of ["wrong_subject", "stale_revision"] as const) {
      const input = example();
      const proposed = input.localChange!.proposed;
      const segment = proposed.segments[0]!;
      const evidenceId = `ev-datum-${mode}`;
      const record: ProjectEvidence = {
        id: evidenceId,
        kind: "drawing",
        projectId: input.project.id,
        subjectIds: mode === "wrong_subject" ? [proposed.id] : [proposed.id, segment.id],
        documentRevision: { documentId: "synthetic-proposed-drawing", revision: mode === "wrong_subject" ? "R2" : "R1" },
      };
      input.evidence = [...(input.evidence ?? []), record];
      segment.cutEndDatumAtStart.evidenceIds = [evidenceId];
      const { result, report: output } = report(input);
      expect(output.proposed.segments[0]).toMatchObject({ centerlineLengthM: 1, cutLengthM: null, state: "input_missing" });
      expect(output.proposed.totalCenterlineLengthM).toBe(6);
      expect(output.proposed.totalCutLengthM).toBeNull();
      expect(output.delta.cutLengthDeltaM).toBeNull();
      expect(result.rules.find(rule => rule.ruleId === "LOCAL_CHANGE_BOM_ACCOUNTING_V1")?.status).toBe("unknown");
    }
  });

  it("does not treat physical-end or mixed endpoint datums as normalized center-to-center inputs", () => {
    const input = example();
    const segment = input.localChange!.proposed.segments[0]!;
    segment.cutEndDatumAtEnd.value = "physical_pipe_end";
    const { result, report: output } = report(input);
    expect(output.proposed.segments[0]).toMatchObject({ centerlineLengthM: 1, cutLengthM: null, state: "unsupported" });
    expect(output.proposed.totalCenterlineLengthM).toBe(6);
    expect(output.proposed.totalCutLengthM).toBeNull();
    expect(output.delta.cutLengthDeltaM).toBeNull();
    expect(result.rules.find(rule => rule.ruleId === "LOCAL_CHANGE_BOM_ACCOUNTING_V1")?.status).toBe("unknown");
  });
});
