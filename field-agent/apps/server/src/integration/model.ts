import { createHash } from "node:crypto";
import {
  localBoxToPlan,
  siteFrameFor,
  SITE_FRAME_FIELD,
  toMillimetres,
  type PackagePlan,
  type WorkPackageSnapshot,
} from "@field-agent/core";
import {
  spearsCatalog,
  toLocalPlanGeometry,
  toPlanningProduct,
  UNSELECTED_PRODUCT,
  type FabricationInput,
  type Value,
  type Length,
  type Point3,
} from "@field-agent/fabrication";
import {
  type Plan,
  type GenerateInput,
  type Fact,
  type Box,
} from "@field-agent/planning";

export const safe = (id: string) =>
  "i-" + createHash("sha256").update(id).digest("hex").slice(0, 24);
export const known = <T>(
  value: T,
  evidenceIds: string[] = ["catalog"],
): Fact<T> => ({ value, confirmed: true, source: "manual", evidenceIds });
export const unknown = <T>(): Fact<T> => ({
  value: null,
  confirmed: false,
  source: "manual",
  evidenceIds: [],
});
export function savedFact(
  s: WorkPackageSnapshot,
  field: string,
  subject?: string,
) {
  const matches = [...s.detailing, ...s.siteFacts].filter(
    (f) =>
      f.field === field &&
      (subject ? f.subjectIds.includes(subject) : f.subjectIds.length === 0),
  );
  if (matches.length > 1) throw new Error(`Ambiguous fact: ${field}`);
  return matches[0];
}
/** How a missing input reads in a reason; other fields keep their name. */
const FIELD_TEXT: Record<string, string> = {
  netCutOffset: "the net cut offset at the tie-in",
  workAreaAccess: "work-area access",
  curePlan: "the set and cure plan",
};
export function value<T extends string | number | boolean>(
  s: WorkPackageSnapshot,
  field: string,
  subject?: string,
): Value<T> {
  const f = savedFact(s, field, subject);
  return {
    value: (f?.value ?? null) as T | null,
    status:
      f?.confirmation === "confirmed" && f.value !== null
        ? "confirmed"
        : "unknown",
    evidenceIds: f ? [f.id] : [],
    reason: f?.unknownReason ?? `Confirm ${FIELD_TEXT[field] ?? field}`,
  };
}
export function fact<T extends string | number | boolean>(
  s: WorkPackageSnapshot,
  field: string,
  subject?: string,
): Fact<T> {
  const v = value<T>(s, field, subject);
  return {
    value: v.value,
    confirmed: v.status === "confirmed",
    evidenceIds: v.evidenceIds,
    source: "manual",
  };
}
function lengthValue(
  s: WorkPackageSnapshot,
  field: string,
  subject: string,
): Value<Length> {
  const v = value<number>(s, field, subject),
    f = savedFact(s, field, subject);
  const units = ["m", "mm", "ft", "in"];
  return {
    ...v,
    value:
      typeof v.value === "number" && units.includes(f?.unit ?? "")
        ? { value: v.value, unit: f!.unit as Length["unit"] }
        : null,
  };
}

