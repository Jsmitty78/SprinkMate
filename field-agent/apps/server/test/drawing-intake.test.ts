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
