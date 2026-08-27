import { describe, expect, test } from "bun:test";

import {
    parseReleaseManifest,
    releaseBuildCommands,
    releaseDeliveryProtocols,
    releaseProcessRoles,
    serializeReleaseManifest,
} from "./releaseManifest.ts";

const checksum = "a".repeat(64);
const commitSha = "b".repeat(40);

function manifest() {
    return {
        formatVersion: 1,
        source: { commitSha, treeState: "clean" },
        runtime: { revision: "c".repeat(40), version: "1.4.0" },
        lockfileSha256: checksum,
        documentationSha256: "d".repeat(64),
        buildCommands: [...releaseBuildCommands],
        deliveryProtocols: [...releaseDeliveryProtocols],
        display: {
            builtAtMs: 1_800_000_000_000,
            commitTitle: "Test release",
            schemaTarget: 1,
        },
        processRoles: [...releaseProcessRoles],
        packages: [
            { name: "@trpc/server", scope: "dependency", version: "11.18.0" },
            { name: "typescript", scope: "devDependency", version: "7.0.2" },
        ],
        migrations: [
            {
                id: "20260804022252_dashboard-foundation",
                migrationSha256: "e".repeat(64),
                snapshotSha256: "f".repeat(64),
            },
        ],
        artifacts: [
            { bytes: 42, path: "browser/index.html", sha256: "1".repeat(64) },
            { bytes: 84, path: "server/web.js", sha256: "2".repeat(64) },
        ],
    };
}

describe("release manifest", () => {
    test("parses, deeply freezes and deterministically serializes the complete identity", () => {
        const parsed = parseReleaseManifest(manifest());

        expect(parsed).toEqual(manifest());
        expect(Object.isFrozen(parsed)).toBe(true);
        expect(Object.isFrozen(parsed.display)).toBe(true);
        expect(Object.isFrozen(parsed.artifacts)).toBe(true);
        expect(Object.isFrozen(parsed.artifacts[0])).toBe(true);
        expect(Object.isFrozen(parsed.packages[0])).toBe(true);
        expect(serializeReleaseManifest(parsed)).toBe(
            `${JSON.stringify(parsed, null, 2)}\n`
        );
    });

    test("rejects dirty sources, unknown fields and malformed runtime identity", () => {
        expect(() =>
            parseReleaseManifest({
                ...manifest(),
                source: { commitSha, treeState: "dirty" },
            })
        ).toThrow("Release manifest is invalid");
        expect(() => parseReleaseManifest({ ...manifest(), secret: "private" })).toThrow(
            "Release manifest is invalid"
        );
        expect(() =>
            parseReleaseManifest({
                ...manifest(),
                runtime: { revision: "short", version: "1.4.0" },
            })
        ).toThrow("Release manifest is invalid");
    });

    test("accepts the reviewed systemd template artifact segment", () => {
        const candidate = manifest();
        expect(
            parseReleaseManifest({
                ...candidate,
                artifacts: [
                    candidate.artifacts[0],
                    {
                        bytes: 84,
                        path: "systemd/mira-dashboard-log-maintenance@.service",
                        sha256: "2".repeat(64),
                    },
                ],
            }).artifacts[1]?.path
        ).toBe("systemd/mira-dashboard-log-maintenance@.service");
    });

    test("accepts generated migration identifiers with underscore words", () => {
        const candidate = manifest();
        expect(
            parseReleaseManifest({
                ...candidate,
                migrations: [
                    {
                        ...candidate.migrations[0],
                        id: "20260827190406_eager_lizard",
                    },
                ],
            }).migrations[0]?.id
        ).toBe("20260827190406_eager_lizard");
    });

    test("rejects unordered identities and path traversal", () => {
        const candidate = manifest();
        expect(() =>
            parseReleaseManifest({
                ...candidate,
                packages: candidate.packages.toReversed(),
            })
        ).toThrow("Release manifest is invalid");
        expect(() =>
            parseReleaseManifest({
                ...candidate,
                artifacts: [{ bytes: 1, path: "../secret", sha256: "1".repeat(64) }],
            })
        ).toThrow("Release manifest is invalid");
        expect(() =>
            parseReleaseManifest({
                ...candidate,
                artifacts: [
                    {
                        bytes: 1,
                        path: "browser/control\u0001.js",
                        sha256: "1".repeat(64),
                    },
                ],
            })
        ).toThrow("Release manifest is invalid");
    });

    test("rejects a release without direct package identity", () => {
        expect(() =>
            parseReleaseManifest({
                ...manifest(),
                packages: [],
            })
        ).toThrow("Release manifest is invalid");
    });
});
