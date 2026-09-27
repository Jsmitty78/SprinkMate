import { describe, expect, it } from "vitest";
import { evaluateLocalPlanGeometry } from "../../core/src/local-change-geometry.js";
import { createLocalGeometryPort, deriveCandidatePackages, generateCandidates, pointToMillimetres,
  selectCandidate, socketDatumsToPlanning, toFabricationInput } from "../src/index.js";
import type { FabricationDetailing, FabricationValue } from "../src/index.js";
import { ductFixture, fact, p } from "../fixtures/duct.js";

import { spearsCatalog, deriveWorkPackage, type FabricationOutput } from "../../fabrication/src/index.js";

const engine = createLocalGeometryPort(evaluateLocalPlanGeometry);
const unknown = <T>(): FabricationValue<T> => ({ value: null, status: "unknown", evidenceIds: [], reason: "Not confirmed for this example." });
function detailing(): FabricationDetailing {
  return { baselinePlanId: "approved-plan", sourceDrawing: { id: "synthetic-drawing", revision: "A", approval: "approved" },
    selectedPlanId: null, siteEvidenceIds: ["synthetic-arithmetic-v1"], subassemblyId: "draft-spool", jointLocation: "field", disposition: "new",
    evidence: [{ id: "synthetic-arithmetic-v1", subjectIds: ["a", "b", "head", "duct"], description: "Synthetic geometry; not field observations." }],
    assemblyConditions: { workAreaAccess: unknown(), jointMovement: {}, curePlan: unknown() } };
}

describe("socket datum and mm boundary adapters", () => {
  it("maps H/G socket datums without assuming thread makeup or adding tolerance", () => {
    const mapped = socketDatumsToPlanning(fact({ value: 2.375, unit: "in" }), fact({ value: 1.3125, unit: "in" }));
    expect(mapped.insertionOrThreadMakeup.value!.value).toBeCloseTo(0.0269875);
    expect(2.375 * 0.0254 - mapped.insertionOrThreadMakeup.value!.value).toBeCloseTo(0.0333375);
    const missing = fact({ value: 1.3125, unit: "in" as const }); missing.confirmed = false;
    expect(socketDatumsToPlanning(fact({ value: 2.375, unit: "in" }), missing).insertionOrThreadMakeup.value).toBeNull();
    expect(() => socketDatumsToPlanning(fact({ value: 1, unit: "in" }), fact({ value: 2, unit: "in" }))).toThrow("Socket face");
  });

  it("converts signed coordinates and tie-in datums to mm while retaining proposal status and lineage", () => {
    expect(pointToMillimetres(p(-1.4, 2, 0))).toEqual({ x: -1400, y: 2000, z: 0, unit: "mm", frameId: "room-frame" });
    const input = ductFixture(), set = generateCandidates(input, engine);
    const packages = deriveCandidatePackages(input, set, request => toFabricationInput(request, detailing()));
    const dto = packages.candidates[0]!.workPackage;
    expect(dto.frame.lengthUnit).toBe("mm");
    expect(dto.nodes.every(n => n.position.value!.unit === "mm")).toBe(true);
    expect(dto.nodes.find(n => n.id === "b")!.position.value!.x).toBe(10000);
    expect(dto.nodes.find(n => n.id === "a")!.netCutOffset!.value!.value).toBe(50);
    expect(dto.nodes.filter(n => n.datum === "fitting_center").every(n => n.position.status === "proposed")).toBe(true);
    expect(dto.pieces.every(piece => piece.sourceSegmentIds[0] === "pipe")).toBe(true);
    expect(dto.accessories[0]!.id).toBe("head");
    expect(dto.selectedPlanId).toBeNull();
    expect(dto.assemblyConditions.workAreaAccess.value).toBeNull();
  });
});

describe("CPVC fabrication integration", () => {
  it("generates from a drawing plus duct, derives all plans through one port, then derives explicit selection at the next revision", () => {
    const input = ductFixture(), catalog = spearsCatalog(input.configVersion);
    const pipe = catalog.products.find(p => p.kind === "pipe")!;
    const elbow = catalog.products.find(p => p.kind === "elbow_90")!;
    input.baseline.segments[0]!.productId = pipe.id;
    input.baseline.segments[0]!.outsideDiameter = { ...fact(pipe.outsideDiameter), evidenceIds: pipe.sourceIds };
    input.product = {
      compatibility: { ...fact({ pipeProductId: pipe.id, elbowProductId: elbow.id, connectionMethod: "cpvc_socket_solvent" }), evidenceIds: elbow.sourceIds },
      ...socketDatumsToPlanning({ ...fact(elbow.centerToFace), evidenceIds: elbow.sourceIds },
        { ...fact(elbow.centerToSocketBottom), evidenceIds: elbow.sourceIds }),
    };
    const before = structuredClone(input);
    const set = generateCandidates(input, engine);
    expect(set.candidates).toHaveLength(2);
    const derive = (request: Parameters<typeof toFabricationInput>[0]) => deriveWorkPackage(toFabricationInput(request, detailing()), catalog);
    const packages = deriveCandidatePackages(input, set, derive);
    const totals = (output: FabricationOutput) => output.cuts.reduce((n, cut) => n + cut.cutLength.value!, 0);
    // Hand arithmetic: H=0.060325; G=0.0333375; insertion=0.0269875.
    // Eight elbow ports + two 0.05 tie-in datums -> total takeout 0.3667 m.
    expect(totals(packages.baseline)).toBeCloseTo(9.9);
    expect(totals(packages.candidates[0]!.workPackage)).toBeCloseTo(12.4333);
    expect(totals(packages.candidates[1]!.workPackage)).toBeCloseTo(12.9333);
    for (let i = 0; i < 2; i++) {
      const output = packages.candidates[i]!.workPackage;
      expect(totals(output)).toBeCloseTo(set.candidates[i]!.geometry.totalCutLengthM!);
      expect(output.operations.length).toBeGreaterThan(0);
      expect(output.operations.some(operation => operation.status === "needs_confirmation")).toBe(true);
      expect(output.cuts.some(cut => cut.centerline.basis === "proposed_inputs")).toBe(true);
      expect(output.constructionApproval).toBe("not_assessed");
    }
    const selected = selectCandidate(set, set.candidates[0]!.id, input);
    expect(selected.ok).toBe(true);
    if (!selected.ok) throw new Error("Fixture selection failed");
    const selectedInput = toFabricationInput({ ...input, inputRevision: 8, plan: selected.candidate.plan, status: "proposed" },
      { ...detailing(), selectedPlanId: selected.candidate.id });
    const selectedOutput = deriveWorkPackage(selectedInput, catalog);
    expect(selectedOutput.inputRevision).toBe(8);
    expect(selectedOutput.selectedPlanId).toBe(selected.candidate.id);
    expect(totals(selectedOutput)).toBeCloseTo(12.4333);
    expect(input).toEqual(before);
  });
});
