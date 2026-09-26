import { describe, expect, it } from "vitest";
import { comparePlan, emptyFacts, RULE, validateHead, type Fact, type HeadFacts, type RuleContext } from "../src/index.js";

const confirmed = <T>(value: T): Fact<T> => ({ value, confirmed: true, evidenceIds: ["record-1"], source: "fixture" });
const context = (): RuleContext => ({ targetId: "H1", taskRevision: 4, observations: [{ id: "record-1", targetId: "H1" }] });
const installed = (): HeadFacts => ({
  model: confirmed("TY3231"),
  installation: confirmed("installed"),
  mounting: confirmed("standard"),
  orientation: confirmed("pendent"),
  verticalReference: confirmed("verified_record"),
});

describe("TY3231 installed orientation", () => {
  it("passes the confirmed pendent case and pins the exact scope and sources", () => {
    const result = validateHead(installed(), context());
    expect(result).toMatchObject({
      ruleId: "TY3231_INSTALL_ORIENTATION_V1", status: "pass", applicability: "applicable", missingInputs: [],
      versions: { taskRevision: 4, ruleVersion: "1", sourceRevision: "August 2026" },
    });
    expect(result.sourceRefs.map(source => source.page)).toEqual([3, 5]);
    expect(RULE.scope).toContain("not whole-system compliance");
  });

  it.each(["upright", "sideways"] as const)("fails an independently observed %s orientation", orientation => {
    const facts = installed();
    facts.orientation = confirmed(orientation);
    expect(validateHead(facts, context()).status).toBe("fail");
  });

  it.each(["model", "installation", "mounting", "orientation", "verticalReference"] as const)("does not pass with missing %s", key => {
    const facts = installed();
    facts[key].value = null;
    const result = validateHead(facts, context());
    expect(result.status).toBe("unknown");
    expect(result.missingInputs).toContain(key);
  });
  it.each(["model", "installation", "mounting", "orientation", "verticalReference"] as const)("returns unknown when %s is removed from the runtime object", key => {
    const facts=installed();delete (facts as Partial<HeadFacts>)[key];
    expect(validateHead(facts,context()).status).toBe('unknown');
  });
  it.each(["installation", "mounting", "orientation", "verticalReference"] as const)("rejects unsupported runtime %s values", key => {
    const facts=installed();facts[key].value='unsupported' as never;
    expect(validateHead(facts,context()).status).toBe('unknown');
  });

  it.each(["model", "installation", "mounting", "orientation", "verticalReference"] as const)("requires confirmation of %s", key => {
    const facts = installed();
    facts[key].confirmed = false;
    expect(validateHead(facts, context()).status).toBe("unknown");
  });

  it("rejects circular orientation inferred from the model even if marked confirmed", () => {
    const facts = installed();
    facts.orientation.source = "model";
    const result = validateHead(facts, context());
    expect(result.status).toBe("unknown");
    expect(result.missingInputs).toContain("orientation.confirmation");
  });

  it("requires an independent vertical reference", () => {
    const facts = installed();
    facts.verticalReference = confirmed("unknown");
    expect(validateHead(facts, context()).status).toBe("unknown");
    facts.verticalReference = { ...confirmed("gravity" as const), source: "model" };
    expect(validateHead(facts, context()).status).toBe("unknown");
  });

  it.each(["TY3231 or TY3251", "unknown", "TY3231?"])("does not call an ambiguous identifier %s another confirmed model", model => {
    const facts = installed();
    facts.model.value = model;
    expect(validateHead(facts, context()).status).toBe("unknown");
  });

  it("does not accept an unknown orientation", () => {
    const facts = installed();
    facts.orientation.value = "unknown";
    expect(validateHead(facts, context()).status).toBe("unknown");
  });

  it.each(["missing", "wrong_target", "superseded", "ambiguous_id", "no_ids"])("requires usable evidence: %s", kind => {
    const facts = installed();
    const ctx = context();
    if (kind === "missing") ctx.observations = [];
    if (kind === "wrong_target") ctx.observations[0].targetId = "H2";
    if (kind === "superseded") ctx.observations[0].superseded = true;
    if (kind === "ambiguous_id") ctx.observations.push({ id: "record-1", targetId: "H2" });
    if (kind === "no_ids") facts.orientation.evidenceIds = [];
    expect(validateHead(facts, ctx).status).toBe("unknown");
  });

  it("keeps existing unsuperseded evidence valid after the task revision advances", () => {
    const ctx = context();
    ctx.taskRevision = 99;
    expect(validateHead(installed(), ctx)).toMatchObject({ status: "pass", versions: { taskRevision: 99 } });
  });

  it.each(["other_model", "uninstalled", "recessed"])("returns not_applicable for confirmed %s despite unrelated missing facts", kind => {
    const facts = emptyFacts();
    if (kind === "other_model") facts.model = confirmed("TY3251");
    if (kind === "uninstalled") facts.installation = confirmed("uninstalled");
    if (kind === "recessed") facts.mounting = confirmed("recessed");
    expect(validateHead(facts, context())).toMatchObject({ status: "not_applicable", applicability: "not_applicable", missingInputs: [] });
  });

  it("does not use an unconfirmed exclusion to skip the rule", () => {
    const facts = emptyFacts();
    facts.mounting = { ...confirmed("recessed" as const), confirmed: false };
    expect(validateHead(facts, context()).status).toBe("unknown");
  });

  it("does not use an exclusion from stale or wrong-target evidence", () => {
    const facts = emptyFacts();
    facts.mounting = confirmed("recessed");
    const ctx = context();
    ctx.observations[0].superseded = true;
    expect(validateHead(facts, ctx).status).toBe("unknown");
  });

  it("returns unknown for an invalid task version", () => {
    expect(validateHead(installed(), { ...context(), taskRevision: NaN }).status).toBe("unknown");
  });
});

describe("plan comparison is separate from manufacturer compliance", () => {
  it("can match an upright plan while failing the manufacturer rule", () => {
    const facts = installed();
    facts.orientation = confirmed("upright");
    expect(comparePlan("upright", facts, context()).status).toBe("match");
    expect(validateHead(facts, context()).status).toBe("fail");
  });

  it("can differ from an upright plan while passing the manufacturer rule", () => {
    expect(comparePlan("upright", installed(), context()).status).toBe("different");
    expect(validateHead(installed(), context()).status).toBe("pass");
  });

  it("does not compare an unsupported observation or unknown plan", () => {
    const facts = installed();
    facts.orientation.source = "model";
    expect(comparePlan("pendent", facts, context()).status).toBe("unknown");
    expect(comparePlan("unknown", installed(), context()).status).toBe("unknown");
  });
});