/** The saved graph owns connectivity. Coordinates alone never join two parts. */
export function fabricationInput(
  s: WorkPackageSnapshot,
  plan: PackagePlan,
): FabricationInput {
  if (!s.sourceDrawing || !s.scope || !s.baselinePlan)
    throw new Error("Drawing, scope and baseline are required");
  // Entities outside the scope are retained context (heads, adjacent pipe): kept in the plan and
  // shown, never detailed, counted or connected. A connection into the context would be a guess.
  const context = new Set(s.scope.excludedEntityIds);
  if (
    plan.connections.some((c) =>
      [c.from, c.to].some((e) => context.has(e.entityId)),
    )
  )
    throw new Error(
      "Retained context is connected to the work; include it in the scope or disconnect it",
    );
  const pipes = plan.entities.filter(
    (e) => e.kind === "pipe" && !context.has(e.id),
  );
  if (!pipes.length)
    throw new Error("An empty pipe scope is not a work package");
  const evidence = [...s.detailing, ...s.siteFacts].map((f) => ({
    id: f.id,
    subjectIds: [...f.subjectIds, ...(f.subjectIds.length ? [] : [plan.id])],
    description: f.source.description,
  }));
  const drawingEvidence = `drawing-${s.sourceDrawing.assetId}`;
  const nodes: FabricationInput["nodes"] = [],
    pieces: FabricationInput["pieces"] = [],
    fittings: FabricationInput["fittings"] = [];
  const confirmed = plan.confirmation === "confirmed";
  const pos = (
    p: { x: number; y: number; z: number } | null,
    nodeId: string,
  ): Value<Point3> => ({
    value: p ? { ...p, unit: "mm", frameId: plan.coordinateFrame.id } : null,
    status: p ? (confirmed ? "confirmed" : "proposed") : "unknown",
    evidenceIds: p && confirmed ? [drawingEvidence] : [],
    reason: p ? null : `Missing position ${nodeId}`,
  });
  const connected = new Map<string, { entityId: string; portId: string }>();
  for (const c of plan.connections) {
    for (const [a, b] of [
      [c.from, c.to],
      [c.to, c.from],
    ]) {
      const key = `${a.entityId}/${a.portId}`;
      if (connected.has(key)) throw new Error(`Multiple connections at ${key}`);
      connected.set(key, b);
    }
  }
  for (const p of pipes) {
    if (p.ports.length !== 2)
      throw new Error(`Pipe ${p.id} requires two ordered ports`);
    const ends = p.ports.map((port, i) => {
      const end = i === 0 ? "start" : "end";
      const c = connected.get(`${p.id}/${port.id}`),
        other = c && plan.entities.find((e) => e.id === c.entityId);
      if (other && !["fitting", "tie_in"].includes(other.kind))
        throw new Error("Pipe endpoints require a fitting or tie-in");
      const otherPort = other?.ports.find((p) => p.id === c!.portId);
      if (
        otherPort?.position &&
        port.position &&
        JSON.stringify(otherPort.position) !== JSON.stringify(port.position)
      )
        throw new Error("Connected ports disagree on the centerline position");
      const nodeId = other ? `node-${other.id}` : `node-${p.id}-${end}`;
      const datum = value<string>(s, `datum.${end}`, p.id);
      const physical =
        !other &&
        datum.status === "confirmed" &&
        datum.value === "physical_pipe_end";
      if (!c && !physical)
        throw new Error(
          `Unconnected endpoint ${p.id}/${end}; explicitly detail an open end or connection`,
        );
      if (!nodes.some((n) => n.id === nodeId)) {
        const offset = other
          ? lengthValue(s, "netCutOffset", other.id)
          : {
              value: null,
              status: "unknown" as const,
              evidenceIds: [],
              reason: "Unknown endpoint datum",
            };
        nodes.push({
          id: nodeId,
          datum:
            other?.kind === "fitting"
              ? "fitting_center"
              : physical
                ? "physical_pipe_end"
                : "tie_in",
          position: pos(port.position, nodeId),
          ...(other?.kind === "tie_in" ? { netCutOffset: offset } : {}),
        });
        if (other)
          for (const e of evidence.filter((e) =>
            e.subjectIds.includes(other.id),
          ))
            e.subjectIds.push(nodeId);
      }
      return nodeId;
    });
    pieces.push({
      id: p.id,
      sourceSegmentIds: [p.id],
      productId: p.productId ?? UNSELECTED_PRODUCT,
      startNodeId: ends[0],
      endNodeId: ends[1],
      subassemblyId: "run",
      disposition: "new",
    });
  }
  // Order a single run without guessing connections or reversing physical endpoint labels.
  const degree = (id: string) =>
    pieces.filter((p) => p.startNodeId === id || p.endNodeId === id).length;
  let cursor = nodes.find((n) => degree(n.id) === 1)?.id;
  const ordered: typeof pieces = [],
    remaining = [...pieces];
  while (cursor && remaining.length) {
    const ix = remaining.findIndex(
      (p) => p.startNodeId === cursor || p.endNodeId === cursor,
    );
    if (ix < 0) break;
    const p = remaining.splice(ix, 1)[0];
    ordered.push(p);
    cursor = p.startNodeId === cursor ? p.endNodeId : p.startNodeId;
  }
  if (remaining.length)
    throw new Error("Disconnected or closed route is unsupported");
  for (const f of plan.entities.filter((e) => e.kind === "fitting" && !context.has(e.id))) {
    const ports = f.ports.map((port) => {
      const c = connected.get(`${f.id}/${port.id}`),
        piece = pieces.find((p) => p.id === c?.entityId);
      const pipe = pipes.find((p) => p.id === piece?.id);
      if (!piece || !pipe) throw new Error("Unconnected fitting port");
      return {
        id: port.id,
        pieceId: piece.id,
        end:
          pipe.ports[0].id === c!.portId
            ? ("start" as const)
            : ("end" as const),
        location: "field" as const,
      };
    });
    fittings.push({
      id: f.id,
      sourceEntityIds: [f.id],
      productId: f.productId ?? UNSELECTED_PRODUCT,
      nodeId: `node-${f.id}`,
      ports,
    });
  }
  evidence.push({
    id: drawingEvidence,
    subjectIds: nodes.map((n) => n.id),
    description: `Explicit ${plan.confirmation} structured drawing dimensions: ${s.sourceDrawing.drawingId} ${s.sourceDrawing.revision}`,
  });
  const jointMovement: Record<string, Value<boolean>> = {};
  for (const f of fittings)
    for (const port of f.ports) {
      const id = `${f.id}/${port.id}`;
      jointMovement[id] = value<boolean>(s, `movement.${port.id}`, f.id);
      for (const e of evidence.filter((e) => e.subjectIds.includes(f.id)))
        e.subjectIds.push(id);
    }
  return {
    projectId: s.projectId,
    packageId: s.id,
    planId: plan.id,
    baselinePlanId: s.baselinePlan.id,
    intent: s.intent,
    inputRevision: s.inputRevision,
    configVersion: s.configVersion,
    sourceDrawing: {
      id: s.sourceDrawing.drawingId,
      revision: s.sourceDrawing.revision,
      approval:
        s.sourceDrawing.approval === "approved" ? "approved" : "not_approved",
    },
    planRole: plan.id === s.baselinePlan.id ? "baseline" : "candidate",
    selectedPlanId: s.selectedPlan?.id ?? null,
    siteEvidenceIds: s.siteFacts.map((f) => f.id),
    frame: { id: plan.coordinateFrame.id, lengthUnit: "mm" },
    nodes,
    pieces: ordered,
    fittings,
    evidence,
    accessories: plan.entities
      .filter(
        (e) =>
          ["head", "support", "unsupported"].includes(e.kind) &&
          !context.has(e.id),
      )
      .map((e) => ({
        id: e.id,
        kind:
          e.kind === "head"
            ? "head"
            : e.kind === "support"
              ? "support"
              : "other",
        productId: e.productId,
        quantity: {
          value: 1,
          status: "proposed",
          evidenceIds: [],
          reason: "Counted from the saved model",
        },
        attachedPieceIds: [],
        reason: "Installation outside the supported catalog",
      })),
    assemblyConditions: {
      workAreaAccess: value<boolean>(s, "workAreaAccess"),
      curePlan: value<string>(s, "curePlan"),
      jointMovement,
    },
  };
}

