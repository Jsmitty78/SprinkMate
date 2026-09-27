import { describe, expect, it } from "vitest";
import { evidenceSpec, factProvenance, findFact, upsertFacts, type FactSpec } from "./model.js";

const empty = { detailing: [], siteFacts: [] };
const assumption: FactSpec = { field: "duct.min.z", value: -100, unit: "mm", context: "detailing", source: "Fictional obstacle for software testing", provenance: "synthetic_assumption", confirmation: "proposed" };

describe("site evidence provenance", () => {
  it("retains synthetic identity through reload, edits and attempted confirmation", () => {
    const saved = JSON.parse(JSON.stringify(upsertFacts(empty, [assumption])));
    const existing = findFact(saved, assumption.field)!;
    expect(evidenceSpec(existing, "confirmed_evidence", "Clicked confirm")).toMatchObject({ provenance: "synthetic_assumption", confirmation: "proposed" });
    const changed = upsertFacts(saved, [{ ...assumption, value: -200, context: "observed", provenance: "confirmed_evidence", confirmation: "confirmed", source: "Edited and confirmed" }]);
    expect(findFact(changed, assumption.field)).toMatchObject({ value: -200, provenance: "synthetic_assumption", confirmation: "proposed", context: "detailing" });
  });
  it("preserves missing elevation as null, never zero or confirmed", () => {
    const saved = upsertFacts(empty, [{ ...assumption, value: null, unknownReason: "Height not measured" }]);
    expect(findFact(saved, assumption.field)).toMatchObject({ value: null, confirmation: "proposed", unknownReason: "Height not measured", provenance: "synthetic_assumption" });
  });
  it("separates entered measurements, machine proposals and checked evidence", () => {
    expect(evidenceSpec(undefined, "user_entered", "Tape reading")).toMatchObject({ confirmation: "proposed", provenance: "user_entered" });
    expect(evidenceSpec(undefined, "machine_proposal", "Image proposal")).toMatchObject({ confirmation: "proposed", provenance: "machine_proposal" });
    expect(evidenceSpec(undefined, "confirmed_evidence", "Survey record checked")).toMatchObject({ confirmation: "confirmed", provenance: "confirmed_evidence" });
  });
  it("recognizes legacy SAMPLE facts and prevents later promotion", () => {
    const legacy = upsertFacts(empty, [{ ...assumption, provenance: undefined, confirmation: "confirmed", source: "SAMPLE fictional duct" }]);
    expect(factProvenance(findFact(legacy, assumption.field))).toBe("synthetic_assumption");
    const edited = upsertFacts(legacy, [{ ...assumption, provenance: undefined, confirmation: "confirmed", source: "Measured on site by you" }]);
    expect(findFact(edited, assumption.field)).toMatchObject({ provenance: "synthetic_assumption", confirmation: "proposed" });
  });
});

describe("local frame precision and readiness", () => {
  it("keeps arbitrary derived drawing coordinates exact through unit display and parse", async () => {
    const { alignedFrameInputs, exactFrameLengthInput } = await import("./model.js");
    const { parseLength } = await import("./format.js");
    const { adaptationFrame } = await import("@field-agent/core");
    const { sampleInputs } = await import("./sample.js");
    const s = { ...sampleInputs("adapt", "asset"), intent: "adapt_to_site" } as import("@field-agent/core").WorkPackageSnapshot;
    const pipe = s.baselinePlan!.entities.find(e => e.kind === "pipe")!;
    const start = { x: 61989.54613333334, y: -60420.50400000001, z: 12.987654321 };
    pipe.ports[0].position = start;
    pipe.ports[1].position = { x: start.x + 2345.6789, y: start.y + 765.4321, z: start.z };
    for (const unit of ["mm", "in"] as const) {
      for (const n of Object.values(start)) expect(parseLength(exactFrameLengthInput(n, unit), unit)).toBe(n);
      const aligned = alignedFrameInputs(s, unit)!;
      const next = upsertFacts(s, ["origin.x", "origin.y", "origin.z", "yaw"].map((name, i) => ({
        ...assumption, field: `adaptationFrame.${name}`, value: i === 3 ? Number(aligned[i]) : parseLength(aligned[i], unit), unit: i === 3 ? "deg" : "mm",
      })));
      expect(adaptationFrame(next).toLocal(start)).toEqual({ x: 0, y: 0, z: 0 });
      expect(pipe.ports[0].position).toEqual(start);
    }
  });
  it("keeps saved trace ready before choosing affected pipe or product", async () => {
    const { requirements } = await import("./model.js");
    const { sampleInputs } = await import("./sample.js");
    const s = { ...sampleInputs("adapt", "asset"), intent: "adapt_to_site", changeRequest: null } as import("@field-agent/core").WorkPackageSnapshot;
    s.baselinePlan!.entities.forEach(e => { e.productId = null; });
    expect(requirements(s).find(r => r.id === "run")?.done).toBe(true);
    expect(requirements(s).find(r => r.id === "change")?.done).toBe(false);
    expect(requirements(s).find(r => r.id === "duct")).toMatchObject({ done: true, label: "Obstacle geometry (all six faces) — synthetic test input" });
    expect(requirements(s).find(r => r.id === "workAreaAccess")?.done).toBe(false);
  });
});
