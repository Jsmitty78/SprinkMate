import type { PackagePlan } from "./work-package.js";

/**
 * A local site frame pinned to one straight span of the saved plan, so a fitter can enter an
 * obstacle as "from 1200 to 1800 along the pipe, 250 either side, 300 above and below".
 *
 * Saved as the fact `siteFrame` with the span as its only subject and the Y side as its value:
 * - origin: the span's start port, Z = 0 at its centerline;
 * - X: along the span, start to end;
 * - Y: horizontal, to the `left` or `right` of X seen from above (`right` is a mirrored frame);
 * - Z: up.
 * Box facts (`duct.*`, `workEnvelope.*`) are then read in this frame. Without the fact they are in
 * the plan frame, as before.
 */
export const SITE_FRAME_FIELD = "siteFrame";
export type SiteYSide = "left" | "right";
export interface Vec3 { x: number; y: number; z: number }
export interface SiteFrame { spanId: string; ySide: SiteYSide; origin: Vec3; x: Vec3; y: Vec3; length: number }

/** Source prefix for fictional values entered to exercise the software. Confirming never removes it. */
export const ASSUMPTION_PREFIX = "ASSUMPTION:";
export const isAssumption = (description: string | undefined) => !!description?.startsWith(ASSUMPTION_PREFIX);

export const MM_PER: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
export function toMillimetres(value: number, unit: string | null | undefined): number | null {
  const f = MM_PER[unit ?? ""];
  return f === undefined ? null : value * f;
}

export function siteFrameFor(plan: Pick<PackagePlan, "entities">, spanId: string, ySide: SiteYSide): SiteFrame | { reason: string } {
  const span = plan.entities.find(e => e.id === spanId);
  if (!span || span.kind !== "pipe") return { reason: `${spanId} is not a pipe in the saved plan` };
  const [a, b] = [span.ports[0]?.position, span.ports.at(-1)?.position];
  if (!a || !b) return { reason: `${spanId} has no located ends` };
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
  if (!(length > 0)) return { reason: `${spanId} has no horizontal length` };
  if (Math.abs(b.z - a.z) > 1e-6 * length) return { reason: `${spanId} is not level; a sloped span has no horizontal site frame here` };
  const x = { x: dx / length, y: dy / length, z: 0 };
  const y = ySide === "left" ? { x: -x.y, y: x.x, z: 0 } : { x: x.y, y: -x.x, z: 0 };
  return { spanId, ySide, origin: { x: a.x, y: a.y, z: a.z }, x, y, length };
}

export function localToPlan(f: SiteFrame, p: Vec3): Vec3 {
  return { x: f.origin.x + p.x * f.x.x + p.y * f.y.x, y: f.origin.y + p.x * f.x.y + p.y * f.y.y, z: f.origin.z + p.z };
}
export function planToLocal(f: SiteFrame, p: Vec3): Vec3 {
  const dx = p.x - f.origin.x, dy = p.y - f.origin.y;
  return { x: dx * f.x.x + dy * f.x.y, y: dx * f.y.x + dy * f.y.y, z: p.z - f.origin.z };
}

/**
 * The plan-frame box for a local box. The planner only takes boxes aligned with the plan axes, so a
 * span that is not parallel to a plan axis gives a reason instead of an enlarged or shrunk box.
 */
export function localBoxToPlan(f: SiteFrame, min: Vec3, max: Vec3): { min: Vec3; max: Vec3 } | { reason: string } {
  const aligned = Math.min(Math.abs(f.x.x), Math.abs(f.x.y)) <= 1e-7;
  if (!aligned) return { reason: `${f.spanId} is not parallel to a plan axis. Pick the plan frame's X axis along this span so the box stays exact.` };
  const corners = [min.x, max.x].flatMap(x => [min.y, max.y].map(y => localToPlan(f, { x, y, z: 0 })));
  const snap = (v: number) => Math.round(v * 1e6) / 1e6;
  return {
    min: { x: snap(Math.min(...corners.map(c => c.x))), y: snap(Math.min(...corners.map(c => c.y))), z: f.origin.z + min.z },
    max: { x: snap(Math.max(...corners.map(c => c.x))), y: snap(Math.max(...corners.map(c => c.y))), z: f.origin.z + max.z },
  };
}
