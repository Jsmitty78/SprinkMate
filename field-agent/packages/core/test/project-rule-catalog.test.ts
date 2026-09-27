import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateProject, executeProjectRule, getProjectRuleCatalog, type ProjectEvaluationRequest } from "../src/index.js";

const request = (): ProjectEvaluationRequest => JSON.parse(readFileSync(new URL("../../../docs/local-change-evaluation.example.json", import.meta.url), "utf8"));

describe("addressed rule execution", () => {
  it("exposes the complete serializable catalog including unavailable domains", () => {
    const catalog = getProjectRuleCatalog();
    expect(new Set(catalog.map(rule => rule.id)).size).toBe(catalog.length);
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
    expect(catalog.some(rule => rule.implementationStatus === "source_pending")).toBe(true);
    expect(catalog.some(rule => rule.implementationStatus === "unimplemented")).toBe(true);
    for (const rule of catalog) {
      expect(rule.version).toBeTruthy();
      expect(rule.applicability).toBeTruthy();
      expect(rule.requiredInputs.length).toBeGreaterThan(0);
      expect(rule.executionFunction).toBe(rule.implementationStatus === "supported" ? "executeProjectRule" : null);
    }
  });

  it("matches each legacy local-check result without running unrelated checks", () => {
    const input = request();
    const legacy = evaluateProject(input);
    input.selectedRulePacks = [];
    for (const entry of getProjectRuleCatalog().filter(rule => rule.subjectTypes.includes("local_change") && rule.implementationStatus === "supported")) {
      const output = executeProjectRule(input, entry.id);
      expect(output.executionStatus).toBe("executed");
      expect(output.rules.every(rule => rule.ruleId === entry.id)).toBe(true);
      const expected = legacy.rules.filter(rule => rule.ruleId === entry.id);
      if (expected.length) expect(output.rules).toEqual(expected);
      else expect(output.rules[0]).toMatchObject({ status: "unknown", verificationState: "input_missing" });
    }
  });

  it("preserves only the selected check's required documents with bulk-identical evidence", () => {
    const input = request();
    input.localChange!.proposed.heads[0]!.position.value!.x += 1;
    input.localChange!.revisedDrawing!.approval.value = "not_approved";
    input.localChange!.changeRequest.fieldInstallationDeviationFromApprovedPlan!.value = "yes";
    input.localChange!.changeRequest.remoteAreaChanged.value = "yes";
    const bulk = evaluateProject(input);
    const selections = [
      ["SFFD_AB204_HEAD_RELOCATION_I14C_V1", "SFFD_AB204_REVISED_APPROVED_PLAN_I14C_"],
      ["SFFD_AB204_FIELD_DEVIATION_I14E_V1", "SFFD_AB204_FIELD_DEVIATION_REVIEW_I14E"],
      ["SFFD_AB204_HYDRAULIC_RECALC_I22A2_V1", "SFFD_AB204_REVISED_HYDRAULIC_CALCULATIONS_I22A2"],
    ];
    input.selectedRulePacks = [];
    for (const [id, artifactPrefix] of selections) {
      const selected = executeProjectRule(input, id!);
      const expected = bulk.localChange!.requiredArtifacts.filter(artifact => artifact.id.startsWith(artifactPrefix!));
      expect(expected.length).toBeGreaterThan(0);
      expect(selected.requiredArtifacts).toEqual(expected);
      expect(selected.rules).toEqual(bulk.rules.filter(rule => rule.ruleId === id));
      expect(selected.requiredArtifacts.every(artifact => artifact.sourceRefs.length > 0)).toBe(true);
    }
    expect(executeProjectRule(input, "LOCAL_CHANGE_BOM_ACCOUNTING_V1").requiredArtifacts).toEqual([]);
  });

  it("runs support selection even with no selected pack and retains applicability guards", () => {
    const input = request();
    input.selectedRulePacks = [];
    input.supports = [{ id: "support-selected" }];
    const id = "SFFD_AB415_CRACKED_CONCRETE_FASTENERS_I4_V1";
    const output = executeProjectRule(input, id);
    expect(output.rules).toHaveLength(1);
    expect(output.rules[0]).toMatchObject({ ruleId: id, status: "unknown", subjectIds: ["support-selected"] });
    expect(output.missingInputs.length).toBeGreaterThan(0);
  });

  it("reports source-pending and unimplemented selections explicitly", () => {
    const input = request();
    for (const entry of getProjectRuleCatalog().filter(rule => rule.implementationStatus !== "supported")) {
      const output = executeProjectRule(input, entry.id);
      expect(output.executionStatus).toBe(entry.implementationStatus);
      expect(output.rules[0]).toMatchObject({ ruleId: entry.id, status: "unknown", verificationState: entry.implementationStatus });
    }
  });

  it("runs only a chosen manufacturer rule and does not infer success without heads", () => {
    const input = request();
    input.selectedRulePacks = [];
    input.heads = [{ id: "unconfirmed-head" }];
    const output = executeProjectRule(input, "TFP171_INSTALL_ORIENTATION_V2");
    expect(output.rules).toHaveLength(1);
    expect(output.rules[0]).toMatchObject({ ruleId: "TFP171_INSTALL_ORIENTATION_V2", status: "unknown" });
    input.heads = [];
    const empty = executeProjectRule(input, "TFP171_INSTALL_ORIENTATION_V2");
    expect(empty.missingInputs).toContain("heads");
    expect(empty.rules[0]).toMatchObject({ ruleId: "TFP171_INSTALL_ORIENTATION_V2", status: "unknown", verificationState: "input_missing" });
  });

  it("rejects unknown rules without falling back to a pack", () => {
    expect(() => executeProjectRule(request(), "not-a-rule")).toThrow("Unknown rule");
  });
});
