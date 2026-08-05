import { describe, expect, spyOn, test } from "bun:test";

import { isDashboardPasswordHash } from "../../shared/passwordHash.ts";
import { testDashboardPasswordHash } from "../../test/support/securityPassword.ts";
import {
    dashboardPasswordHashPolicy,
    hashDashboardPassword,
    verifyDashboardPassword,
} from "./password.ts";

describe("Dashboard password policy", () => {
    test("pins the reviewed Argon2id work factors", () => {
        expect(dashboardPasswordHashPolicy).toEqual({
            algorithm: "argon2id",
            memoryCost: 65_536,
            timeCost: 3,
        });
    });

    test("contains malformed persisted hashes", async () => {
        expect(await verifyDashboardPassword("password", "not-a-hash")).toBeFalse();
    });

    test("rejects unreviewed PHC work factors before invoking Bun", async () => {
        const unreviewedHash = testDashboardPasswordHash.replace("t=3", "t=9");
        const verify = spyOn(Bun.password, "verify").mockImplementation(() =>
            Promise.resolve(false)
        );
        try {
            expect(await verifyDashboardPassword("password", unreviewedHash)).toBeFalse();
            expect(verify).toHaveBeenCalledTimes(0);
        } finally {
            verify.mockRestore();
        }
    });

    test("accepts only the canonical pinned Bun PHC representation", () => {
        expect(isDashboardPasswordHash(testDashboardPasswordHash)).toBeTrue();
        for (const invalid of [
            testDashboardPasswordHash.replace("v=19", "v=16"),
            testDashboardPasswordHash.replace("m=65536", "m=065536"),
            testDashboardPasswordHash.replace("t=3", "t=4"),
            testDashboardPasswordHash.replace("p=1", "p=2"),
            testDashboardPasswordHash.replace("m=65536,t=3", "t=3,m=65536"),
            testDashboardPasswordHash.replace("argon2id", "argon2i"),
            `${testDashboardPasswordHash}=`,
            testDashboardPasswordHash.replace("A", "-"),
            `${testDashboardPasswordHash}\n`,
            `${testDashboardPasswordHash}\0`,
            `${testDashboardPasswordHash.slice(0, -1)}B`,
        ]) {
            expect(isDashboardPasswordHash(invalid)).toBeFalse();
        }
    });

    test("fails closed when Bun returns an unexpected hash representation", () => {
        const hash = spyOn(Bun.password, "hash").mockImplementation(() =>
            Promise.resolve("not-a-dashboard-password-hash")
        );
        try {
            expect(hashDashboardPassword("correct-horse-battery-staple")).rejects.toThrow(
                "unsupported Dashboard password hash"
            );
        } finally {
            hash.mockRestore();
        }
    });

    test("round-trips the pinned Argon2id representation", async () => {
        const hash = await hashDashboardPassword("correct-horse-battery-staple");

        expect(isDashboardPasswordHash(hash)).toBeTrue();
        expect(
            await verifyDashboardPassword("correct-horse-battery-staple", hash)
        ).toBeTrue();
        expect(await verifyDashboardPassword("wrong-password", hash)).toBeFalse();
    });
});
