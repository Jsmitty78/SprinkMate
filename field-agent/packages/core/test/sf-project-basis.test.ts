import { describe, expect, it } from "vitest";
import { ADOPTED_RULES, checkSchema, resolveSfNfpa13Edition, SF_PROJECT_BASIS_SOURCE, SfProjectFactsSchema, type Fact, type RuleContext, type SfCodeCycle, type SfProjectFacts } from "../src/index.js";

const confirmed = <T>(value: T): Fact<T> => ({ value, confirmed: true, evidenceIds: ["permit-record"], source: "manual" });
const context = (): RuleContext => ({ targetId: "project-1", taskRevision: 2, observations: [{ id: "permit-record", targetId: "project-1" }] });
const newBuilding = (cycle: SfCodeCycle = "2022"): SfProjectFacts => ({
  jurisdiction: confirmed("san_francisco"), standard: confirmed("nfpa13"), permitKind: confirmed("new_building_site_permit"),
  sitePermitCodeCycle: confirmed(cycle), architecturalPermitCodeCycle: confirmed(cycle), editionElection: confirmed("permit_basis"),
});
const revision = (): SfProjectFacts => ({
  jurisdiction: confirmed("san_francisco"), standard: confirmed("nfpa13"), permitKind: confirmed("revision"),
  originalFirePermitNumber: confirmed("202209261234"), originalNfpa13Edition: confirmed("2016"),
});
const resolve = (facts: SfProjectFacts) => resolveSfNfpa13Edition(facts, context());

