import { describe, expect, it } from "vitest";
import { checkSchema, emptyFacts, HeadFactsPatchSchema, HeadFactsSchema, MeasurementSchema } from "../src/index.js";

describe("shared JSON contracts", () => {
  it("represents incomplete facts without pretending they are confirmed", () => {
    expect(checkSchema(HeadFactsSchema, emptyFacts())).toBe(true);
  });

  it("rejects unknown fields and arbitrary orientation strings", () => {
    expect(checkSchema(HeadFactsSchema, { ...emptyFacts(), pass: true })).toBe(false);
    const facts = emptyFacts();
    expect(checkSchema(HeadFactsSchema, { ...facts, orientation: { ...facts.orientation, value: "45 degrees is close enough" } })).toBe(false);
  });

  it("strictly validates partial facts including numeric fields without requiring old fields", () => {
    const fact = { value: 10, confirmed: true, evidenceIds: ["E1"], source: "manual" };
    expect(checkSchema(HeadFactsPatchSchema, { installationTorqueFtLb: fact })).toBe(true);
    expect(checkSchema(HeadFactsPatchSchema, { inventedRule: fact })).toBe(false);
    expect(checkSchema(HeadFactsPatchSchema, { installationTorqueFtLb: { ...fact, value: "10" } })).toBe(false);
    expect(checkSchema(HeadFactsPatchSchema, { installationTorqueFtLb: { ...fact, value: -1 } })).toBe(false);
    expect(checkSchema(HeadFactsPatchSchema, { workingPressurePsi: { ...fact, value: Infinity } })).toBe(false);
    expect(checkSchema(HeadFactsPatchSchema, { workingPressurePsi: { ...fact, pass: true } })).toBe(false);
    expect(checkSchema(HeadFactsPatchSchema, { pressureBasis: { ...fact, value: "system_maximum" } })).toBe(true);
    expect(checkSchema(HeadFactsPatchSchema, { pressureBasis: { ...fact, value: "unknown_basis" } })).toBe(false);
  });

  it("requires manual units, endpoint labels, and a finite number", () => {
    const value = { id: "M1", targetId: "P1", method: "manual", unit: "m", valueMeters: 3, fromLabel: "A", toLabel: "B", evidenceIds: ["E1"] };
    expect(checkSchema(MeasurementSchema, value)).toBe(true);
    expect(checkSchema(MeasurementSchema, { ...value, unit: "feet" })).toBe(false);
    expect(checkSchema(MeasurementSchema, { ...value, valueMeters: Infinity })).toBe(false);
    expect(checkSchema(MeasurementSchema, { ...value, toLabel: undefined })).toBe(false);
  });
});
