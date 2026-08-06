import { describe, expect, test } from "bun:test";

import { generate } from "otplib";

import {
    createDashboardTotpUri,
    dashboardTotpPolicy,
    generateDashboardTotpSecret,
    isCanonicalTotpSecret,
    type VerifyTotpAtEpoch,
    verifyDashboardTotp,
} from "./totp.ts";

const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const inconsistentStepVerifier: VerifyTotpAtEpoch = () =>
    Promise.resolve({ timeStep: 99, valid: true });

describe("Dashboard TOTP policy", () => {
    test("pins the interoperable SHA-1, six-digit, thirty-second policy", () => {
        expect(dashboardTotpPolicy).toEqual({
            algorithm: "sha1",
            digits: 6,
            issuer: "Mira Dashboard",
            periodSeconds: 30,
            t0Seconds: 0,
        });
    });

    test("matches the RFC 6238 SHA-1 vector on the installed plugins", async () => {
        expect(
            await generate({
                algorithm: "sha1",
                digits: 8,
                epoch: 59,
                period: 30,
                secret: rfcSecret,
                strategy: "totp",
            })
        ).toBe("94287082");
    });

    test("generates canonical secrets and an explicit provisioning URI", () => {
        const secret = generateDashboardTotpSecret();
        const uri = new URL(createDashboardTotpUri("raymond", secret));

        expect(isCanonicalTotpSecret(secret)).toBeTrue();
        expect(uri.protocol).toBe("otpauth:");
        expect(uri.hostname).toBe("totp");
        expect(decodeURIComponent(uri.pathname)).toContain("Mira Dashboard:raymond");
        expect(uri.searchParams.get("secret")).toBe(secret);
        expect(uri.searchParams.get("issuer")).toBe("Mira Dashboard");
        // otplib's canonical URI omits interoperable default values.
        expect(uri.searchParams.get("algorithm")).toBeNull();
        expect(uri.searchParams.get("digits")).toBeNull();
        expect(uri.searchParams.get("period")).toBeNull();
    });

    test("checks current before previous when a visible token could match both", async () => {
        const calls: number[] = [];
        const verifier: VerifyTotpAtEpoch = (input) => {
            calls.push(input.epochSeconds);
            return Promise.resolve({
                timeStep: input.epochSeconds / 30,
                valid: true,
            });
        };

        expect(
            await verifyDashboardTotp(
                {
                    now: new Date(59_999),
                    secret: rfcSecret,
                    token: "123456",
                },
                verifier
            )
        ).toEqual({ timeStep: 1 });
        expect(calls).toEqual([30]);
    });

    test("falls back to only the immediately previous time step", async () => {
        const calls: number[] = [];
        const verifier: VerifyTotpAtEpoch = (input) => {
            calls.push(input.epochSeconds);
            return Promise.resolve(
                input.epochSeconds === 0 ? { timeStep: 0, valid: true } : { valid: false }
            );
        };

        expect(
            await verifyDashboardTotp(
                {
                    now: new Date(59_999),
                    secret: rfcSecret,
                    token: "123456",
                },
                verifier
            )
        ).toEqual({ timeStep: 0 });
        expect(calls).toEqual([30, 0]);
    });

    test("changes the current step at the exact thirty-second boundary", async () => {
        const calls: number[] = [];
        const verifier: VerifyTotpAtEpoch = (input) => {
            calls.push(input.epochSeconds);
            return Promise.resolve({
                timeStep: input.epochSeconds / 30,
                valid: true,
            });
        };

        expect(
            await verifyDashboardTotp(
                {
                    now: new Date(29_999),
                    secret: rfcSecret,
                    token: "123456",
                },
                verifier
            )
        ).toEqual({ timeStep: 0 });
        expect(
            await verifyDashboardTotp(
                {
                    now: new Date(30_000),
                    secret: rfcSecret,
                    token: "123456",
                },
                verifier
            )
        ).toEqual({ timeStep: 1 });
        expect(calls).toEqual([0, 30]);
    });

    test("uses the injected time for real current, previous, and future codes", async () => {
        const currentToken = await generate({
            algorithm: "sha1",
            digits: 6,
            epoch: 59,
            period: 30,
            secret: rfcSecret,
            strategy: "totp",
        });
        const previousToken = await generate({
            algorithm: "sha1",
            digits: 6,
            epoch: 29,
            period: 30,
            secret: rfcSecret,
            strategy: "totp",
        });
        const futureToken = await generate({
            algorithm: "sha1",
            digits: 6,
            epoch: 60,
            period: 30,
            secret: rfcSecret,
            strategy: "totp",
        });
        const input = { now: new Date(59_000), secret: rfcSecret };

        expect(await verifyDashboardTotp({ ...input, token: currentToken })).toEqual({
            timeStep: 1,
        });
        expect(await verifyDashboardTotp({ ...input, token: previousToken })).toEqual({
            timeStep: 0,
        });
        expect(
            await verifyDashboardTotp({ ...input, token: futureToken })
        ).toBeUndefined();
    });

    test("skips replayed steps and rejects malformed inputs before otplib", async () => {
        let calls = 0;
        const verifier: VerifyTotpAtEpoch = () => {
            calls += 1;
            return Promise.resolve({ valid: false });
        };

        expect(
            await verifyDashboardTotp(
                {
                    lastUsedTimeStep: 1,
                    now: new Date(59_999),
                    secret: rfcSecret,
                    token: "123456",
                },
                verifier
            )
        ).toBeUndefined();
        expect(
            await verifyDashboardTotp(
                {
                    now: new Date(59_999),
                    secret: "not-a-secret",
                    token: "123456",
                },
                verifier
            )
        ).toBeUndefined();
        expect(
            await verifyDashboardTotp(
                {
                    now: new Date(59_999),
                    secret: rfcSecret,
                    token: "12345x",
                },
                verifier
            )
        ).toBeUndefined();
        expect(calls).toBe(0);
    });

    test("rejects inconsistent verifier output", () => {
        expect(
            verifyDashboardTotp(
                {
                    now: new Date(59_999),
                    secret: rfcSecret,
                    token: "123456",
                },
                inconsistentStepVerifier
            )
        ).rejects.toThrow("TOTP verifier returned an inconsistent time step");
    });
});
