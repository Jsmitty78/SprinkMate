import type { GeometryPort, GeometryResult } from "../src/index.js";
import { EXPECTED } from "../fixtures/duct.js";

/** Recorded mathematical responses for the designated fixture only, not a second engine. */
export const fixturePort: GeometryPort = ({ plan, proposedNodeIds }) => {
  const expected = plan.id.endsWith("detour%3Ay%2B") ? EXPECTED["detour:y+"]
    : plan.id.endsWith("detour%3Ay-") ? EXPECTED["detour:y-"] : null;
  if (proposedNodeIds.length && !expected) throw new Error("Fixture port has no recorded result for this template.");
  const result: GeometryResult = {
    planId: plan.id, state: "verified", segmentCount: plan.segments.length, elbowCount: plan.fittings.length,
    totalCenterlineLengthM: expected?.centerline ?? 10, totalCutLengthM: expected?.cut ?? 9.9,
    missingInputs: [], unsupported: [],
    segments: plan.segments.map((segment, i) => ({ segmentId: segment.id, centerlineLengthM: expected?.lengths[i] ?? 10,
      cutLengthM: expected?.cuts[i] ?? 9.9, outsideDiameterM: 0.2, state: "verified", missingInputs: [] })),
    ductClearances: plan.segments.flatMap(segment => plan.ducts.map(duct => ({ segmentId: segment.id, ductId: duct.id,
      state: expected ? "clear" : "collision", marginM: expected ? 0.9 : -0.1, missingInputs: [] }))),
  };
  return { ok: true, result };
};
