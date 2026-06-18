import { describe, expect, it } from "vitest";

import {
    emptyElementReference,
    optionalElementReference,
    optionalInputFiles,
} from "./reactReferences";

describe("react reference utils", () => {
    it("normalizes empty DOM references and input files", () => {
        const element = document.createElement("div");
        const input = document.createElement("input");

        expect(emptyElementReference()).toBeFalsy();
        expect(optionalElementReference(element)).toBe(element);
        expect(optionalElementReference(emptyElementReference())).toBeUndefined();
        expect(optionalInputFiles(input)).toBeUndefined();
    });
});
