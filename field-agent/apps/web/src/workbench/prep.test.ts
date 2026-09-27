import { expect, it } from "vitest";
import type { PackagePlan, WorkPackageSnapshot } from "@field-agent/core";
import { ELBOW, PIPE, requirements } from "./model.js";

const port = (id: string, x: number) => ({ id, position: { x, y: 0, z: 0 }, unknownReason: null });
const plan = (pipe: string | null, elbow: string | null): PackagePlan => ({
  id: "baseline", coordinateFrame: { id: "f", lengthUnit: "mm", axes: "right_handed_z_up" }, confirmation: "confirmed",
  entities: [
    { id: "p1", kind: "pipe", productId: pipe, ports: [port("start", 0), port("end", 1000)] },
    { id: "f1", kind: "fitting", productId: elbow, ports: [port("in", 1000), port("out", 1000)] },
    { id: "h1", kind: "head", productId: null, ports: [port("center", 0)] },
  ],
  connections: [],
});
const snap = (p: PackagePlan, detailing: WorkPackageSnapshot["detailing"] = []) => ({
  intent: "prepare_from_drawing", detailing, siteFacts: [], baselinePlan: p, sourceDrawing: null, changeRequest: null,
  scope: { coordinateFrame: p.coordinateFrame, includedEntityIds: ["p1", "f1"], excludedEntityIds: ["h1"], tieInEntityIds: [] },
}) as unknown as WorkPackageSnapshot;
const requiredIds = (s: WorkPackageSnapshot) => requirements(s).map(r => r.id);

it("asks cement cure and joint movement only for the solvent-cement catalog", () => {
  expect(requiredIds(snap(plan(PIPE, ELBOW)))).toEqual(expect.arrayContaining(["curePlan", "movement.in.f1"]));
  const unselected = requiredIds(snap(plan(null, null)));
  expect(unselected).not.toContain("curePlan");
  expect(unselected.some(l => l.startsWith("movement."))).toBe(false);
});

it("stops asking San Francisco basis questions for another jurisdiction", () => {
  const other = snap(plan(null, null), [{ id: "j", field: "jurisdiction", value: "other", subjectIds: [], unit: null, unknownReason: null, confirmation: "confirmed", context: "detailing", source: { description: "Idaho", assetId: null, page: null } }]);
  const project = requirements(other).filter(r => r.group === "Project");
  expect(project.map(r => [r.label, r.done])).toEqual([["Jurisdiction", true]]);
});
