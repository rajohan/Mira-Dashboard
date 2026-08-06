import { expect, test } from "bun:test";

import { toDate } from "date-fns";
import * as v from "valibot";

import { nonnegativeDateAction, timestampMillisecondsSchema } from "./dateTime.ts";

test("accepts only nonnegative safe epoch milliseconds supported by Date", () => {
    const schema = timestampMillisecondsSchema();

    expect(v.parse(schema, 0)).toBe(0);
    expect(v.parse(schema, 8_640_000_000_000_000)).toBe(8_640_000_000_000_000);

    for (const value of [-1, 1.5, 8_640_000_000_000_001]) {
        expect(v.safeParse(schema, value).success).toBeFalse();
    }
});

test("accepts only valid Dates on or after the Unix epoch", () => {
    const schema = v.pipe(v.date(), nonnegativeDateAction());

    expect(v.parse(schema, toDate(0))).toEqual(toDate(0));
    expect(v.safeParse(schema, toDate(-1)).success).toBeFalse();
    expect(v.safeParse(schema, toDate(Number.NaN)).success).toBeFalse();
});