describe("San Francisco source-backed NFPA 13 edition basis", () => {
  it.each([["2019", "2016"], ["2022", "2022"], ["2025", "2025"]] as const)("resolves matching %s permit code cycles to NFPA 13 %s", (cycle, edition) => {
    const result = resolve(newBuilding(cycle));
    expect(result).toMatchObject({ status: "resolved", nfpa13Edition: edition, missingInputs: [], targetId: "project-1", taskRevision: 2 });
    expect(result.sourceRefs).toEqual([SF_PROJECT_BASIS_SOURCE]);
    expect(SF_PROJECT_BASIS_SOURCE).toMatchObject({ revision: "2025", page: 1, url: "https://sf-fire.org/media/4169", checkedAt: "2026-09-26" });
    expect(result).not.toHaveProperty("pass");
    expect(ADOPTED_RULES).toHaveLength(10); // Project basis is not an eleventh manufacturer/compliance rule.
  });
  it.each([["2019", "2022"], ["2019", "2025"], ["2022", "2025"]] as const)("accepts an independently confirmed newer owner election %s to %s", (cycle, requested) => {
    const facts = newBuilding(cycle); facts.editionElection = confirmed("owner_newer"); facts.ownerRequestedEdition = confirmed(requested);
    expect(resolve(facts)).toMatchObject({ status: "resolved", nfpa13Edition: requested });
  });
  it.each([["2019", "2016"], ["2022", "2016"], ["2022", "2022"], ["2025", "2022"], ["2025", "2025"]] as const)("does not resolve a same/older voluntary election %s to %s", (cycle, requested) => {
    const facts = newBuilding(cycle); facts.editionElection = confirmed("owner_newer"); facts.ownerRequestedEdition = confirmed(requested);
    expect(resolve(facts)).toMatchObject({ status: "unknown", nfpa13Edition: null });
  });
  it("does not choose between mismatched site and architectural cycles", () => {
    const facts = newBuilding("2019"); facts.architecturalPermitCodeCycle = confirmed("2022");
    expect(resolve(facts)).toMatchObject({ status: "unknown", nfpa13Edition: null, missingInputs: ["sitePermitCodeCycle", "architecturalPermitCodeCycle"] });
  });
  it.each(["sitePermitCodeCycle", "architecturalPermitCodeCycle"] as const)("does not map an unsupported %s", field => {
    const facts = newBuilding(); facts[field] = confirmed("other");
    expect(resolve(facts)).toMatchObject({ status: "unknown", nfpa13Edition: null });
  });
  it("does not infer a cycle from San Francisco, the source revision, or today's date", () => {
    const facts = newBuilding(); delete facts.sitePermitCodeCycle; delete facts.architecturalPermitCodeCycle;
    expect(resolve(facts)).toMatchObject({ status: "unknown", nfpa13Edition: null });
  });
  it("requires the owner-requested edition on the voluntary pathway", () => {
    const facts = newBuilding(); facts.editionElection = confirmed("owner_newer");
    expect(resolve(facts).missingInputs).toContain("ownerRequestedEdition");
    facts.ownerRequestedEdition = confirmed("other");
    expect(resolve(facts)).toMatchObject({ status: "unknown", nfpa13Edition: null });
    facts.ownerRequestedEdition = { ...confirmed("2025"), source: "model" };
    expect(resolve(facts)).toMatchObject({ status: "unknown", nfpa13Edition: null });
  });
  it("does not silently discard an owner request on the permit-basis pathway", () => {
    const facts = newBuilding("2022"); facts.ownerRequestedEdition = confirmed("2025");
    expect(resolve(facts)).toMatchObject({ status: "unknown", nfpa13Edition: null });
    facts.ownerRequestedEdition = confirmed("2022");
    expect(resolve(facts)).toMatchObject({ status: "resolved", nfpa13Edition: "2022" });
    facts.ownerRequestedEdition.confirmed = false;
    expect(resolve(facts).status).toBe("unknown");
    facts.ownerRequestedEdition = { ...confirmed("2022"), source: "model" };
    expect(resolve(facts).status).toBe("unknown");
    facts.ownerRequestedEdition = { ...confirmed("2022"), evidenceIds: [] };
    expect(resolve(facts).status).toBe("unknown");
  });

  for (const field of ["jurisdiction", "standard", "permitKind", "sitePermitCodeCycle", "architecturalPermitCodeCycle", "editionElection"] as const) {
    it.each(["missing", "null", "unconfirmed", "ai", "invalid", "no_evidence"])(`requires independently established ${field}: %s`, kind => {
      const facts = newBuilding();
      if (kind === "missing") delete (facts as Partial<SfProjectFacts>)[field];
      if (kind === "null") facts[field]!.value = null;
      if (kind === "unconfirmed") facts[field]!.confirmed = false;
      if (kind === "ai") facts[field]!.source = "model";
      if (kind === "invalid") facts[field]!.value = "unsupported" as never;
      if (kind === "no_evidence") facts[field]!.evidenceIds = [];
      expect(resolve(facts)).toMatchObject({ status: "unknown", nfpa13Edition: null });
    });
  }
  it.each(["wrong_target", "superseded", "missing", "duplicate"])("rejects unusable source evidence: %s", kind => {
    const ctx = context();
    if (kind === "wrong_target") ctx.observations[0].targetId = "project-2";
    if (kind === "superseded") ctx.observations[0].superseded = true;
    if (kind === "missing") ctx.observations = [];
    if (kind === "duplicate") ctx.observations.push({ id: "permit-record", targetId: "project-1" });
    expect(resolveSfNfpa13Edition(newBuilding(), ctx)).toMatchObject({ status: "unknown", nfpa13Edition: null });
  });
  it.each([NaN, -1, 1.5])("rejects invalid context revision %s", taskRevision => {
    expect(resolveSfNfpa13Edition(newBuilding(), { ...context(), taskRevision }).status).toBe("unknown");
  });

  it.each(["jurisdiction", "standard", "permitKind"] as const)("uses an independently confirmed %s exclusion without requiring unrelated facts", field => {
    const facts = newBuilding(); facts.jurisdiction.value = null; facts.standard.value = null; facts.permitKind.value = null;
    facts[field] = confirmed("other");
    expect(resolve(facts)).toMatchObject({ status: "not_applicable", nfpa13Edition: null });
    facts[field].confirmed = false;
    expect(resolve(facts).status).toBe("unknown");
  });
  it.each(["nfpa13r", "nfpa13d"] as const)("does not substitute the NFPA 13 mapping for %s", standard => {
    const facts = newBuilding(); facts.standard = confirmed(standard);
    expect(resolve(facts).status).toBe("not_applicable");
  });
});

