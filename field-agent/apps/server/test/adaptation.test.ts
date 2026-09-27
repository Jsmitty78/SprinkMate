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
