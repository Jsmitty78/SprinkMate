import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PackagePlan, PackageInputs } from "@field-agent/core";
import { FieldService } from "../src/service.js";
import { createApp } from "../src/api.js";
import { WorkPackageStore } from "../src/work-packages/store.js";
import { createIntegratedServices } from "../src/integration/runtime.js";

// FS-01 P27 as the browser intake saves it: PDF points (Y down) mapped to a right-handed plan frame,
// N27 (12544.2133, 9620.5040) and N28 (12544.2133, 12668.1653) mm in the crop frame; heads H1/H3 and the
// adjacent pipes are unconnected context outside the scope.
const MM_PER_PT = 33.8666666667;
const frame = { id: "drawing-plan", lengthUnit: "mm" as const, axes: "right_handed_z_up" as const };
const at = (x: number, y: number) => ({ x, y: -y, z: 0 });
const N27 = at(12544.2133, 9620.504), N28 = at(12544.2133, 12668.1653);
const port = (id: string, position: { x: number; y: number; z: number }) => ({ id, position, unknownReason: null });
export function fs01Trace(): Pick<PackageInputs, "baselinePlan" | "scope"> {
  const plan: PackagePlan = {
    id: "baseline", coordinateFrame: frame, confirmation: "confirmed",
    entities: [
      { id: "p1", kind: "pipe", productId: null, ports: [port("start", N27), port("end", N28)] },
      { id: "t1", kind: "tie_in", productId: null, ports: [port("socket", N27)] },
      { id: "t2", kind: "tie_in", productId: null, ports: [port("socket", N28)] },
      { id: "h1", kind: "head", productId: null, ports: [port("center", N27)] },
      { id: "h2", kind: "head", productId: null, ports: [port("center", N28)] },
      { id: "c1", kind: "pipe", productId: null, ports: [port("start", at(12544.2133, 9000)), port("end", at(12544.2133, 8000))] },
    ],
    connections: [
      { id: "t1-joint", from: { entityId: "p1", portId: "start" }, to: { entityId: "t1", portId: "socket" } },
      { id: "t2-joint", from: { entityId: "p1", portId: "end" }, to: { entityId: "t2", portId: "socket" } },
    ],
  };
  return { baselinePlan: plan, scope: { coordinateFrame: frame, includedEntityIds: ["p1", "t1", "t2"], excludedEntityIds: ["h1", "h2", "c1"], tieInEntityIds: ["t1", "t2"] } };
}
export const fs01View = {
  sheetUnit: "pdf_pt" as const, workArea: { x: 300, y: 230, width: 160, height: 190 },
  calibration: { method: "printed_scale" as const, a: null, b: null, realDistance: null, printedScale: "1/8 in = 1 ft", reference: "Printed scale on FS-01", pointUncertaintyMm: 5 },
  frame: { origin: { x: 0, y: 0 }, rotationDeg: 0 }, derivativeOf: "FM32361 FS-01 PDF crop (test copy)",
};

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(f => f()));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "intake-"));
  const field = new FieldService(dir);
  const t = createIntegratedServices(new WorkPackageStore(field.store.db), dir);
  const app = createApp(field, { token: "intake-test-token", workPackages: t.packages, workPackageExports: t.exports, workPackageDetails: t.details });
  cleanup.push(() => { t.packages.close(); field.store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { ...t, app };
}
async function drawing(t: ReturnType<typeof setup>, intent: "prepare_from_drawing" | "adapt_to_site" = "prepare_from_drawing") {
  const s = t.packages.create({ projectId: "fs01", title: "P27", intent });
  const asset = await t.packages.upload(s.id, Buffer.from("%PDF-1.4\nfixture"), "application/pdf", "fs01.pdf");
  return { id: s.id, sourceDrawing: { assetId: asset.id, drawingId: "FS-01", revision: "2023-06-05", page: 1, approval: "unreviewed" as const,
    scale: { value: MM_PER_PT, unit: "mm/pixel", reason: null, basis: "confirmed_inputs" as const }, view: fs01View } };
}
async function run(t: ReturnType<typeof setup>, id: string) {
  const s = t.packages.get(id);
  const r = await t.app.request(`/api/work-packages/${id}/runs`, { method: "POST", headers: { Authorization: "Bearer intake-test-token", "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: s.inputRevision, goal: s.intent }) });
  expect(r.status).toBe(202);
  for (let i = 0; i < 300; i++) { await new Promise(r => setTimeout(r, 5)); const cur = t.packages.get(id); if (cur.run?.status !== "running") return cur; }
  throw new Error("run did not stop");
}

it("saves the sheet view and its calibration with the drawing and reloads them", async () => {
  const t = setup(), d = await drawing(t);
  const saved = t.packages.edit(d.id, { expectedRevision: 1, patch: { sourceDrawing: d.sourceDrawing, ...fs01Trace() } });
  expect(t.packages.get(d.id).sourceDrawing?.view).toEqual(fs01View);
  expect(saved.sourceDrawing?.approval).toBe("unreviewed");
});

it("rejects a two-point scale that does not match its own calibration", async () => {
  const t = setup(), d = await drawing(t);
  const view = { ...fs01View, calibration: { method: "two_point" as const, a: { x: 0, y: 0 }, b: { x: 90, y: 0 }, realDistance: { value: 10, unit: "ft" as const }, printedScale: null, reference: "10 ft grid", pointUncertaintyMm: null } };
  expect(() => t.packages.edit(d.id, { expectedRevision: 1, patch: { sourceDrawing: { ...d.sourceDrawing, scale: { ...d.sourceDrawing.scale, value: 30 }, view } } })).toThrow("scale_calibration_mismatch");
  const ok = t.packages.edit(d.id, { expectedRevision: 1, patch: { sourceDrawing: { ...d.sourceDrawing, scale: { ...d.sourceDrawing.scale, value: 3048 / 90 }, view } } });
  expect(ok.sourceDrawing?.view?.calibration?.realDistance).toEqual({ value: 10, unit: "ft" });
});

it("details the traced span while keeping heads and adjacent pipe as unbought, unconnected context", async () => {
  const t = setup(), d = await drawing(t);
  t.packages.edit(d.id, { expectedRevision: 1, patch: { sourceDrawing: d.sourceDrawing, ...fs01Trace() } });
  const done = await run(t, d.id);
  expect(["completed", "waiting_input"]).toContain(done.run?.status);
  const detail = t.detailStore.get(d.id)!.details[0].fabrication;
  expect(detail.cuts.map(c => c.pieceId)).toEqual(["p1"]);
  expect(detail.cuts[0].centerline.value! * 1000).toBeCloseTo(3047.6613, 3);
  expect(detail.cuts[0].cutLength.value).toBeNull();
  const result = done.outputs.results[0];
  expect(result.materials.flatMap(m => m.entityIds)).toEqual(["p1"]);
  expect(result.assembly.some(a => /head/.test(a.instruction))).toBe(false);
});

it("refuses context that is connected into the work instead of dropping it", async () => {
  const t = setup(), d = await drawing(t);
  const trace = fs01Trace();
  trace.baselinePlan!.connections.push({ id: "guess", from: { entityId: "c1", portId: "end" }, to: { entityId: "t1", portId: "socket" } });
  t.packages.edit(d.id, { expectedRevision: 1, patch: { sourceDrawing: d.sourceDrawing, ...trace } });
  const done = await run(t, d.id);
  expect(done.run?.status).toBe("failed");
  expect(done.outputs.results).toHaveLength(0);
});

it("reopens a confirmed trace separately, invalidates results, then saves and reconfirms a scale correction", async () => {
  const t = setup(), d = await drawing(t);
  t.packages.edit(d.id, { expectedRevision: 1, patch: { sourceDrawing: d.sourceDrawing, ...fs01Trace() } });
  const done = await run(t, d.id);
  const baseline = done.baselinePlan!;
  const source = done.sourceDrawing!;
  const reopen = { baselinePlan: { ...baseline, confirmation: "proposed" }, sourceDrawing: { ...source, scale: { ...source.scale, basis: "proposed_inputs" } } };
  const mutated = structuredClone(baseline);
  mutated.entities[0].ports[0].position!.x += 50;
  expect(() => t.packages.edit(d.id, { expectedRevision: done.inputRevision, patch: { ...reopen, baselinePlan: { ...mutated, confirmation: "proposed" } } })).toThrow("confirmed_baseline_is_immutable");
  expect(() => t.packages.edit(d.id, { expectedRevision: done.inputRevision, patch: { ...reopen, sourceDrawing: { ...reopen.sourceDrawing, page: 2 } } })).toThrow("confirmed_baseline_is_immutable");
  const response = await t.app.request(`/api/work-packages/${d.id}`, { method: "PATCH", headers: { Authorization: "Bearer intake-test-token", "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: done.inputRevision, patch: reopen }) });
  expect(response.status).toBe(200);
  const opened = t.packages.get(d.id);
  expect(opened.baselinePlan?.confirmation).toBe("proposed");
  expect(opened.freshness.results.every(r => !r.current)).toBe(true);
  const corrected = t.packages.edit(d.id, { expectedRevision: opened.inputRevision, patch: {
    sourceDrawing: { ...opened.sourceDrawing!, scale: { value: MM_PER_PT * 2, unit: "mm/pixel", basis: "confirmed_inputs", reason: null }, view: { ...fs01View, calibration: { ...fs01View.calibration, printedScale: "1/16 in = 1 ft" } } },
    baselinePlan: { ...mutated, confirmation: "proposed" },
  } });
  const confirmed = t.packages.edit(d.id, { expectedRevision: corrected.inputRevision, patch: { baselinePlan: { ...corrected.baselinePlan!, confirmation: "confirmed" } } });
  expect(t.packages.get(d.id).baselinePlan?.entities[0].ports[0].position!.x).toBe(mutated.entities[0].ports[0].position!.x);
  expect(confirmed.sourceDrawing?.scale.value).toBe(MM_PER_PT * 2);
  expect(confirmed.sourceDrawing?.approval).toBe("unreviewed");
});

it("does not reopen an approved source or change protected scope together with reopening", async () => {
  const t = setup(), d = await drawing(t);
  const s = t.packages.edit(d.id, { expectedRevision: 1, patch: { sourceDrawing: d.sourceDrawing, ...fs01Trace() } });
  const reopen = { baselinePlan: { ...s.baselinePlan!, confirmation: "proposed" }, sourceDrawing: { ...s.sourceDrawing!, scale: { ...s.sourceDrawing!.scale, basis: "proposed_inputs" } } };
  expect(() => t.packages.edit(d.id, { expectedRevision: s.inputRevision, patch: { ...reopen, scope: { ...s.scope!, excludedEntityIds: [] } } })).toThrow("confirmed_baseline_is_immutable");
  const other = await drawing(t);
  const approved = t.packages.edit(other.id, { expectedRevision: 1, patch: { sourceDrawing: { ...other.sourceDrawing, approval: "approved" }, ...fs01Trace() } });
  expect(() => t.packages.edit(other.id, { expectedRevision: approved.inputRevision, patch: { baselinePlan: { ...approved.baselinePlan!, confirmation: "proposed" }, sourceDrawing: { ...approved.sourceDrawing!, approval: "unreviewed", scale: { ...approved.sourceDrawing!.scale, basis: "proposed_inputs" } } } })).toThrow("confirmed_baseline_is_immutable");
});

it("removes stale dimensions and frame boxes after correction, preserving source facts until the source changes", async () => {
  const t = setup(), d = await drawing(t, "adapt_to_site");
  const fact = (id: string, field: string, subjectIds: string[], value: string | number) => ({ id, field, subjectIds, value, unit: typeof value === "number" ? (field.endsWith("rotationDeg") ? "deg" : "mm") : null, confirmation: "confirmed", context: "detailing", unknownReason: null, source: { description: "Drawing review", assetId: d.sourceDrawing.assetId, page: 1 } });
  const trace = fs01Trace();
  const s = t.packages.edit(d.id, { expectedRevision: 1, patch: { sourceDrawing: d.sourceDrawing, ...trace, baselinePlan: { ...trace.baselinePlan!, confirmation: "proposed" }, detailing: [
    fact("label", "sourceLabel", ["p1"], "P27"), fact("nominal", "nominalSize", ["p1"], "2 inch"),
    fact("material", "materialRequirement.material", [], "steel"), fact("datum", "datum.start", ["p1"], "physical_pipe_end"),
    fact("frame", "adaptationFrame.rotationDeg", [], 0), fact("duct", "duct.min.x", [], 123), fact("envelope", "workEnvelope.max.x", [], 5000),
  ] } });
  const next = t.packages.edit(d.id, { expectedRevision: s.inputRevision, patch: { sourceDrawing: { ...s.sourceDrawing!, view: { ...fs01View, frame: { origin: { x: 5, y: 3 }, rotationDeg: 90 } } } } });
  expect(next.detailing.map(f => f.id)).toEqual(["label", "nominal", "material"]);
  const changed = t.packages.edit(d.id, { expectedRevision: next.inputRevision, patch: { sourceDrawing: { ...next.sourceDrawing!, page: 2 } } });
  expect(changed.detailing).toEqual([]);
  expect(changed.changeRequest).toBeNull();
});

it("preserves spatial measurements when selecting a product, then clears them if coordinates change", async () => {
  const t = setup(), d = await drawing(t, "adapt_to_site");
  const fact = (id: string, field: string, subjectIds: string[], value: string | number) => ({ id, field, subjectIds, value, unit: typeof value === "number" ? "mm" : null, confirmation: "confirmed", context: "detailing", unknownReason: null, source: { description: "User confirmed input", assetId: null, page: null } });
  const trace = fs01Trace();
  const s = t.packages.edit(d.id, { expectedRevision: 1, patch: { sourceDrawing: d.sourceDrawing, ...trace, baselinePlan: { ...trace.baselinePlan!, confirmation: "proposed" }, detailing: [
    fact("binding", "threadMakeup.start.pipeProductId", ["p1"], "old-product"),
    fact("frame", "adaptationFrame.origin.x", [], 0), fact("duct", "duct.min.x", [], 123), fact("envelope", "workEnvelope.max.x", [], 5000),
  ] } });
  const product = structuredClone(s.baselinePlan!);
  product.entities[0].productId = "wheatland/a53-sch40-black-nps2";
  const selected = t.packages.edit(d.id, { expectedRevision: s.inputRevision, patch: { baselinePlan: product } });
  expect(selected.detailing.map(f => f.id)).toEqual(["frame", "duct", "envelope"]);
  expect(selected.changeRequest).toBeNull();
  const moved = structuredClone(selected.baselinePlan!);
  moved.entities[0].ports[0].position!.x += 50;
  const corrected = t.packages.edit(d.id, { expectedRevision: selected.inputRevision, patch: { baselinePlan: moved } });
  expect(corrected.detailing).toEqual([]);
});

it("invalidates old boxes when a local frame changes or is removed, retaining newly supplied geometry", async () => {
  const t = setup(), d = await drawing(t, "adapt_to_site");
  const fact = (id: string, field: string, value: number) => ({ id, field, subjectIds: [], value, unit: field.endsWith("yaw") ? "deg" : "mm", confirmation: "proposed", provenance: "synthetic_assumption", context: "detailing", unknownReason: null, source: { description: "Synthetic frame test", assetId: null, page: null } });
  const trace = fs01Trace();
  const frames = [fact("x", "adaptationFrame.origin.x", 0), fact("y", "adaptationFrame.origin.y", 0), fact("z", "adaptationFrame.origin.z", 0), fact("yaw", "adaptationFrame.yaw", 0)];
  const boxes = [fact("duct", "duct.min.x", 123), fact("envelope", "workEnvelope.max.x", 5000)];
  const s = t.packages.edit(d.id, { expectedRevision: 1, patch: { sourceDrawing: d.sourceDrawing, ...trace, detailing: [...frames, ...boxes] } });
  expect(s.detailing).toHaveLength(6);
  const shifted = t.packages.edit(d.id, { expectedRevision: s.inputRevision, patch: { detailing: [...frames.map(f => f.id === "x" ? { ...f, value: 100 } : f), ...boxes] } });
  expect(shifted.detailing.map(f => f.id)).toEqual(["x", "y", "z", "yaw"]);
  const newBox = { ...boxes[0], value: 23 };
  const replaced = t.packages.edit(d.id, { expectedRevision: shifted.inputRevision, patch: { detailing: [...frames, newBox, boxes[1]] } });
  expect(replaced.detailing.map(f => f.id)).toEqual(["x", "y", "z", "yaw", "duct", "envelope"]);
  const cleared = t.packages.edit(d.id, { expectedRevision: replaced.inputRevision, patch: { detailing: [newBox, boxes[1]] } });
  expect(cleared.detailing).toEqual([]);
  expect(cleared.changeRequest).toBeNull();
});


it("keeps the selected interval and description when aligning or correcting the local frame", async () => {
  const t = setup(), d = await drawing(t, "adapt_to_site");
  const trace = fs01Trace();
  const changeRequest = { id: "site-change", description: "Existing duct blocks the selected interval", affectedEntityIds: ["p1"], factIds: [] };
  const s = t.packages.edit(d.id, { expectedRevision: 1, patch: { sourceDrawing: d.sourceDrawing, ...trace, changeRequest } });
  const fact = (id: string, field: string, value: number) => ({ id, field, subjectIds: [], value, unit: field.endsWith("yaw") ? "deg" : "mm", confirmation: "proposed", provenance: "synthetic_assumption", context: "detailing", unknownReason: null, source: { description: "Synthetic frame test", assetId: null, page: null } });
  const frames = [fact("x", "adaptationFrame.origin.x", 0), fact("y", "adaptationFrame.origin.y", 0), fact("z", "adaptationFrame.origin.z", 0), fact("yaw", "adaptationFrame.yaw", 0)];
  const aligned = t.packages.edit(d.id, { expectedRevision: s.inputRevision, patch: { detailing: frames } });
  expect(aligned.changeRequest).toEqual(changeRequest);
  const boxed = t.packages.edit(d.id, { expectedRevision: aligned.inputRevision, patch: { detailing: [...frames, fact("duct", "duct.min.x", 123)], changeRequest: { ...changeRequest, factIds: ["duct"] } } });
  const shifted = t.packages.edit(d.id, { expectedRevision: boxed.inputRevision, patch: { detailing: boxed.detailing.map(f => f.id === "x" ? { ...f, value: 100 } : f) } });
  expect(shifted.detailing.some(f => f.id === "duct")).toBe(false);
  expect(shifted.changeRequest).toEqual(changeRequest);
});
