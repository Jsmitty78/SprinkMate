import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FieldService } from "../src/service.js";
import { createApp } from "../src/api.js";
import { WorkPackageStore } from "../src/work-packages/store.js";
import { createIntegratedServices } from "../src/integration/runtime.js";
import { ASSUMPTION_PREFIX } from "@field-agent/core";
import { exportSnapshot } from "../src/integration/snapshot.js";
import { renderPdf } from "../src/exports/pdf.js";
import { csvFiles } from "../src/exports/csv.js";
import { fs01Trace, fs01View, MM_PER_PT } from "./fs01-fixture.js";

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

it("exports saved inputs with their basis, so a test assumption never reads as a measurement", async () => {
  const t = setup(), d = await drawing(t);
  const assumed = { id: "clearance", field: "requiredPipeClearance", value: 100, unit: "mm", subjectIds: [], unknownReason: null, confirmation: "confirmed" as const,
    context: "observed" as const, source: { description: `${ASSUMPTION_PREFIX} software-test parameter, not a regulation`, assetId: null, page: null } };
  t.packages.edit(d.id, { expectedRevision: 1, patch: { sourceDrawing: d.sourceDrawing, ...fs01Trace(), siteFacts: [assumed] } });
  await run(t, d.id);
  const snap = exportSnapshot(t.packages.get(d.id), t.detailStore.get(d.id)!)!;
  expect(snap.inputs).toEqual([expect.objectContaining({ id: "clearance", value: 100, unit: "mm", status: "confirmed", basis: "test_assumption" })]);
  expect((await renderPdf(snap)).subarray(0, 5).toString()).toBe("%PDF-");
});

// R2 of #1: source-only partial output. The source asks for 2" Schedule 40 steel; no product is selected.
it("gives an honest R2 partial package: requirement not purchase, projected length, context, null cut with reasons", async () => {
  const t = setup(), d = await drawing(t);
  const detail = (id: string, field: string, value: string, subjectIds: string[] = [], source = "FM32361 FS-02 general notes") =>
    ({ id, field, value, subjectIds, unit: null, unknownReason: null, confirmation: "confirmed" as const, context: "detailing" as const, source: { description: source, assetId: null, page: null } });
  t.packages.edit(d.id, { expectedRevision: 1, patch: { sourceDrawing: d.sourceDrawing, ...fs01Trace(), detailing: [
    detail("size", "nominalSize", '2"', ["p1"], "FS-01 pipe label"),
    detail("req", "materialRequirement", "Schedule 40 black steel pipe with threaded cast-iron fittings"),
    detail("p27", "sourceLabel", "P27", ["p1"], "FS-01"), detail("h1", "sourceLabel", "H1", ["h1"], "FS-01"), detail("h3", "sourceLabel", "H3", ["h2"], "FS-01"),
    detail("j", "jurisdiction", "other", [], "Idaho project (test)"),
  ] } });
  const done = await run(t, d.id);
  const result = done.outputs.results[0];
  expect(result.materials).toHaveLength(1);
  expect(result.materials[0].description).toMatch(/^Pipe, product not selected; nominal 2" \(as printed\); source requires: Schedule 40 black steel/);
  expect(result.materials[0].quantity).toMatchObject({ value: null, basis: "unknown" });
  expect(result.cuts[0].length.value).toBeNull();
  for (const reason of ["Endpoint datum", "Pipe product not selected", "Projected plan length from the drawing"]) expect(result.cuts[0].length.reason).toContain(reason);
  const text = result.assembly.map(a => a.instruction).join(" ");
  expect(text).not.toMatch(/plastic|bevel|cement|FS-5|quarter/i);
  expect(result.assembly[0].instruction).toBe("Detail cutting and end preparation for piece 1 once its product and connection are selected.");
  // No San Francisco rules for another jurisdiction, and no product checks for retained context heads.
  expect(result.evaluations.some(e => /NFPA 13-2025|head product/i.test(e.reason))).toBe(false);
  expect(result.evaluations.find(e => /No executable rule pack/.test(e.reason))?.status).toBe("unknown");
  // No CPVC cure question and no CPVC procedure cited for a product that is not selected.
  expect(done.outputs.requests.some(r => /cure/i.test(r.question))).toBe(false);
  expect(result.evaluations.find(e => /No catalog procedure applies/.test(e.reason))?.sourceRefs).toEqual([]);

  const snap = exportSnapshot(t.packages.get(d.id), t.detailStore.get(d.id)!)!;
  expect(snap.cuts[0].centerline! * 1000).toBeCloseTo(3047.6613, 3);
  expect(snap.retainedContext).toEqual([{ id: "h1", kind: "head", label: "H1" }, { id: "h2", kind: "head", label: "H3" }, { id: "c1", kind: "pipe", label: null }]);
  expect(snap.materials[0]).toMatchObject({ quantity: null, status: "unresolved" });
  const { bom, cuts } = csvFiles(snap);
  expect(bom.toString()).toContain('"retained_context","h1","head H1: retained context, not part of this work","","","not_purchased"');
  expect(cuts.toString()).toMatch(/"centerline_length"\r\n.*"3\.04766/);
  expect((await renderPdf(snap)).subarray(0, 5).toString()).toBe("%PDF-");
});
