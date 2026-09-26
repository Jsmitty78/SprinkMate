import { contextIssues, factIssues } from "./evidence.js";
import type { HeadFacts, Orientation, PlanComparison, RuleContext, RuleResult, RuleStatus } from "./types.js";

const sourceUrl = "https://docs.johnsoncontrols.com/tycofire/api/khub/documents/JXGj~rL_f_FBVCY52uMTJw/content";

export const RULE = Object.freeze({
  id: "TY3231_INSTALL_ORIENTATION_V1",
  version: "1",
  sourceRevision: "August 2026",
  model: "TY3231",
  orientation: "pendent" as const,
  applicabilityConditions: Object.freeze({ model: "TY3231", installation: "installed", mounting: "standard", eachFactIndependentlyConfirmed: true }),
  scope: "Confirmed installed, standard (non-recessed) TY3231 orientation only; not whole-system compliance.",
  sources: Object.freeze([
    Object.freeze({ document: "TFP171", revision: "August 2026", page: 3, url: sourceUrl, purpose: "Identifies TY3231 as pendent." }),
    Object.freeze({ document: "TFP171", revision: "August 2026", page: 5, url: sourceUrl, purpose: "Requires pendent sprinklers to be installed in the pendent position." }),
  ]),
});

function result(ctx: RuleContext, status: RuleStatus, applicability: RuleResult["applicability"], reason: string, missingInputs: string[] = []): RuleResult {
  return {
    ruleId: RULE.id,
    targetId: ctx.targetId,
    status,
    applicability,
    reason,
    missingInputs: [...new Set(missingInputs)],
    evidenceIds: [],
    sourceRefs: RULE.sources,
    versions: { taskRevision: ctx.taskRevision, ruleVersion: RULE.version, sourceRevision: RULE.sourceRevision },
  };
}

function modelIssues(facts: HeadFacts, ctx: RuleContext): string[] {
  const issues = factIssues(facts.model, ctx, "model");
  // A model identifier must be a single identifier, not alternatives or free text.
  const model = facts.model?.value;
  if (typeof model !== 'string' || !/^[A-Z0-9][A-Z0-9._-]*$/i.test(model.trim())) issues.push("model");
  if (typeof model === 'string' && ["UNKNOWN", "AMBIGUOUS", "UNREADABLE"].includes(model.trim().toUpperCase())) issues.push("model");
  return issues;
}

export function validateHead(facts: HeadFacts, ctx: RuleContext): RuleResult {
  const outcome = evaluateHead(facts, ctx);
  outcome.evidenceIds = [...new Set(Object.values(facts).flatMap(fact => Array.isArray(fact?.evidenceIds) ? fact.evidenceIds : []))];
  return outcome;
}

function evaluateHead(facts: HeadFacts, ctx: RuleContext): RuleResult {
  const invalidContext = contextIssues(ctx);
  if (invalidContext.length) return result(ctx, "unknown", "unknown", "The target or task revision is invalid.", invalidContext);

  const modelMissing = modelIssues(facts, ctx);
  const installationMissing = factIssues(facts.installation, ctx, "installation");
  if (!['installed','uninstalled'].includes(facts.installation?.value ?? '')) installationMissing.push('installation');
  const mountingMissing = factIssues(facts.mounting, ctx, "mounting");
  if (!['standard','recessed'].includes(facts.mounting?.value ?? '')) mountingMissing.push('mounting');
  const model = typeof facts.model?.value === 'string' ? facts.model.value.trim().toUpperCase() : undefined;

  // An independently established exclusion is enough, even if unrelated facts are unknown.
  if (!modelMissing.length && model !== RULE.model) {
    return result(ctx, "not_applicable", "not_applicable", `The confirmed model ${model} is outside this TY3231 rule.`);
  }
  if (!installationMissing.length && facts.installation.value === "uninstalled") {
    return result(ctx, "not_applicable", "not_applicable", "The head is confirmed uninstalled; the installed-orientation rule does not apply.");
  }
  if (!mountingMissing.length && facts.mounting.value === "recessed") {
    return result(ctx, "not_applicable", "not_applicable", "Confirmed recessed mounting is outside this standard-mounting rule.");
  }

  const applicabilityMissing = [...modelMissing, ...installationMissing, ...mountingMissing];
  if (applicabilityMissing.length) {
    return result(ctx, "unknown", "unknown", "The model, installation state, or mounting is not independently established with current evidence.", applicabilityMissing);
  }

  const orientationMissing = [
    ...factIssues(facts.orientation, ctx, "orientation"),
    ...factIssues(facts.verticalReference, ctx, "verticalReference"),
  ];
  if (!['pendent','upright','sideways'].includes(facts.orientation?.value ?? '')) orientationMissing.push('orientation');
  if (!['gravity','verified_record'].includes(facts.verticalReference?.value ?? '')) orientationMissing.push('verticalReference');
  if (orientationMissing.length) {
    return result(ctx, "unknown", "applicable", "Independent observed orientation and its vertical reference are required; catalog orientation is not an observation.", orientationMissing);
  }
  if (facts.orientation.value === "pendent") {
    return result(ctx, "pass", "applicable", "The independently established installed orientation is pendent, matching this limited manufacturer requirement.");
  }
  return result(ctx, "fail", "applicable", `The independently established installed orientation is ${facts.orientation.value}; this TY3231 requirement specifies pendent.`);
}

export function comparePlan(planOrientation: Orientation, facts: HeadFacts, ctx: RuleContext): PlanComparison {
  const missingInputs = [
    ...contextIssues(ctx),
    ...(!['pendent','upright','sideways'].includes(planOrientation) ? ["planOrientation"] : []),
    ...(!['pendent','upright','sideways'].includes(facts.orientation?.value ?? '') ? ['orientation'] : []),
    ...(!['gravity','verified_record'].includes(facts.verticalReference?.value ?? '') ? ['verticalReference'] : []),
    ...factIssues(facts.orientation, ctx, "orientation"),
    ...factIssues(facts.verticalReference, ctx, "verticalReference"),
  ];
  const status = missingInputs.length ? "unknown" : planOrientation === facts.orientation.value ? "match" : "different";
  return {
    status,
    targetId: ctx.targetId,
    planned: planOrientation,
    observed: facts.orientation?.value ?? null,
    reason: status === "unknown" ? "The planned or independently observed orientation is not established."
      : status === "match" ? "The observed orientation matches the plan; this comparison is not a manufacturer-compliance check."
        : "The observed orientation differs from the plan; this comparison is separate from manufacturer compliance.",
    missingInputs: [...new Set(missingInputs)],
    taskRevision: ctx.taskRevision,
  };
}
