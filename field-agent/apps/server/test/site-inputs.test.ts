import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ASSUMPTION_PREFIX, type PackageInputs } from "@field-agent/core";
import { FieldService } from "../src/service.js";
import { WorkPackageStore } from "../src/work-packages/store.js";
import { createIntegratedServices } from "../src/integration/runtime.js";
import { boxFact } from "../src/integration/model.js";
import { fs01Trace } from "./fs01-fixture.js";

// FS-01 Scenario 2/3 acceptance v1. The duct, envelope and clearance are fictional software-test
// values, entered in the span frame of #1: drawing XY = (12544.2133 - localY, 9620.5040 + localX) mm,
// which in the plan frame (Y up) is plan = (12544.2133 - localY, -9620.5040 - localX).
const ASSUMED = `${ASSUMPTION_PREFIX} FS-01 acceptance v1, fictional software-test value`;
type Fact = PackageInputs["siteFacts"][number];
const fact = (field: string, value: Fact["value"], extra: Partial<Fact> = {}): Fact => ({
  id: `f-${field}`, field, value, subjectIds: [], unit: typeof value === "number" ? "mm" : null, unknownReason: null,
  confirmation: "confirmed", context: "observed", source: { description: ASSUMED, assetId: null, page: null }, ...extra,
});
const box = (prefix: string, v: number[], extra: Partial<Fact> = {}) =>
  ["min.x", "min.y", "min.z", "max.x", "max.y", "max.z"].map((k, i) => fact(`${prefix}.${k}`, v[i], extra));
const DUCT = [1200, -250, -300, 1800, 250, 300], ENVELOPE = [-150, -1400, -200, 3197.6613, 1200, 200];

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(f => f()));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "site-"));
  const field = new FieldService(dir);
  const t = createIntegratedServices(new WorkPackageStore(field.store.db), dir);
  cleanup.push(() => { t.packages.close(); field.store.close(); rmSync(dir, { recursive: true, force: true }); });
  const s = t.packages.create({ projectId: "fs01", title: "P27 duct", intent: "adapt_to_site" });
  return { t, id: s.id };
}
function save(siteFacts: Fact[]) {
  const { t, id } = setup();
  const s = t.packages.edit(id, { expectedRevision: 1, patch: { ...fs01Trace(), siteFacts,
    changeRequest: { id: "duct", description: "Fictional duct across P27 (test assumption)", affectedEntityIds: ["p1"], factIds: siteFacts.filter(f => f.field.startsWith("duct.")).map(f => f.id) } } });
  return { t, id, s };
}
const frame = (side: "left" | "right" = "right", extra: Partial<Fact> = {}) => fact("siteFrame", side, { subjectIds: ["p1"], ...extra });

it("maps the v1 duct and envelope from the span frame to the plan frame exactly", () => {
  const { s } = save([frame(), ...box("duct", DUCT), ...box("workEnvelope", ENVELOPE)]);
  const duct = boxFact(s, "duct"), env = boxFact(s, "workEnvelope");
  expect(duct.confirmed).toBe(true);
  const xyz = (p: { x: number; y: number; z: number }) => [p.x, p.y, p.z];
  expect(xyz(duct.value!.min)).toEqual([12294.2133, -11420.504, -300]);
  expect(xyz(duct.value!.max)).toEqual([12794.2133, -10820.504, 300]);
  expect(xyz(env.value!.min)).toEqual([11344.2133, -12818.1653, -200]);
  expect(xyz(env.value!.max)).toEqual([13944.2133, -9470.504, 200]);
  // Drawing XY (Y down) of the duct's near corner is (12544.2133 - 250, 9620.5040 + 1200).
  expect([duct.value!.min.x, -duct.value!.max.y]).toEqual([12294.2133, 10820.504]);
  expect(duct.evidenceIds).toContain("f-siteFrame");
});

it("reads feet and inches, and changes the plan box when only the frame changes", () => {
  const ft = box("duct", DUCT.map(v => v / 304.8), { unit: "ft" });
  const right = boxFact(save([frame("right"), ...ft]).s, "duct").value!;
  expect(right.min.x).toBeCloseTo(12294.2133, 6);
  const left = boxFact(save([frame("left"), ...ft]).s, "duct").value!;
  expect(left.min.x).toBeCloseTo(12294.2133, 6);
  expect(left.min.y).toBeCloseTo(-11420.504, 6);
  const mirrored = boxFact(save([frame("left"), ...box("duct", [1200, 0, -300, 1800, 400, 300])]).s, "duct").value!;
  expect([mirrored.min.x, mirrored.max.x]).toEqual([12544.2133, 12944.2133]);
});

it("keeps missing height, unconfirmed faces, an unconfirmed frame or an inverted box unknown", () => {
  const noHeight = box("duct", DUCT).map(f => f.field.endsWith(".z") ? { ...f, value: null, unit: null, unknownReason: "Height not measured", confirmation: "proposed" as const } : f);
  expect(boxFact(save([frame(), ...noHeight]).s, "duct").confirmed).toBe(false);
  expect(boxFact(save([frame(), ...box("duct", DUCT, { confirmation: "proposed" })]).s, "duct").confirmed).toBe(false);
  expect(boxFact(save([frame("right", { confirmation: "proposed" }), ...box("duct", DUCT)]).s, "duct").confirmed).toBe(false);
  expect(boxFact(save([frame(), ...box("duct", [1800, -250, -300, 1200, 250, 300])]).s, "duct").confirmed).toBe(false);
});

it("rejects a site frame on anything but one pipe", () => {
  expect(() => save([frame("right", { subjectIds: ["t1"] })])).toThrow("invalid_site_frame");
  expect(() => save([frame("right", { subjectIds: [] })])).toThrow("invalid_site_frame");
  expect(() => save([fact("siteFrame", "up", { subjectIds: ["p1"] })])).toThrow("invalid_site_frame");
});

it("keeps test-assumption provenance on confirmed facts through reload", () => {
  const { t, id } = save([frame(), ...box("duct", DUCT), fact("requiredPipeClearance", 100)]);
  const reloaded = t.packages.get(id);
  expect(reloaded.siteFacts.filter(f => f.field.startsWith("duct.")).every(f => f.confirmation === "confirmed" && f.source.description.startsWith(ASSUMPTION_PREFIX))).toBe(true);
  expect(reloaded.changeRequest?.factIds).toHaveLength(6);
  expect(reloaded.baselinePlan).toEqual(fs01Trace().baselinePlan);
});
