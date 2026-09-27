import { describe, expect, it } from "vitest";
import { ADOPTED_RULES, emptyFacts, HEAD_FACT_FIELDS, RULE, validateHead, validateRules, type Fact, type HeadFacts, type RuleContext } from "../src/index.js";

const confirmed = <T>(value: T): Fact<T> => ({ value, confirmed: true, evidenceIds: ["record"], source: "fixture" });
const context = (): RuleContext => ({ targetId: "H1", taskRevision: 3, observations: [{ id: "record", targetId: "H1" }] });
const facts = (): HeadFacts => ({
  ...emptyFacts(), model: confirmed("TY3231"), installation: confirmed("installed"), mounting: confirmed("standard"),
  orientation: confirmed("pendent"), verticalReference: confirmed("gravity"), escutcheon: confirmed("style_10"),
  bulbCondition: confirmed("intact"), installationWrench: confirmed("w_type_6"), threadStandard: confirmed("npt"),
  installationTorqueFtLb: confirmed(10), construction: confirmed("retrofit"), fieldFinish: confirmed("factory_only"),
  leakage: confirmed("absent"), corrosion: confirmed("absent"), workingPressurePsi: confirmed(175), approvalBasis: confirmed("ul_cul"), pressureBasis: confirmed("system_maximum"),
});
const outcome = (input: HeadFacts, index: number) => validateRules(input, context())[index];
const applicable = (index: number): HeadFacts => {
  const input = facts();
  if (index === 1) { input.mounting = confirmed("recessed"); input.installationWrench = confirmed("w_type_7"); }
  if (index === 5) input.model = confirmed("TY4931");
  return input;
};
const requiredByRule = [
  "orientation", "escutcheon", "bulbCondition", "installationWrench", "installationTorqueFtLb", "construction",
  "fieldFinish", "leakage", "corrosion", "workingPressurePsi",
] as const;

describe("source-versioned independent rule set", () => {
  it("returns ten independently identified conditions and populates all fact fields", () => {
    expect(ADOPTED_RULES).toHaveLength(10);
    expect(new Set(ADOPTED_RULES.map(rule => rule.id)).size).toBe(10);
    expect(Object.keys(emptyFacts())).toEqual(HEAD_FACT_FIELDS);
    expect(HEAD_FACT_FIELDS).toHaveLength(17);
    const results = validateRules(facts(), context());
    expect(results.map(result => result.status)).toEqual(["pass", "not_applicable", "pass", "pass", "pass", "not_applicable", "pass", "pass", "pass", "pass"]);
    expect(validateHead(facts(), context())).toEqual(results[0]);
    expect(RULE).toBe(ADOPTED_RULES[0]);
    for (const result of results) {
      expect(result.title).toBeTruthy();
      expect(result.scope).toContain("not whole-system compliance");
      expect(result.sourceRefs.length).toBeGreaterThan(0);
      expect(result.versions).toMatchObject({ taskRevision: 3, sourceRevision: "August 2026" });
    }
  });

  for (const [index, field] of requiredByRule.entries()) {
    describe(ADOPTED_RULES[index].id, () => {
      it("passes independently confirmed applicable evidence", () => {
        expect(outcome(applicable(index), index).status).toBe("pass");
      });
      it.each(["absent", "null", "unconfirmed", "ai", "invalid", "missing_evidence", "stale", "wrong_target"])("preserves unknown for %s input", kind => {
        const input = applicable(index);
        const ctx = context();
        if (kind === "absent") delete input[field];
        if (kind === "null") input[field]!.value = null;
        if (kind === "unconfirmed") input[field]!.confirmed = false;
        if (kind === "ai") input[field]!.source = "model";
        if (kind === "invalid") input[field]!.value = "unsupported" as never;
        if (kind === "missing_evidence") input[field]!.evidenceIds = [];
        if (kind === "stale") ctx.observations[0].superseded = true;
        if (kind === "wrong_target") ctx.observations[0].targetId = "H2";
        expect(validateRules(input, ctx)[index].status).toBe("unknown");
      });
      it("requires known applicability and preserves independent exclusions", () => {
        const input = applicable(index);
        input.model.value = null;
        expect(outcome(input, index).status).toBe("unknown");
        const excluded = emptyFacts();
        excluded.model = confirmed("TY9999");
        expect(outcome(excluded, index).status).toBe("not_applicable");
        excluded.model.confirmed = false;
        expect(outcome(excluded, index).status).toBe("unknown");
        excluded.installation = confirmed("uninstalled");
        expect(outcome(excluded, index).status).toBe("not_applicable");
      });
      it.each(["installation", "mounting"] as const)("does not assume the %s applicability fact", field => {
        const input = applicable(index);
        input[field].value = null;
        expect(outcome(input, index).status).toBe("unknown");
        input[field] = { ...confirmed(field === "installation" ? "installed" : "recessed"), source: "model" } as never;
        expect(outcome(input, index).status).toBe("unknown");
      });
    });
  }

  it.each([NaN, -1, 1.5, Infinity])("rejects invalid task revision %s for every rule", revision => {
    expect(validateRules(facts(), { ...context(), taskRevision: revision }).every(result => result.status === "unknown")).toBe(true);
  });
  it("rejects malformed evidence context without throwing", () => {
    expect(validateRules(facts(), { ...context(), observations: null as never }).every(result => result.status === "unknown")).toBe(true);
  });
  it("does not approve unsupported recessed combinations", () => {
    const input = facts(); input.model = confirmed("TY4931"); input.mounting = confirmed("recessed");
    expect(validateRules(input, context()).every(result => result.status === "not_applicable")).toBe(true);
  });
});

