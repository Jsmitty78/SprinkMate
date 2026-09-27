import { DIMENSIONS_SOURCE, ELBOW_ID, PIPE_ID, PROCEDURE_SOURCE, ELBOW_SOURCE } from "./catalog.js";
import { toMeters } from "./engine.js";
import type { Catalog, Length } from "./types.js";

interface Fact<T> { value: T | null; confirmed: boolean; evidenceIds: string[]; source: "manual" | "model" | "fixture" }
/** Structural match to planning GenerateInput.product. Catalog facts are not site facts. */
export interface PlanningProductPort {
  compatibility: Fact<{ pipeProductId: string; elbowProductId: string; connectionMethod: string }>;
  centerToFace: Fact<Length>;
  insertionOrThreadMakeup: Fact<Length>;
}
export function toPlanningProduct(catalog: Catalog): PlanningProductPort {
  const pipe = catalog.products.find(p => p.id === PIPE_ID);
  const elbow = catalog.products.find(p => p.id === ELBOW_ID);
  const sourceIds = [DIMENSIONS_SOURCE, ELBOW_SOURCE, PROCEDURE_SOURCE];
  const sourceBacked = catalog.evidenceClass === "manufacturer_document" && sourceIds.every(id => catalog.sources.some(s => s.id === id));
  const compatible = sourceBacked && pipe?.kind === "pipe" && elbow?.kind === "elbow_90"
    && elbow.compatiblePipeIds.includes(pipe.id) && pipe.nominalSize === elbow.nominalSize
    && pipe.connection === elbow.connection;
  const fact = <T>(value: T | null): Fact<T> => ({ value, confirmed: value !== null,
    evidenceIds: value === null ? [] : sourceIds, source: "manual" });
  const h = compatible && elbow.centerToFace ? toMeters(elbow.centerToFace) : null;
  const g = compatible && elbow.centerToSocketBottom ? toMeters(elbow.centerToSocketBottom) : null;
  if (g !== null && h !== null && h <= g) throw new Error("Socket H must exceed G");
  return {
    compatibility: fact(compatible ? { pipeProductId: PIPE_ID, elbowProductId: ELBOW_ID, connectionMethod: "cpvc_socket_solvent" } : null),
    centerToFace: fact(h === null ? null : { value: h, unit: "m" }),
    // Full insertion to the socket bottom: H - G. This is not thread makeup.
    insertionOrThreadMakeup: fact(h === null || g === null ? null : { value: h - g, unit: "m" }),
  };
}