export function planningPlan(
  s: WorkPackageSnapshot,
  input: FabricationInput,
): Plan {
  const catalog = spearsCatalog(s.configVersion),
    geometry = toLocalPlanGeometry(input, catalog);
  return {
    ...geometry,
    segments: geometry.segments.map((seg) => ({
      ...seg,
      productId: input.pieces.find((p) => p.id === seg.id)!.productId,
      cutEndDatumAtStart: fact(s, "datum.start", seg.id),
      cutEndDatumAtEnd: fact(s, "datum.end", seg.id),
      outsideDiameter: seg.outsideDiameter.value
        ? seg.outsideDiameter
        : enteredDiameter(s, seg.id) ?? seg.outsideDiameter,
    })),
    fittings: geometry.fittings.map((f) => ({
      ...f,
      productId: input.fittings.find((p) => p.id === f.id)!.productId,
    })),
    heads: [],
    ducts: [],
  };
}
/** A pipe OD the user entered for a piece with no catalog product. Never inferred from nominal size. */
function enteredDiameter(s: WorkPackageSnapshot, pieceId: string) {
  const f = savedFact(s, "pipeOutsideDiameter", pieceId);
  return f?.confirmation === "confirmed" &&
    typeof f.value === "number" &&
    f.value > 0 &&
    ["mm", "m", "in", "ft"].includes(f.unit ?? "")
    ? known({ value: f.value, unit: f.unit as Length["unit"] }, [f.id])
    : null;
}
/**
 * A confirmed six-face box in the plan frame. With a confirmed `siteFrame` fact the faces were
 * entered along a span (local X, Y, Z) in any length unit, and are transformed here; otherwise they
 * are plan-frame millimetres. Anything missing, unconfirmed or inverted is unknown.
 */
