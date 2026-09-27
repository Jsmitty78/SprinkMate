import { describe, expect, it } from "vitest";
import type { Fact } from "../../src/types.js";
import type { DocumentRevisionRef, ProjectEvidence, ProjectRuleResult } from "../../src/project-contract.js";
import type { ProjectLocalChangeInput } from "../../src/local-change-contract.js";
import { evaluateSfLocalChangeRecords } from "../../src/project-rules/sf-local-change-records.js";

const projectId = "sf-project";
const changeId = "change-1";
const requestId = "request-1";
const headId = "head-1";
const segmentId = "pipe-1";
const proposedRevision: DocumentRevisionRef = { documentId: "proposed-drawing", revision: "3" };

function fact<const T>(value: T, evidenceId: string): Fact<T> {
  return { value, confirmed: true, evidenceIds: [evidenceId], source: "manual" };
}

function record(
  id: string,
  kind: ProjectEvidence["kind"],
  subjectIds: string[],
  documentRevision: DocumentRevisionRef = proposedRevision,
  overrides: Partial<ProjectEvidence> = {},
): ProjectEvidence {
  return { id, kind, projectId, subjectIds, documentRevision, ...overrides } as ProjectEvidence;
}

function input(overrides: {
  proposedReuse?: Fact<"yes" | "no">;
  removedFromFitting?: Fact<"yes" | "no">;
  wasWelded?: Fact<"yes" | "no">;
  threadStandard?: Fact<"npt" | "iso7_1" | "other">;
  plannedExcessPipeSegmentIds?: Fact<string[]>;
  fieldExcessPipeRemovalStatus?: Fact<"removed" | "not_removed">;
  systemWorkType?: Fact<"new_system" | "existing_system_modification">;
  existingSystem?: Fact<"yes" | "no">;
  addsSprinklersOrPiping?: Fact<"yes" | "no">;
  existingConfigurationAndRiserIncluded?: Fact<"yes" | "no">;
  drawingRevision?: DocumentRevisionRef;
  includeHead?: boolean;
  includeSegment?: boolean;
} = {}): ProjectLocalChangeInput {
  return {
    id: changeId,
    approvedDrawing: { document: fact({ documentId: "approved-drawing", revision: "2" }, "approved-drawing"), approval: fact("approved", "approved-drawing") },
    changeRequest: {
      id: requestId,
      description: fact("local change", "change-scope"),
      affectedEntityIds: fact([headId, segmentId], "change-scope"),
      impactNeighborhood: fact({ roomIds: [], headIds: [headId], supportIds: [], ductIds: [], segmentIds: [segmentId] }, "change-scope"),
      changeClassification: fact("relocation_or_reroute", "change-scope"),
      systemWorkType: overrides.systemWorkType,
      existingSystem: overrides.existingSystem,
      addsSprinklersOrPiping: overrides.addsSprinklersOrPiping,
      existingConfigurationAndRiserIncluded: overrides.existingConfigurationAndRiserIncluded,
      remoteAreaChanged: fact("no", "change-scope"),
      hazardBecameMoreDemanding: fact("no", "change-scope"),
      waterSupplyRoutingOrBackflowChanged: fact("no", "change-scope"),
      headRemovalActions: (overrides.proposedReuse || overrides.removedFromFitting || overrides.wasWelded) ? [{
        headId,
        proposedReuse: overrides.proposedReuse,
        removedFromFitting: overrides.removedFromFitting,
        wasWelded: overrides.wasWelded,
      }] : [],
      plannedExcessPipeSegmentIds: overrides.plannedExcessPipeSegmentIds,
      fieldExcessPipeRemovalStatus: overrides.fieldExcessPipeRemovalStatus,
    },
    baseline: {
      id: "baseline",
      sourceDrawing: fact({ documentId: "approved-drawing", revision: "2" }, "approved-drawing"),
      rooms: [], segments: overrides.includeSegment === false ? [] : [{ id: segmentId }], fittings: [], ducts: [], heads: [], supports: [],
    },
    proposed: {
      id: "proposed",
      sourceDrawing: fact(overrides.drawingRevision ?? proposedRevision, "current-drawing"),
      rooms: [],
      segments: overrides.includeSegment === false ? [] : [],
      fittings: [], ducts: [],
      heads: overrides.includeHead === false ? [] : [{ headId, roomId: "room-1", ceilingId: "ceiling-1", position: fact({ x: 0, y: 0, z: 3, unit: "m" }, "current-drawing"), threadStandard: overrides.threadStandard }],
      supports: [],
    },
  } as unknown as ProjectLocalChangeInput;
}

function evaluate(value: ProjectLocalChangeInput, extraEvidence: ProjectEvidence[] = []): ProjectRuleResult[] {
  const drawing = record("current-drawing", "drawing", [projectId, changeId, "proposed", requestId, headId, segmentId], value.proposed.sourceDrawing.value as DocumentRevisionRef);
  const approved = record("approved-drawing", "drawing", [projectId, changeId, requestId], { documentId: "approved-drawing", revision: "2" });
  return evaluateSfLocalChangeRecords({
    input: value,
    projectId,
    taskRevision: 4,
    evidence: [drawing, approved, ...extraEvidence],
  });
}