describe("orientation model table", () => {
  it.each([
    ["TY2131", "upright"], ["TY2231", "pendent"], ["TY3131", "upright"], ["TY3231", "pendent"],
    ["TY4131", "upright"], ["TY4231", "pendent"], ["TY4831", "upright"], ["TY4931", "pendent"],
  ] as const)("checks the independently observed orientation of %s", (model, orientation) => {
    const input = facts(); input.model = confirmed(model); input.orientation = confirmed(orientation);
    expect(validateHead(input, context()).status).toBe("pass");
    input.orientation = confirmed(orientation === "pendent" ? "upright" : "pendent");
    expect(validateHead(input, context()).status).toBe("fail");
  });
  it.each(["TY2231", "TY3231", "TY4231"])("checks recessed %s direction without inferring escutcheon compatibility", model => {
    const input = facts(); input.model = confirmed(model); input.mounting = confirmed("recessed"); delete input.escutcheon;
    expect(validateHead(input, context()).status).toBe("pass");
    expect(outcome(input, 1).status).toBe("unknown");
    input.orientation = confirmed("upright");
    expect(validateHead(input, context()).status).toBe("fail");
  });
});

describe("recessed combinations and tool", () => {
  it.each([
    ["TY2231", "style_10"], ["TY2231", "style_20"], ["TY3231", "style_10"], ["TY3231", "style_20"],
    ["TY4231", "style_30"], ["TY4231", "style_40"],
  ] as const)("accepts only the sourced %s / %s pairing", (model, style) => {
    const input = applicable(1); input.model = confirmed(model); input.escutcheon = confirmed(style);
    expect(outcome(input, 1).status).toBe("pass");
    input.escutcheon = confirmed(model === "TY4231" ? "style_10" : "style_30");
    expect(outcome(input, 1).status).toBe("fail");
    input.escutcheon = confirmed("other");
    expect(outcome(input, 1).status).toBe("fail");
  });
  it("requires W-Type 7 for recessed and W-Type 6 for standard installation", () => {
    const input = applicable(1);
    expect(outcome(input, 3).status).toBe("pass");
    input.installationWrench = confirmed("w_type_6");
    expect(outcome(input, 3).status).toBe("fail");
    input.mounting = confirmed("standard");
    expect(outcome(input, 3).status).toBe("pass");
    input.installationWrench = confirmed("w_type_7");
    expect(outcome(input, 3).status).toBe("fail");
    input.installationWrench = confirmed("other");
    expect(outcome(input, 3).status).toBe("fail");
  });
});

describe("NPT torque and retrofit restriction", () => {
  it.each([
    ["TY3231", 7, "pass"], ["TY3231", 14, "pass"], ["TY3231", 6.999, "fail"], ["TY3231", 14.001, "fail"],
    ["TY4231", 10, "pass"], ["TY4231", 20, "pass"], ["TY4231", 9.999, "fail"], ["TY4231", 20.001, "fail"],
  ] as const)("checks %s installation torque %s without additional tolerance", (model, torque, status) => {
    const input = facts(); input.model = confirmed(model); input.installationTorqueFtLb = confirmed(torque);
    expect(outcome(input, 4).status).toBe(status);
  });
  it.each(["TY4831", "TY4931"])("rejects new-construction %s while allowing independently confirmed retrofit", model => {
    const input = facts(); input.model = confirmed(model); input.construction = confirmed("new");
    expect(outcome(input, 5).status).toBe("fail");
    input.construction = confirmed("retrofit");
    expect(outcome(input, 5).status).toBe("pass");
  });
  it.each([4, 5, 9])("excludes confirmed non-NPT from NPT-only rule %s but does not assume unknown threads", index => {
    const input = applicable(index); input.threadStandard = confirmed("iso7_1");
    expect(outcome(input, index).status).toBe("not_applicable");
    input.threadStandard = confirmed("other");
    expect(outcome(input, index).status).toBe("not_applicable");
    delete input.threadStandard;
    expect(outcome(input, index).status).toBe("unknown");
  });
});