export function boxFact(s: WorkPackageSnapshot, prefix: string): Fact<Box> {
  const fields = ["min.x", "min.y", "min.z", "max.x", "max.y", "max.z"];
  const fs = fields.map((k) => savedFact(s, `${prefix}.${k}`));
  const frameFacts = [...s.detailing, ...s.siteFacts].filter(
    (f) => f.field === SITE_FRAME_FIELD,
  );
  if (frameFacts.length > 1) throw new Error("Ambiguous fact: siteFrame");
  const frameFact = frameFacts[0];
  const mm = fs.map((f) =>
    f && f.confirmation === "confirmed" && typeof f.value === "number"
      ? toMillimetres(f.value, frameFact ? f.unit : f.unit === "mm" ? "mm" : null)
      : null,
  );
  if (mm.some((v) => v === null)) return unknown();
  const [a, b] = [0, 3].map((o) => ({ x: mm[o]!, y: mm[o + 1]!, z: mm[o + 2]! }));
  if (!(a.x < b.x && a.y < b.y && a.z < b.z)) return unknown();
  let box = { min: a, max: b };
  const evidence = fs.map((f) => f!.id);
  if (frameFact) {
    if (
      frameFact.confirmation !== "confirmed" ||
      frameFact.subjectIds.length !== 1 ||
      (frameFact.value !== "left" && frameFact.value !== "right")
    )
      return unknown();
    const frame = siteFrameFor(s.baselinePlan!, frameFact.subjectIds[0], frameFact.value);
    if ("reason" in frame) return unknown();
    const planBox = localBoxToPlan(frame, a, b);
    if ("reason" in planBox) return unknown();
    box = planBox;
    evidence.push(frameFact.id);
  }
  const point = (p: { x: number; y: number; z: number }) => ({
    ...p,
    unit: "mm" as const,
    frameId: s.baselinePlan!.coordinateFrame.id,
  });
  return known(
    { kind: "axis_aligned_box", min: point(box.min), max: point(box.max) },
    evidence,
  );
}
export function generationInput(s: WorkPackageSnapshot): GenerateInput {
  if (
    s.baselinePlan?.entities.some((e) =>
      ["head", "support", "unsupported"].includes(e.kind),
    )
  )
    throw new Error(
      "Candidate generation is limited to an isolated span; protected heads/supports require an explicit impact adapter",
    );
  const input = fabricationInput(s, s.baselinePlan!),
    baseline = planningPlan(s, input);
  baseline.ducts = [
    { id: "measured-duct", roomId: "work-area", geometry: boxFact(s, "duct") },
  ];
  const clearance = savedFact(s, "requiredPipeClearance");
  return {
    projectId: s.projectId,
    packageId: s.id,
    inputRevision: s.inputRevision,
    configVersion: s.configVersion,
    intent: "adapt_to_site",
    baseline,
    targetSegmentId: s.changeRequest?.affectedEntityIds[0] ?? "",
    fixedConnectionNodeIds: [
      input.pieces[0].startNodeId,
      input.pieces.at(-1)!.endNodeId,
    ],
    protectedSegmentIds: [],
    workEnvelope: boxFact(s, "workEnvelope"),
    requiredPipeClearance:
      clearance?.confirmation === "confirmed" &&
      typeof clearance.value === "number" &&
      clearance.unit === "mm"
        ? known({ value: clearance.value, unit: "mm" }, [clearance.id])
        : unknown(),
    product: toPlanningProduct(spearsCatalog(s.configVersion)),
  };
}
/** Stable API-safe identities, with all structural references transformed together. */
export function apiCandidate(plan: Plan): Plan {
  const ids = [
    plan.id,
    ...plan.nodes.map((n) => n.id),
    ...plan.segments.map((p) => p.id),
    ...plan.fittings.map((f) => f.id),
  ];
  const map = new Map(
    ids
      .filter((id) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id))
      .map((id) => [id, safe(id)]),
  );
  return JSON.parse(
    JSON.stringify(plan, (_key, v) =>
      typeof v === "string" ? (map.get(v) ?? v) : v,
    ),
  );
}
export function packagePlan(plan: Plan, baseline: PackagePlan): PackagePlan {
  const point = (nodeId: string) => {
    const p = plan.nodes.find((n) => n.id === nodeId)!.position.value;
    if (!p) return null;
    const scale = { m: 1000, mm: 1, ft: 304.8, in: 25.4 }[p.unit];
    return { x: p.x * scale, y: p.y * scale, z: p.z * scale };
  };
  const entities: PackagePlan["entities"] = plan.segments.map((p) => ({
    id: p.id,
    kind: "pipe",
    productId: p.productId ?? null,
    ports: [
      { id: "start", position: point(p.startNodeId), unknownReason: null },
      { id: "end", position: point(p.endNodeId), unknownReason: null },
    ],
  }));
  const connections: PackagePlan["connections"] = [];
  for (const f of plan.fittings) {
    entities.push({
      id: f.id,
      kind: "fitting",
      productId: f.productId ?? null,
      ports: f.ports.map((p, i) => ({
        id: `port-${i}`,
        position: point(p.nodeId),
        unknownReason: null,
      })),
    });
    f.ports.forEach((p, i) =>
      connections.push({
        id: safe(`${f.id}/${i}`),
        from: { entityId: f.id, portId: `port-${i}` },
        to: { entityId: p.segmentId, portId: p.endpoint },
      }),
    );
  }
  for (const n of plan.nodes.filter((n) => n.kind === "tie_in")) {
    const entity = baseline.entities.find((e) => `node-${e.id}` === n.id);
    if (!entity) throw new Error("Protected tie-in disappeared");
    entities.push(structuredClone(entity));
    for (const p of plan.segments)
      for (const end of ["start", "end"] as const)
        if (p[`${end}NodeId`] === n.id)
          connections.push({
            id: safe(`${n.id}/${p.id}`),
            from: { entityId: entity.id, portId: entity.ports[0].id },
            to: { entityId: p.id, portId: end },
          });
  }
  entities.push(
    ...baseline.entities
      .filter((e) => ["head", "support", "unsupported"].includes(e.kind))
      .map((e) => structuredClone(e)),
  );
  return {
    id: plan.id,
    confirmation: "proposed",
    coordinateFrame: baseline.coordinateFrame,
    entities,
    connections,
  };
}
