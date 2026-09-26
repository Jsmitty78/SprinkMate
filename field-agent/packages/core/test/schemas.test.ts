import { describe, expect, it } from "vitest";
import { assertSchema, checkSchema, emptyFacts, HeadFactsSchema, MeasurementSchema, validateSchema } from "../src/index.js";

describe("shared JSON contracts", () => {
  it("represents incomplete facts without pretending they are confirmed", () => {
    expect(checkSchema(HeadFactsSchema, emptyFacts())).toBe(true);
    expect(validateSchema(HeadFactsSchema, emptyFacts()).valid).toBe(true);
  });

  it("rejects unknown fields and arbitrary orientation strings", () => {
    expect(checkSchema(HeadFactsSchema, { ...emptyFacts(), pass: true })).toBe(false);
    const facts = emptyFacts();
    expect(checkSchema(HeadFactsSchema, { ...facts, orientation: { ...facts.orientation, value: "45 degrees is close enough" } })).toBe(false);
    expect(() => assertSchema(HeadFactsSchema, {})).toThrow("Invalid input");
  });

  it("requires manual units, endpoint labels, and a finite number", () => {
    const value = { id: "M1", targetId: "P1", method: "manual", unit: "m", valueMeters: 3, fromLabel: "A", toLabel: "B", evidenceIds: ["E1"] };
    expect(checkSchema(MeasurementSchema, value)).toBe(true);
    expect(checkSchema(MeasurementSchema, { ...value, unit: "feet" })).toBe(false);
    expect(checkSchema(MeasurementSchema, { ...value, valueMeters: Infinity })).toBe(false);
    expect(checkSchema(MeasurementSchema, { ...value, toLabel: undefined })).toBe(false);
  });
});
