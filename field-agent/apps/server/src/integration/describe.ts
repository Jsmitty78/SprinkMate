import type { WorkPackageSnapshot } from "@field-agent/core";
import {
  UNSELECTED_PRODUCT,
  type FabricationOutput,
} from "@field-agent/fabrication";

type Material = FabricationOutput["materials"][number];
const text = (s: WorkPackageSnapshot, field: string, subject?: string) => {
  const f = [...s.detailing, ...s.siteFacts].find(
    (f) =>
      f.field === field &&
      (subject ? f.subjectIds.includes(subject) : f.subjectIds.length === 0),
  );
  return typeof f?.value === "string" && f.value.trim() ? f : null;
};
/** Sheet labels (P27, H1) when the intake saved them; otherwise the project-local id. */
export function labelOf(s: WorkPackageSnapshot, id: string): string {
  const l = text(s, "sourceLabel", id);
  return l ? `${l.value as string} (${id})` : id;
}

/**
 * What a material row is, in words: the catalog product when one is selected, otherwise what the
 * source asks for (nominal size, material requirement) so an unselected product is not read as a
 * purchase decision.
 */
export function materialDescription(
  s: WorkPackageSnapshot,
  m: Material,
): string {
  if (m.productId && m.productId !== UNSELECTED_PRODUCT)
    return m.kind === "pipe"
      ? `${m.productId} (modeled spans; not purchasing stock)`
      : m.productId;
  if (m.kind !== "pipe" && m.kind !== "fitting") return m.productId ?? m.id;
  const what = m.kind === "pipe" ? "Pipe" : "Fitting";
  const sizes = [
    ...new Set(
      m.entityIds
        .map((id) => text(s, "nominalSize", id)?.value as string | undefined)
        .filter(Boolean),
    ),
  ];
  const requirement = text(s, "materialRequirement");
  const parts = [
    `${what}, product not selected`,
    sizes.length ? `nominal ${sizes.join(", ")} (as printed)` : null,
    requirement
      ? `source requires: ${requirement.value as string} (${requirement.source.description})`
      : null,
    `modeled: ${m.entityIds.map((id) => labelOf(s, id)).join(", ")}`,
  ];
  return parts.filter(Boolean).join("; ");
}

/** Entities outside the scope: kept visible and traceable, never part of the work or a purchase. */
export function retainedContext(s: WorkPackageSnapshot) {
  const excluded = new Set(s.scope?.excludedEntityIds ?? []);
  return (s.baselinePlan?.entities ?? [])
    .filter((e) => excluded.has(e.id))
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      label:
        (text(s, "sourceLabel", e.id)?.value as string | undefined) ?? null,
    }));
}
