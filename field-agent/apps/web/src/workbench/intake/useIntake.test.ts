import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Snapshot } from "../api.js";
import { getLocale, setLocale } from "../locale.js";
import { useIntake } from "./useIntake.js";
import { IntakeInputs } from "./IntakeInputs.js";
import { buildTracePlan } from "./sheet.js";

const initialLocale = getLocale();
beforeEach(() => setLocale("en"));
afterEach(() => setLocale(initialLocale));

const trace = { nodes: [{ kind: "open_end" as const, at: { x: 10, y: 20 }, head: false, label: "" }, { kind: "open_end" as const, at: { x: 150, y: 20 }, head: false, label: "" }], pipeLabels: ["P1"], context: [] };
const built = buildTracePlan(trace, { origin: { x: 0, y: 0 }, rotationDeg: 0, scale: 1 }, { pipe: null, elbow: null });
if ("problems" in built) throw new Error(built.problems.join());
const snapshot = { id: "draft-test", inputRevision: 2, baselinePlan: built.plan, scope: built.scope, detailing: [], siteFacts: [], sourceDrawing: { assetId: "sheet", page: 1, approval: "unreviewed", scale: { value: 1 }, view: { frame: { origin: { x: 0, y: 0 }, rotationDeg: 0 } } } } as unknown as Snapshot;
function Harness({ s }: { s: Snapshot }) {
  const intake = useIntake(s);
  return createElement("output", null, JSON.stringify({ dirty: intake.traceDirty, nodes: intake.trace.nodes }));
}
afterEach(() => vi.unstubAllGlobals());
it("restores unsaved trace edits as dirty so product-only saving cannot discard them", () => {
  const edited = { ...trace, nodes: trace.nodes.map((n, i) => i === 1 ? { ...n, at: { x: 180, y: 20 } } : n) };
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ assetId: "sheet", page: 1, trace: edited }) });
  const html = renderToStaticMarkup(createElement(Harness, { s: snapshot }));
  expect(html).toContain('&quot;dirty&quot;:true');
  expect(html).toContain('&quot;x&quot;:180');
});
it("ignores a draft belonging to another source page or a confirmed trace", () => {
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ assetId: "sheet", page: 2, trace }) });
  expect(renderToStaticMarkup(createElement(Harness, { s: snapshot }))).toContain('&quot;dirty&quot;:false');
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ assetId: "sheet", page: 1, trace }) });
  expect(renderToStaticMarkup(createElement(Harness, { s: { ...snapshot, baselinePlan: { ...snapshot.baselinePlan!, confirmation: "confirmed" } } }))).toContain('&quot;dirty&quot;:false');
});


it("restores material notes on another page without changing the traced source page", () => {
  const s = { ...snapshot, detailing: [{ id: "material", field: "materialRequirement", value: "Schedule 40 steel", subjectIds: [], unit: null, unknownReason: null, confirmation: "confirmed", context: "detailing", source: { description: "Read by you from FS-02 notes", assetId: "sheet", page: 2 } }] } as Snapshot;
  function IntakeHarness() {
    const intake = useIntake(s);
    return createElement(IntakeInputs, { s, intake, act: async () => true, busy: "", unit: "mm", setNotice: () => {}, showSheet: () => {} });
  }
  const html = renderToStaticMarkup(createElement(IntakeHarness));
  expect(html).toContain('Requirement source page');
  expect(html).toMatch(/type="number"[^>]*value="2"/);
  expect(s.sourceDrawing!.page).toBe(1);
});

it("defaults new requirements to unverified input and locks restored synthetic requirements", () => {
  function render(s: Snapshot) {
    function IntakeHarness() {
      const intake = useIntake(s);
      return createElement(IntakeInputs, { s, intake, act: async () => true, busy: "", unit: "mm", setNotice: () => {}, showSheet: () => {} });
    }
    return renderToStaticMarkup(createElement(IntakeHarness));
  }
  expect(render(snapshot)).toMatch(/value="user_entered" selected=""/);
  const s = { ...snapshot, detailing: [{ id: "material", field: "materialRequirement", value: "Supplemental steel test only", subjectIds: [], unit: null, unknownReason: null, confirmation: "proposed", provenance: "synthetic_assumption", context: "detailing", source: { description: "Synthetic catalog selection", assetId: "sheet", page: 1 } }] } as Snapshot;
  const html = render(s);
  expect(html).toMatch(/value="synthetic_assumption" selected=""/);
  const textControl = html.split('Requirement text provenance')[1].split('</select>')[0];
  const materialControl = html.split('Material provenance')[1].split('</select>')[0];
  expect(textControl).toContain('disabled=""');
  expect(textControl).toContain('value="synthetic_assumption" selected=""');
  expect(materialControl).not.toContain('disabled=""');
  expect(materialControl).toContain('value="user_entered" selected=""');
  expect(html).toContain('This value remains a synthetic test assumption.');
});
