import { describe, expect, test } from "bun:test";

import { touchedFormFieldError } from "./formErrors.ts";

describe("touchedFormFieldError", () => {
    test("shows an untouched field error after submit validation", () => {
        expect(
            touchedFormFieldError({
                errorMap: { onSubmit: "Enter a progress update." },
                errors: ["Enter a progress update."],
                isTouched: false,
            })
        ).toBe("Enter a progress update.");
    });

    test("hides an untouched field error before submit validation", () => {
        expect(
            touchedFormFieldError({
                errors: ["Enter a progress update."],
                isTouched: false,
            })
        ).toBeUndefined();
    });
});