function rule(results: ProjectRuleResult[], suffix: "I14D" | "I14A" | "I15"): ProjectRuleResult[] {
  const id = suffix === "I14D" ? "SFFD_AB204_NO_REINSTALL_REMOVED_OR_WELDED_SPRINKLER_I14D_V1"
    : suffix === "I14A" ? "SFFD_AB204_REMOVE_UNUSED_EXCESS_PIPE_I14A_V1"
      : "SFFD_AB204_EXISTING_CONFIGURATION_RISER_FOR_ADDITIONS_I15_V1";
  return results.filter(item => item.ruleId === id);
}

function historyEvidence(): ProjectEvidence[] {
  return [
    record("history-removed", "installation", [headId], { documentId: "install-log", revision: "7" }),
    record("history-welded", "installation", [headId], { documentId: "install-log", revision: "7" }),
  ];
}

describe("SFFD AB 2.04 local-change record checks", () => {
  it("fails threaded-head reuse when either confirmed installation fact triggers I.14(D)", () => {
    const result = evaluate(input({
      threadStandard: fact("npt", "current-drawing"),
      proposedReuse: fact("yes", "current-drawing"),
      removedFromFitting: fact("yes", "history-removed"),
      wasWelded: fact("no", "history-welded"),
    }), historyEvidence());
    expect(rule(result, "I14D")[0]?.status).toBe("fail");
    expect(rule(result, "I14D")[0]?.sourceRefs[0]?.clauses).toEqual(["I.14(D)"]);
  });

  it("fails on confirmed welding even when removal-from-fitting history is missing", () => {
    const result = evaluate(input({
      threadStandard: fact("iso7_1", "current-drawing"),
      proposedReuse: fact("yes", "current-drawing"),
      wasWelded: fact("yes", "history-welded"),
    }), [historyEvidence()[1]!]);
    expect(rule(result, "I14D")[0]?.status).toBe("fail");
  });

  it("passes reuse only when both independent installation facts confirm no trigger", () => {
    const result = evaluate(input({
      threadStandard: fact("npt", "current-drawing"),
      proposedReuse: fact("yes", "current-drawing"),
      removedFromFitting: fact("no", "history-removed"),
      wasWelded: fact("no", "history-welded"),
    }), historyEvidence());
    expect(rule(result, "I14D")[0]?.status).toBe("pass");
  });

  it("returns unknown for missing removal history, non-threaded/unknown connection, or a drawing-revision mismatch", () => {
    const common = {
      proposedReuse: fact("yes", "current-drawing"),
      removedFromFitting: fact("no", "history-removed"),
      wasWelded: fact("no", "history-welded"),
    } as const;
    const missingHistory = evaluate(input({ threadStandard: fact("npt", "current-drawing"), proposedReuse: common.proposedReuse }), []);
    expect(rule(missingHistory, "I14D")[0]?.status).toBe("unknown");

    const otherThread = evaluate(input({ ...common, threadStandard: fact("other", "current-drawing") }), historyEvidence());
    expect(rule(otherThread, "I14D")[0]?.status).toBe("unknown");

    const staleDrawingRef = { documentId: "old-proposal", revision: "2" };
    const mismatchedRevision = evaluate(input({
      threadStandard: fact("npt", "current-drawing"),
      proposedReuse: fact("yes", "old-reuse-plan"),
      removedFromFitting: fact("no", "history-removed"),
      wasWelded: fact("no", "history-welded"),
    }), [
      ...historyEvidence(),
      record("old-reuse-plan", "drawing", [headId], staleDrawingRef),
    ]);
    expect(rule(mismatchedRevision, "I14D")[0]?.status).toBe("unknown");
  });

  it("keeps proposedReuse=no not applicable without requiring unneeded history", () => {
    const result = evaluate(input({ proposedReuse: fact("no", "current-drawing") }));
    expect(rule(result, "I14D")[0]?.status).toBe("not_applicable");
  });

  it("does not treat wrong-subject, photo-only, invalidated, or superseded evidence as history", () => {
    const wrongSubject = record("history-removed", "installation", ["other-head"], { documentId: "install-log", revision: "7" });
    const wrongKind = record("history-removed", "photo", [headId]);
    const invalidated = record("history-removed", "installation", [headId], { documentId: "install-log", revision: "7" }, { invalidated: true });
    const superseded = record("history-removed", "installation", [headId], { documentId: "install-log", revision: "7" }, { superseded: true });
    for (const bad of [wrongSubject, wrongKind, invalidated, superseded]) {
      const result = evaluate(input({
        threadStandard: fact("npt", "current-drawing"),
        proposedReuse: fact("yes", "current-drawing"),
        removedFromFitting: fact("no", "history-removed"),
        wasWelded: fact("no", "history-welded"),
      }), [bad, historyEvidence()[1]!]);
      expect(rule(result, "I14D")[0]?.status).toBe("unknown");
    }
  });

  it("confirms excess-pipe removal only from installation evidence covering the listed segment", () => {
    const listed = fact<string[]>([segmentId], "current-drawing");
    const installed = record("pipe-install", "installation", [requestId, segmentId], { documentId: "install-log", revision: "7" });
    const passed = evaluate(input({
      plannedExcessPipeSegmentIds: listed,
      fieldExcessPipeRemovalStatus: fact("removed", "pipe-install"),
    }), [installed]);
    expect(rule(passed, "I14A")).toHaveLength(1);
    expect(rule(passed, "I14A")[0]?.status).toBe("pass");

    const notRemoved = evaluate(input({
      plannedExcessPipeSegmentIds: listed,
      fieldExcessPipeRemovalStatus: fact("not_removed", "pipe-install"),
    }), [installed]);
    expect(rule(notRemoved, "I14A")[0]?.status).toBe("fail");
  });

  it("keeps listed pipe unknown when only the proposal omits it, or field evidence misses the segment subject", () => {
    const proposedWithoutSegment = input({ plannedExcessPipeSegmentIds: fact<string[]>([segmentId], "current-drawing") });
    const noFieldFact = evaluate(proposedWithoutSegment);
    expect(rule(noFieldFact, "I14A")[0]?.status).toBe("unknown");

    const wrongSubject = record("pipe-install", "installation", [requestId, "another-pipe"], { documentId: "install-log", revision: "7" });
    const fieldFact = fact("removed", "pipe-install");
    const wrongFieldEvidence = evaluate(input({
      plannedExcessPipeSegmentIds: fact<string[]>([segmentId], "current-drawing"),
      fieldExcessPipeRemovalStatus: fieldFact,
    }), [wrongSubject]);
    expect(rule(wrongFieldEvidence, "I14A")[0]?.status).toBe("unknown");
  });

  it("emits no I.14(A) result only for a current drawing that explicitly lists no excess segments", () => {
    const currentEmpty = evaluate(input({ plannedExcessPipeSegmentIds: fact([], "current-drawing") }));
    expect(rule(currentEmpty, "I14A")).toHaveLength(0);

    const missingList = evaluate(input());
    expect(rule(missingList, "I14A")[0]?.status).toBe("unknown");
  });

  function i15Evidence(): ProjectEvidence[] {
    return [
      record("scope-work", "permit", [requestId]),
      record("scope-existing", "permit", [requestId]),
      record("scope-adds", "permit", [requestId]),
      record("existing-riser-plan", "drawing", [requestId], proposedRevision),
    ];
  }

  function additionFacts(overrides: { included?: Fact<"yes" | "no">; workType?: Fact<"new_system" | "existing_system_modification"> } = {}) {
    return {
      systemWorkType: overrides.workType ?? fact("existing_system_modification", "scope-work"),
      existingSystem: fact("yes", "scope-existing"),
      addsSprinklersOrPiping: fact("yes", "scope-adds"),
      existingConfigurationAndRiserIncluded: overrides.included,
    };
  }

  it("passes I.15 when an addition drawing revision confirms existing configuration and riser connection", () => {
    const facts = additionFacts({ included: fact("yes", "existing-riser-plan") });
    const result = evaluate(input(facts), i15Evidence());
    expect(rule(result, "I15")[0]?.status).toBe("pass");
    expect(rule(result, "I15")[0]?.sourceRefs[0]?.clauses).toEqual(["I.15"]);
  });

  it("fails I.15 when the current addition drawing confirms the required context is absent", () => {
    const result = evaluate(input(additionFacts({ included: fact("no", "existing-riser-plan") })), i15Evidence());
    expect(rule(result, "I15")[0]?.status).toBe("fail");
  });

  it("returns unknown for stale drawing revisions or missing/addition scope evidence", () => {
    const olderRiserEvidence = [
      ...i15Evidence().filter(record => record.id !== "existing-riser-plan"),
      record("existing-riser-plan", "drawing", [requestId], { documentId: "proposed-drawing", revision: "2" }),
    ];
    const stale = evaluate(input(additionFacts({ included: fact("yes", "existing-riser-plan") })), olderRiserEvidence);
    expect(rule(stale, "I15")[0]?.status).toBe("unknown");

    const missing = evaluate(input(additionFacts()), i15Evidence());
    expect(rule(missing, "I15")[0]?.status).toBe("unknown");
  });

  it("marks pure relocation not applicable and new-system scope unsupported rather than passing I.15", () => {
    const pureRelocation = evaluate(input({
      systemWorkType: fact("existing_system_modification", "scope-work"),
      existingSystem: fact("yes", "scope-existing"),
      addsSprinklersOrPiping: fact("no", "scope-adds"),
    }), i15Evidence());
    expect(rule(pureRelocation, "I15")[0]?.status).toBe("not_applicable");

    const newSystem = evaluate(input(additionFacts({ workType: fact("new_system", "scope-work") })), i15Evidence());
    expect(rule(newSystem, "I15")[0]?.status).toBe("unknown");
    expect(rule(newSystem, "I15")[0]?.verificationState).toBe("unsupported");
  });
});
