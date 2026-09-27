import {
  evaluateProject,
  type WorkPackageSnapshot,
  type ProjectEvaluationRequest,
  type ProjectLocalPlan,
  type ProjectLocalChangeInput,
  type ProjectEvidence,
} from "@field-agent/core";
import type {
  FabricationOutput,
  FabricationInput,
} from "@field-agent/fabrication";
import type { Plan } from "@field-agent/planning";
import { fact, known, unknown } from "./model.js";
export interface CheckResult {
  id: string;
  subjectIds: string[];
  status: "pass" | "fail" | "unknown" | "not_applicable";
  state: string;
  reason: string;
  sourceRefs: string[];
}
export interface ProfileOutput {
  profile: "drawing_preparation" | "site_adaptation";
  required: { id: string; subjectIds: string[] }[];
  checks: CheckResult[];
  excluded: { id: string; reason: string }[];
  project: ReturnType<typeof evaluateProject>;
}
export function evaluateProfile(
  s: WorkPackageSnapshot,
  input: FabricationInput,
  output: FabricationOutput,
  plan: Plan,
  baseline: Plan,
): ProfileOutput {
  const adaptation = s.intent === "adapt_to_site" && plan.id !== baseline.id;
  const profile = !adaptation ? "drawing_preparation" : "site_adaptation";
  const heads = s.baselinePlan!.entities.filter((e) => e.kind === "head");
  const tyco = heads.filter((e) => e.productId === "TY3231");
  const supports = s.baselinePlan!.entities.filter((e) => e.kind === "support");
  const jurisdiction = fact<string>(s, "jurisdiction");
  const sfApplicable = jurisdiction.confirmed && jurisdiction.value === "san_francisco" && jurisdiction.evidenceIds.length > 0;
  const request: ProjectEvaluationRequest = {
    project: {
      id: s.projectId,
      revision: s.inputRevision,
      asOf: s.updatedAt.slice(0, 10),
    },
    selectedRulePacks: [
      ...(sfApplicable ? ["sf-project-basis" as const] : []),
      ...(sfApplicable && supports.length ? ["sf-supports-2025" as const] : []),
      ...(tyco.length
        ? ["tyco-tfp171-head" as const, "tyco-tfp171-extra" as const]
        : []),
      ...(sfApplicable && adaptation ? ["sf-local-change-2025" as const] : []),
    ],
    facts: {
      sfNfpa13: {
        jurisdiction: fact(s, "jurisdiction"),
        standard: fact(s, "standard"),
        permitKind: fact(s, "permitKind"),
        originalNfpa13Edition: fact(s, "originalNfpa13Edition"),
        originalFirePermitNumber: fact(s, "originalFirePermitNumber"),
      },
      systemType: fact(s, "systemType"),
      sprinklerType: fact(s, "sprinklerType"),
      storage: fact(s, "storage"),
    },
    heads: tyco.map((h) => ({ id: h.id })),
    supports: supports.map((h) => ({ id: h.id })),
    evidence: [],
  };
  const drawing = {
    documentId: s.sourceDrawing!.drawingId,
    revision: s.sourceDrawing!.revision,
  };
  const localPlan = (p: Plan): ProjectLocalPlan => ({
    ...p,
    sourceDrawing:
      p.id === baseline.id
        ? known(drawing, [`drawing-${s.sourceDrawing!.assetId}`])
        : unknown(),
    rooms: [],
    heads: [],
    supports: supports.map((h) => ({
      supportId: h.id,
      attachedPipeSegmentIds: unknown(),
    })),
    segments: p.segments.map(({ productId, sourceSegmentIds, ...x }) => ({
      ...x,
      nominalSize: unknown(),
      material: unknown(),
      pressureRating: unknown(),
      connectionAtStart: unknown(),
      connectionAtEnd: unknown(),
    })),
    fittings: p.fittings.map((x) => ({
      ...x,
      productId: unknown(),
      nominalSize: unknown(),
      material: unknown(),
      pressureRating: unknown(),
      ports: [
        { ...x.ports[0], connection: unknown() },
        { ...x.ports[1], connection: unknown() },
      ],
    })),
  });
  if (adaptation) {
    const change: ProjectLocalChangeInput = {
      id: `local-${s.changeRequest!.id}`,
      approvedDrawing: {
        document: known(drawing, [`drawing-${s.sourceDrawing!.assetId}`]),
        approval:
          s.sourceDrawing!.approval === "approved"
            ? known("approved", [`drawing-${s.sourceDrawing!.assetId}`])
            : unknown(),
      },
      baseline: localPlan(baseline),
      proposed: localPlan(plan),
      changeRequest: {
        id: s.changeRequest!.id,
        description: known(s.changeRequest!.description),
        affectedEntityIds: known(s.changeRequest!.affectedEntityIds),
        impactNeighborhood: unknown(),
        changeClassification: fact(s, "changeClassification"),
        systemWorkType: fact(s, "systemWorkType"),
        existingSystem: fact(s, "existingSystem"),
        addsSprinklersOrPiping: fact(s, "addsSprinklersOrPiping"),
        remoteAreaChanged: fact(s, "remoteAreaChanged"),
        hazardBecameMoreDemanding: fact(s, "hazardBecameMoreDemanding"),
        waterSupplyRoutingOrBackflowChanged: fact(
          s,
          "waterSupplyRoutingOrBackflowChanged",
        ),
        headRemovalActions: [],
      },
    };
    request.localChange = change;
  }
  // The rule adapter preserves evidence scope. It never widens a user fact onto another part.
  request.evidence = input.evidence.map(
    (e) =>
      ({
        id: e.id,
        projectId: s.projectId,
        subjectIds: [
          ...e.subjectIds,
          ...(e.id.startsWith("drawing-")
            ? [
                baseline.id,
                ...baseline.segments.map((x) => x.id),
                ...baseline.fittings.map((x) => x.id),
              ]
            : []),
        ],
        kind: "drawing",
        documentRevision: drawing,
      }) satisfies ProjectEvidence,
  );
  for (const f of [...s.detailing, ...s.siteFacts].filter(
    (f) => f.subjectIds.length === 0,
  )) {
    const e = request.evidence.find((e) => e.id === f.id);
    if (e) e.subjectIds.push(s.projectId);
  }
  const project = evaluateProject(request);
  // Intake requirements can be package-wide or scoped. Never borrow another entity's facts.
  const requirement = (field: string, subject: string) => {
    const scoped = fact<string>(s, field, subject);
    return scoped.evidenceIds.length ? scoped : fact<string>(s, field);
  };
  const sourceFields = ["requiredConnectionMethod", "requiredPipeSpecification", "materialRequirement", "materialRequirement.material", "nominalSize"];
  const nominal = (value: string | null) => {
    const text = value?.trim().toLowerCase().replace(/^nps\s*/, "").replace(/\s*(?:inch(?:es)?|in|["″])$/, "").trim();
    if (!text) return null;
    if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
    const fraction = text.match(/^(?:(\d+)[ -]+)?(\d+)\/(\d+)$/);
    if (!fraction || Number(fraction[3]) === 0) return null;
    return Number(fraction[1] ?? 0) + Number(fraction[2]) / Number(fraction[3]);
  };
  const checks: CheckResult[] = [
    {
      id: "PROJECT_BASIS",
      subjectIds: [],
      status:
        project.basis?.status === "resolved"
          ? "pass"
          : project.basis?.status === "not_applicable"
            ? "not_applicable"
            : "unknown",
      state:
        project.basis?.status === "resolved" ? "verified" : "input_missing",
      reason: project.basis?.reason ?? "Project basis unresolved",
      sourceRefs: project.basis?.sourceRefs.map((r) => r.url) ?? [],
    },
    ...output.selectedProducts.filter(p => p.limitations?.length).map(p => ({
      id: `PRODUCT-SUITABILITY-${p.id}`, subjectIds: input.pieces.filter(x => x.productId === p.id).map(x => x.id),
      status: "unknown" as const, state: "input_missing", reason: p.limitations!.join(" "), sourceRefs: p.sourceIds,
    })),
    ...input.pieces.flatMap(p => sourceFields.flatMap(field => {
      const req = requirement(field, p.id);
      return req.value ? [{
        id: `SOURCE-REQUIREMENT-${p.id}-${field}`, subjectIds: [p.id], status: "unknown" as const,
        state: "review_required", reason: `Source ${field}: ${req.value} (${req.confirmed ? "confirmed source input" : "unconfirmed source input"}). Selection and project suitability require independent review.`,
        sourceRefs: req.evidenceIds,
      }] : [];
    })),
    ...input.pieces.flatMap(p => {
      const connection = requirement("requiredConnectionMethod", p.id);
      const material = requirement("materialRequirement.material", p.id);
      const size = requirement("nominalSize", p.id);
      const product = output.selectedProducts.find(x => x.id === p.productId);
      if (!product) return [];
      const productMaterial = product.connection === "steel_threaded" ? "steel" : product.connection === "cpvc_socket_solvent" ? "cpvc" : null;
      const conflictRefs = [
        ...(connection.confirmed && connection.value && connection.value !== product.connection ? connection.evidenceIds : []),
        ...(material.confirmed && ["steel", "cpvc", "copper"].includes(material.value?.toLowerCase() ?? "") && productMaterial && material.value?.toLowerCase() !== productMaterial ? material.evidenceIds : []),
      ];
      const requiredSize = nominal(size.value), selectedSize = nominal(product.nominalSize);
      return [
        ...(conflictRefs.length ? [{
          id: `MATERIAL-CONFLICT-${p.id}`, subjectIds: [p.id], status: "fail" as const, state: "conflict",
          reason: `Selected ${product.id} (${productMaterial ?? product.connection}) conflicts with the explicit source material or connection requirement; document a design change before using it.`,
          sourceRefs: [...new Set(conflictRefs)],
        }] : []),
        ...(size.confirmed && requiredSize !== null && selectedSize !== null && requiredSize !== selectedSize ? [{
          id: `NOMINAL-SIZE-CONFLICT-${p.id}`, subjectIds: [p.id], status: "fail" as const, state: "conflict",
          reason: `Source nominal size ${size.value} differs from selected product ${product.nominalSize}. Resolve the selection or source requirement before using it.`,
          sourceRefs: size.evidenceIds,
        }] : []),
      ];
    }),
    ...output.cuts.map((c) => ({
      id: `CUT-${c.pieceId}`,
      subjectIds: [c.pieceId],
      status:
        c.cutLength.value === null ? ("unknown" as const) : ("pass" as const),
      state: c.cutLength.value === null ? "input_missing" : "verified",
      reason:
        c.cutLength.value === null
          ? c.cutLength.reasons.join("; ")
          : `Bounded cut arithmetic (${c.cutLength.basis}); not installation approval`,
      sourceRefs: c.takeouts.flatMap((t) => t.sourceIds),
    })),
    {
      id: "ASSEMBLY_CONDITIONS",
      subjectIds: input.pieces.map((p) => p.id),
      status: output.operations.every((o) => o.status === "planned")
        ? "pass"
        : "unknown",
      state: output.operations.some((o) => o.status === "unsupported")
        ? "unsupported"
        : output.operations.some((o) => o.status !== "planned")
          ? "input_missing"
          : "verified",
      reason: output.operations.every((o) => o.status === "planned")
        ? "Supported procedure with supplied access, movement and cure confirmations"
        : "Assembly has unresolved method-specific conditions, geometry or fixed-end closure",
      sourceRefs: output.sources.map((r) => r.id),
    },
    ...project.rules.map((r) => ({
      id: r.ruleId,
      subjectIds: r.subjectIds,
      status: r.status,
      state:
        r.verificationState ??
        (r.status === "unknown" ? "input_missing" : "verified"),
      reason: r.reason,
      sourceRefs: r.sourceRefs.map((x) => x.url),
    })),
    ...project.coverage
      .filter(
        (c) => c.state !== "supported" && ((sfApplicable && c.area === "nfpa13") || c.selected),
      )
      .map((c) => ({
        id: `COVERAGE-${c.id}`,
        subjectIds: [],
        status: "unknown" as const,
        state: c.state,
        reason: c.reason,
        sourceRefs: c.sourceRefs.map((r) => r.url),
      })),
    {
      id: "SUBJECT_SCOPE",
      subjectIds: [],
      status: "unknown",
      state: "input_missing",
      reason:
        "Full sprinkler, support and impact-neighborhood completeness requires project review; an empty enumeration is not a passing check.",
      sourceRefs: [],
    },
    ...heads
      .filter((h) => h.productId !== "TY3231")
      .map((h) => ({
        id: `HEAD-PRODUCT-${h.id}`,
        subjectIds: [h.id],
        status: "unknown" as const,
        state: "unsupported",
        reason: "Selected head product has no executable manufacturer pack",
        sourceRefs: [],
      })),
  ];
  return {
    profile,
    required: checks.map((c) => ({ id: c.id, subjectIds: c.subjectIds })),
    checks,
    project,
    excluded: [
      ...(!sfApplicable ? [{ id: "sf-project-basis", reason: "No confirmed San Francisco jurisdiction; source drawing basis does not establish current applicability." },
        { id: "sf-supports-2025", reason: "San Francisco applicability is unconfirmed or outside this project." },
        { id: "sf-local-change-2025", reason: "San Francisco applicability is unconfirmed or outside this project." }] : []),
      ...(sfApplicable && !adaptation
        ? [
            {
              id: "sf-local-change-2025",
              reason:
                "Baseline drawing preparation has no proposed change or change-specific hydraulic trigger",
            },
          ]
        : []),
      ...(!tyco.length
        ? [
            {
              id: "tyco-tfp171",
              reason:
                "No selected TY3231 head; unknown products remain explicit unsupported requirements",
            },
          ]
        : []),
    ],
  };
}
