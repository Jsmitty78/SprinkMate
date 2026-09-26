import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

const identifier = () => Type.String({ minLength: 1 });
const evidenceIds = () => Type.Array(identifier(), { uniqueItems: true });

export function factSchema<T extends TSchema>(value: T) {
  return Type.Object({
    value: Type.Union([value, Type.Null()]),
    confirmed: Type.Boolean(),
    evidenceIds: evidenceIds(),
    source: Type.Union([Type.Literal("manual"), Type.Literal("model"), Type.Literal("fixture")]),
  }, { additionalProperties: false });
}

export const OrientationSchema = Type.Union([
  Type.Literal("pendent"), Type.Literal("upright"), Type.Literal("sideways"), Type.Literal("unknown"),
]);
export const FactSchema = factSchema(Type.String());
export const HeadFactsSchema = Type.Object({
  model: factSchema(Type.String()),
  installation: factSchema(Type.Union([Type.Literal("installed"), Type.Literal("uninstalled")])),
  mounting: factSchema(Type.Union([Type.Literal("standard"), Type.Literal("recessed")])),
  orientation: factSchema(OrientationSchema),
  verticalReference: factSchema(Type.Union([Type.Literal("gravity"), Type.Literal("verified_record"), Type.Literal("unknown")])),
}, { additionalProperties: false });
export const EvidenceSchema = Type.Object({
  id: identifier(),
  targetId: identifier(),
  superseded: Type.Optional(Type.Boolean()),
  spatial: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });
export const RuleContextSchema = Type.Object({
  targetId: identifier(),
  taskRevision: Type.Integer({ minimum: 0 }),
  observations: Type.Array(EvidenceSchema),
}, { additionalProperties: false });

export const MeasurementEndpointSchema = Type.Object({
  coordinateFrameId: identifier(),
  captureSessionId: identifier(),
  timestamp: Type.Number({ minimum: 0 }),
  position: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
  hit: Type.Union([Type.Literal("existing_plane"), Type.Literal("estimated_plane"), Type.Literal("none"), Type.Literal("fallback"), Type.Literal("fixture")]),
  tracking: Type.Union([Type.Literal("normal"), Type.Literal("limited"), Type.Literal("unavailable")]),
  evidenceIds: evidenceIds(),
}, { additionalProperties: false });

const measurementBase = {
  id: identifier(),
  targetId: identifier(),
  unit: Type.Literal("m"),
  evidenceIds: evidenceIds(),
};
export const MeasurementSchema = Type.Union([
  Type.Object({
    ...measurementBase,
    method: Type.Union([Type.Literal("ar_raycast"), Type.Literal("fixture")]),
    from: MeasurementEndpointSchema,
    to: MeasurementEndpointSchema,
  }, { additionalProperties: false }),
  Type.Object({
    ...measurementBase,
    method: Type.Literal("manual"),
    valueMeters: Type.Number({ minimum: 0 }),
    fromLabel: identifier(),
    toLabel: identifier(),
  }, { additionalProperties: false }),
]);

export { Check as checkSchema };

export function validateSchema<T extends TSchema>(schema: T, input: unknown):
  { valid: true; value: Static<T> } | { valid: false; errors: ReturnType<typeof Errors> } {
  return Check(schema, input) ? { valid: true, value: input } : { valid: false, errors: Errors(schema, input) };
}

export function assertSchema<T extends TSchema>(schema: T, input: unknown): asserts input is Static<T> {
  if (!Check(schema, input)) throw new Error(`Invalid input: ${JSON.stringify(Errors(schema, input))}`);
}