describe("replacement conditions", () => {
  it.each(["cracked", "liquid_loss"] as const)("fails for confirmed bulb %s", value => {
    const input = facts(); input.bulbCondition = confirmed(value);
    expect(outcome(input, 2).status).toBe("fail");
  });
  it.each(["field_painted", "field_plated", "field_coated"] as const)("fails for confirmed %s", value => {
    const input = facts(); input.fieldFinish = confirmed(value);
    expect(outcome(input, 6).status).toBe("fail");
  });
  it.each([["leakage", 7], ["corrosion", 8]] as const)("fails for confirmed %s", (key, index) => {
    const input = facts(); input[key] = confirmed("present");
    expect(outcome(input, index).status).toBe("fail");
  });
});

describe("maximum working-pressure boundaries", () => {
  it.each(["spot_reading", "catalog_rating", "test_pressure"] as const)("does not use %s as the system maximum working pressure", basis => {
    const input = facts(); input.pressureBasis = confirmed(basis);
    expect(outcome(input, 9)).toMatchObject({ status: "unknown", applicability: "applicable", missingInputs: ["pressureBasis"] });
    input.workingPressurePsi = confirmed(300);
    expect(outcome(input, 9).status).toBe("unknown");
  });
  it.each(["missing", "unconfirmed", "ai", "missing_evidence", "invalid"])("requires independent pressure basis: %s", kind => {
    const input = facts();
    if (kind === "missing") delete input.pressureBasis;
    if (kind === "unconfirmed") input.pressureBasis!.confirmed = false;
    if (kind === "ai") input.pressureBasis!.source = "model";
    if (kind === "missing_evidence") input.pressureBasis!.evidenceIds = [];
    if (kind === "invalid") input.pressureBasis!.value = "not-a-basis" as never;
    expect(outcome(input, 9).status).toBe("unknown");
  });
  it.each([NaN, Infinity, -Infinity, -1])("rejects invalid numeric input %s", value => {
    const input = facts(); input.installationTorqueFtLb = confirmed(value); input.workingPressurePsi = confirmed(value);
    expect(outcome(input, 4).status).toBe("unknown");
    expect(outcome(input, 9).status).toBe("unknown");
  });
  it.each(["TY3131", "TY3231"])("evaluates %s UL/C-UL allowance without assuming listing", model => {
    const input = facts(); input.model = confirmed(model); delete input.approvalBasis;
    expect(outcome(input, 9).status).toBe("pass"); // 175 psi is valid for either documented basis.
    input.workingPressurePsi = confirmed(175.001);
    expect(outcome(input, 9)).toMatchObject({ status: "unknown", missingInputs: ["approvalBasis"] });
    input.approvalBasis = confirmed("other");
    expect(outcome(input, 9).status).toBe("fail");
    input.approvalBasis = confirmed("ul_cul"); input.workingPressurePsi = confirmed(250);
    expect(outcome(input, 9).status).toBe("pass");
    input.approvalBasis.source = "model";
    expect(outcome(input, 9).status).toBe("unknown");
    input.workingPressurePsi = confirmed(250.001);
    expect(outcome(input, 9).status).toBe("fail"); // Exceeds both possible documented limits.
  });
  it.each(["TY2131", "TY2231", "TY4131", "TY4231", "TY4831", "TY4931"])("keeps %s at 175 psi even with UL/C-UL", model => {
    const input = facts(); input.model = confirmed(model);
    expect(outcome(input, 9).status).toBe("pass");
    input.workingPressurePsi = confirmed(175.001);
    expect(outcome(input, 9).status).toBe("fail");
  });
  it("applies the same conditional pressure limit to the documented recessed TY3231", () => {
    const input = applicable(1); input.workingPressurePsi = confirmed(250);
    expect(outcome(input, 9).status).toBe("pass");
  });
});
