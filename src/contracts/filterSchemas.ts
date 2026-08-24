import * as v from "valibot";

import { hasUniqueArrayItems } from "../shared/validation.ts";

/** @returns One bounded, non-empty filter with unique string values. */
export function uniqueFilterSchema<
    TOutput extends string,
    TSchema extends v.GenericSchema<string, TOutput>,
>(item: TSchema, label: string, maximum: number) {
    return v.pipe(
        v.array(item, `${label} filter is invalid`),
        v.minLength(1, `${label} filter cannot be empty`),
        v.maxLength(maximum, `${label} filter is outside its budget`),
        v.check(hasUniqueArrayItems<TOutput>, `${label} filter values must be unique`)
    );
}

/** @returns One bounded, non-empty filter from a fixed string vocabulary. */
export function enumFilterSchema<const TValues extends readonly [string, ...string[]]>(
    values: TValues,
    label: string,
    maximum: number
) {
    return v.pipe(
        v.array(v.picklist(values, `${label} value is invalid`)),
        v.minLength(1, `${label} filter cannot be empty`),
        v.maxLength(maximum, `${label} filter is outside its budget`),
        v.check(
            hasUniqueArrayItems<TValues[number]>,
            `${label} filter values must be unique`
        )
    );
}
