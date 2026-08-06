import { describe, expect, test } from "bun:test";

import { rejectionError } from "../testSupport/rejection.ts";
import {
    parseActivateProductionReleaseArguments,
    runActivateProductionReleaseCli,
} from "./activateProductionRelease.ts";

const releaseId = "a".repeat(40);
const runtimeRevision = "b".repeat(40);
const transitionId = "019fd974-54a2-74dd-a64b-d4186f8d8828";
const validArguments = Object.freeze([
    "--project-root=/srv/mira-dashboard",
    "--release-root=/srv/mira-dashboard-build/releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "--readiness-url=http://127.0.0.1:3100/api/health/ready",
    "--runtime-source=/opt/bun/candidate/bun",
]);

describe("production release activation CLI", () => {
    test("parses an exact order-independent activation request", () => {
        expect(parseActivateProductionReleaseArguments(validArguments)).toEqual({
            projectRoot: "/srv/mira-dashboard",
            readinessUrl: "http://127.0.0.1:3100/api/health/ready",
            releaseRoot:
                "/srv/mira-dashboard-build/releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            runtimeSource: "/opt/bun/candidate/bun",
        });
        expect(
            parseActivateProductionReleaseArguments(validArguments.toReversed())
        ).toEqual(parseActivateProductionReleaseArguments(validArguments));
    });

    test("rejects unknown, duplicate, external-readiness, and relative inputs", () => {
        const invalidArguments = [
            [...validArguments, "--unknown=value"],
            [...validArguments, validArguments[0]!],
            validArguments.map((argument) =>
                argument.startsWith("--readiness-url=")
                    ? "--readiness-url=https://dashboard.example.test/api/health/ready"
                    : argument
            ),
            validArguments.map((argument) =>
                argument.startsWith("--release-root=")
                    ? "--release-root=dist/releases/candidate"
                    : argument
            ),
        ];
        for (const arguments_ of invalidArguments) {
            expect(() => parseActivateProductionReleaseArguments(arguments_)).toThrow(
                "Usage: bun run delivery:activate"
            );
        }
    });

    test("returns only the committed public activation identity", async () => {
        const observed: unknown[] = [];
        const result = await runActivateProductionReleaseCli(validArguments, {
            activate: (options) => {
                observed.push(options);
                return Promise.resolve({
                    current: { releaseId, runtimeRevision },
                    formatVersion: 1,
                    previous: null,
                    transitionId,
                });
            },
        });
        expect(observed).toEqual([
            parseActivateProductionReleaseArguments(validArguments),
        ]);
        expect(result).toEqual({ releaseId, status: "ACTIVATED", transitionId });

        const failure = await rejectionError(
            runActivateProductionReleaseCli(validArguments, {
                activate: () => Promise.reject(new Error("private failure")),
            })
        );
        expect(failure.message).toBe("private failure");
    });
});
