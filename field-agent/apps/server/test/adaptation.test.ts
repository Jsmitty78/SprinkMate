import { fs01Adaptation } from "./fixtures/fs01-adaptation.js";
import { expect, it } from "vitest";
import { adaptationInterval, adaptationFrame, evaluateLocalPlanGeometry, type WorkPackageSnapshot } from "@field-agent/core";
import { generateCandidates, createLocalGeometryPort } from "@field-agent/planning";
import { generationInput, candidatePackage, apiCandidate } from "../src/integration/model.js";
import { adaptationFixture as fixture } from "./fixtures/adaptation-package.js";

const search = (s: WorkPackageSnapshot) => generateCandidates(generationInput(s), createLocalGeometryPort(evaluateLocalPlanGeometry));

it("extracts an eligible leg, preserves an L-shaped remainder and heads, and maps rotated output back", () => {
  for (const angle of [0, 90, 31]) {
    const s = fixture(angle, true), original = structuredClone(s.baselinePlan), result = search(s);
    expect(result.candidates).toHaveLength(2);
    // Independent midpoint-lane arithmetic: +1.4m/-1.65m offsets => +2.8m/+3.3m.
    expect(result.candidates[0].comparison.centerlineLengthDeltaM).toBeCloseTo(2.8, 10);
    expect(result.candidates[1].comparison.centerlineLengthDeltaM).toBeCloseTo(3.3, 10);
    for (const c of result.candidates) {
      expect(c.comparison.addedFittings).toBe(4);
      const restored = candidatePackage(apiCandidate(c.plan), s);
      expect(restored.entities.filter(e => !["pipe"].includes(e.id) && original!.entities.some(o => o.id === e.id))).toEqual(original!.entities.filter(e => e.id !== "pipe"));
      expect(restored.connections.filter(c => ["remaining-joint", "terminal-joint"].includes(c.id))).toEqual(original!.connections.filter(c => ["remaining-joint", "terminal-joint"].includes(c.id)));
      expect(restored.entities.find(e => e.id === "pipe")!.ports[0].position).toEqual(original!.entities.find(e => e.id === "pipe")!.ports[0].position);
      expect(restored.entities.filter(e => e.kind === "pipe")).toHaveLength(6); // 5 active spans + retained leg, not physical closure count.
    }
    expect(s.baselinePlan).toEqual(original);
  }
});

it("rejects interior context, ambiguous changes, incomplete frames and moving an endpoint", () => {
  const s = fixture();
  s.detailing = s.detailing.filter(f => f.field !== "adaptationFrame.yaw");
  expect(() => adaptationInterval(s)).toThrow("Confirm all adaptation frame");
  const branch = fixture();
  branch.baselinePlan!.entities.push({ id: "interior-head", kind: "head", productId: null, ports: [{ id: "p", position: adaptationFrame(branch).toDrawing({ x: 5000, y: 0, z: 0 }), unknownReason: null }] });
  expect(() => adaptationInterval(branch)).toThrow("Interior protected context");
  const multiple = fixture(); multiple.changeRequest!.affectedEntityIds.push("remaining-leg");
  expect(() => adaptationInterval(multiple)).toThrow("exactly one");
  const moved = fixture(); const c = apiCandidate(search(moved).candidates[0].plan);
  c.nodes.find(n => n.kind === "tie_in")!.position.value!.x += 1;
  expect(() => candidatePackage(c, moved)).toThrow("moved a protected endpoint");
});

it("preserves missing-height and bounded no-route states instead of fabricating alternatives", () => {
  const missing = fixture(); missing.detailing = missing.detailing.filter(f => f.field !== "duct.max.z");
  expect(search(missing).state).toBe("input_missing");
  const narrow = fixture();
  for (const f of narrow.detailing) if (f.field === "workEnvelope.min.y") f.value = -400; else if (f.field === "workEnvelope.max.y") f.value = 400;
  const result = search(narrow);
  expect(result.candidates).toHaveLength(0);
  expect(result.state).toBe("no_candidate");
  expect(result.reasons[0].message).toContain("not proof of global infeasibility");
});

it("generates steel routes for frozen FS-01 P27 with fictional site bounds and preserves the entire source context", () => {
  const s = { ...fixture(), ...fs01Adaptation("asset"), projectId: "idaho-source-test" };
  const result = search(s);
  expect(result.candidates).toHaveLength(2);
  expect(result.candidates.map(c => c.comparison.addedFittings)).toEqual([4, 4]);
  // Midpoint between expanded obstacle Y=380.1625 and pipe-radius-reduced bounds:
  // +775 and -875 mm lanes => +1550 / +1750 mm, independent of the #1 oracle routes.
  expect(result.candidates[0].comparison.centerlineLengthDeltaM).toBeCloseTo(1.55, 9);
  expect(result.candidates[1].comparison.centerlineLengthDeltaM).toBeCloseTo(1.75, 9);
  for (const c of result.candidates) {
    const candidate = candidatePackage(apiCandidate(c.plan), s);
    for (const entity of s.baselinePlan!.entities.filter(e => e.id !== "P27")) expect(candidate.entities.find(e => e.id === entity.id)).toEqual(entity);
    expect(candidate.connections.filter(c => c.id.startsWith("P28-") || c.id.startsWith("P30-"))).toEqual(s.baselinePlan!.connections.filter(c => c.id.startsWith("P28-") || c.id.startsWith("P30-")));
  }
  expect(s.detailing.some(f => f.field === "jurisdiction")).toBe(false);
  expect(result.candidates.every(c => c.geometry.totalCutLengthM === null)).toBe(true);
});
