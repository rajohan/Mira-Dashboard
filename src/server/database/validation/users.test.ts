import { describe, expect, test } from "bun:test";

import { subMilliseconds } from "date-fns";
import * as v from "valibot";

import { securityCreatedAt, validUserInsert } from "./testSupport/securityRows.ts";
import { userInsertSchema, userSelectSchema } from "./users.ts";

describe("user row schemas", () => {
    test("accepts a canonical Argon2id-backed operator row", () => {
        expect(v.parse(userInsertSchema, validUserInsert)).toEqual(validUserInsert);
        expect(
            v.parse(userSelectSchema, {
                ...validUserInsert,
                authenticationVersion: 1,
                disabledAt: null,
            })
        ).toBeDefined();
        for (const authenticationVersion of [0, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() =>
                v.parse(userSelectSchema, {
                    ...validUserInsert,
                    authenticationVersion,
                    disabledAt: null,
                })
            ).toThrow();
        }
    });

    test.each([
        { username: "Raymond" },
        { username: "ab" },
        { passwordHash: "not-an-argon2id-hash" },
        { passwordHash: `${validUserInsert.passwordHash}\0suffix` },
        { updatedAt: subMilliseconds(securityCreatedAt, 1) },
        { unexpected: true },
    ])("rejects invalid user row %#", (replacement) => {
        expect(() =>
            v.parse(userInsertSchema, { ...validUserInsert, ...replacement })
        ).toThrow();
    });

    test("keeps authenticationVersion database-owned on insert", () => {
        expect(() =>
            v.parse(userInsertSchema, {
                ...validUserInsert,
                authenticationVersion: 2,
            })
        ).toThrow();
    });
});