describe("original FIRE Only permit retention", () => {
  it.each(["revision", "as_built"] as const)("retains original editions for %s without needing unrelated site cycles", kind => {
    for (const edition of ["2016", "2022", "2025"] as const) {
      const facts = revision(); facts.permitKind = confirmed(kind); facts.originalNfpa13Edition = confirmed(edition);
      expect(resolve(facts)).toMatchObject({ status: "resolved", nfpa13Edition: edition });
      expect(resolve(facts).reason).toContain("202209261234");
    }
  });
  for (const field of ["originalFirePermitNumber", "originalNfpa13Edition"] as const) {
    it.each(["missing", "null", "unconfirmed", "ai", "no_evidence"])(`requires original-permit ${field}: %s`, kind => {
      const facts = revision();
      if (kind === "missing") delete facts[field];
      if (kind === "null") facts[field]!.value = null;
      if (kind === "unconfirmed") facts[field]!.confirmed = false;
      if (kind === "ai") facts[field]!.source = "model";
      if (kind === "no_evidence") facts[field]!.evidenceIds = [];
      expect(resolve(facts)).toMatchObject({ status: "unknown", nfpa13Edition: null });
    });
  }
  it.each(["", "   "])("rejects a blank original permit number %j", number => {
    const facts = revision(); facts.originalFirePermitNumber = confirmed(number);
    expect(resolve(facts).status).toBe("unknown");
  });
  it.each(["UNKNOWN", " unknown ", "Ambiguous", " UNREADABLE "])("rejects placeholder original permit number %j", number => {
    const facts = revision(); facts.originalFirePermitNumber = confirmed(number);
    expect(resolve(facts)).toMatchObject({ status: "unknown", nfpa13Edition: null });
  });
  it("does not invent a mapping for an unsupported original edition", () => {
    const facts = revision(); facts.originalNfpa13Edition = confirmed("other");
    expect(resolve(facts).status).toBe("unknown");
  });
  it.each(["revision", "as_built"] as const)("does not apply a voluntary newer edition to %s", kind => {
    const facts = revision(); facts.permitKind = confirmed(kind); facts.editionElection = confirmed("owner_newer"); facts.ownerRequestedEdition = confirmed("2025");
    expect(resolve(facts)).toMatchObject({ status: "unknown", nfpa13Edition: null });
    facts.editionElection = confirmed("permit_basis");
    expect(resolve(facts).status).toBe("unknown"); // A contradictory supplied requested edition is still unresolved.
    facts.ownerRequestedEdition = confirmed("2016");
    expect(resolve(facts)).toMatchObject({ status: "resolved", nfpa13Edition: "2016" });
    facts.editionElection.source = "model";
    expect(resolve(facts).status).toBe("unknown");
  });
});

describe("SF project JSON boundary", () => {
  it("accepts distinct new-building and original-permit facts without defaults", () => {
    expect(checkSchema(SfProjectFactsSchema, newBuilding())).toBe(true);
    expect(checkSchema(SfProjectFactsSchema, revision())).toBe(true);
    const facts = newBuilding(); delete facts.sitePermitCodeCycle;
    expect(checkSchema(SfProjectFactsSchema, facts)).toBe(true);
    expect(resolve(facts).status).toBe("unknown");
  });
  it("rejects unknown properties, arbitrary editions, untyped years, and incomplete first-three fields", () => {
    const facts = newBuilding();
    expect(checkSchema(SfProjectFactsSchema, { ...facts, currentDate: "2026-09-26" })).toBe(false);
    expect(checkSchema(SfProjectFactsSchema, { ...facts, sitePermitCodeCycle: confirmed(2022) })).toBe(false);
    expect(checkSchema(SfProjectFactsSchema, { ...facts, ownerRequestedEdition: confirmed("2030") })).toBe(false);
    expect(checkSchema(SfProjectFactsSchema, { ...facts, jurisdiction: undefined })).toBe(false);
    expect(checkSchema(SfProjectFactsSchema, { ...facts, standard: { ...facts.standard, accepted: true } })).toBe(false);
  });
});
