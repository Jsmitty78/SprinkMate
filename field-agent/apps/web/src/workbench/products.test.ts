import { describe, expect, it } from "vitest";
import { fabricationCatalog } from "../../../../packages/fabrication/src/steel-catalog.js";
import { buildTracePlan } from "./intake/sheet.js";
import { PRODUCT_SETS, productSetOf, applyRunProducts } from "./products.js";

const trace = {
  nodes: [{ kind: "open_end" as const, at: { x: 0, y: 0 }, head: false, label: "" },
    { kind: "elbow" as const, at: { x: 100, y: 0 }, head: false, label: "" },
    { kind: "open_end" as const, at: { x: 100, y: 100 }, head: false, label: "" }],
  pipeLabels: ["A", "B"], context: [],
};

describe("intake catalog choices", () => {
  it.each(Object.entries(PRODUCT_SETS))("restores %s from persisted plan and uses a compatible documented pair", (key, pair) => {
    const built = buildTracePlan(trace, { scale: 1, origin: { x: 0, y: 0 }, rotationDeg: 0 }, pair);
    if ("problems" in built) throw new Error(built.problems.join());
    expect(productSetOf({ baselinePlan: built.plan, scope: built.scope })).toBe(key);
    if (pair.pipe) {
      const catalog = fabricationCatalog("test");
      expect(catalog.products.find(p => p.id === pair.pipe)?.kind).toBe("pipe");
      const elbow = catalog.products.find(p => p.id === pair.elbow);
      expect(elbow?.kind === "elbow_90" && elbow.compatiblePipeIds.includes(pair.pipe)).toBe(true);
    }
  });
  it("does not choose a catalog product for an empty package", () => {
    expect(productSetOf({ baselinePlan: null, scope: null })).toBe("none");
  });
});

it("changes products without roundtripping coordinates, connections or protected context", () => {
  const built = buildTracePlan({ ...trace, context: [{ kind: "pipe", points: [{ x: 3, y: 2 }, { x: 8, y: 9 }], label: "Retained" }] },
    { scale: 33.8666666667, origin: { x: 1460.123, y: 1500.456 }, rotationDeg: 23.7 }, PRODUCT_SETS.none);
  if ("problems" in built) throw new Error(built.problems.join());
  const saved = JSON.parse(JSON.stringify(built.plan));
  const changed = applyRunProducts(saved, built.scope.includedEntityIds, PRODUCT_SETS.steel_nps2);
  expect(changed.connections).toBe(saved.connections);
  expect(changed.coordinateFrame).toBe(saved.coordinateFrame);
  expect(changed.entities.map(e => e.ports)).toEqual(saved.entities.map((e: { ports: unknown }) => e.ports));
  expect(changed.entities.filter(e => built.scope.excludedEntityIds.includes(e.id))).toEqual(saved.entities.filter((e: { id: string }) => built.scope.excludedEntityIds.includes(e.id)));
  expect(productSetOf({ baselinePlan: changed, scope: built.scope })).toBe("steel_nps2");
});
