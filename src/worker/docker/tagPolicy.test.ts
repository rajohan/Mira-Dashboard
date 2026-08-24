import { describe, expect, test } from "bun:test";

import {
    buildDockerTargetImageReference,
    compareDockerTags,
    createDockerTagPolicy,
    isSafeDockerTagRegex,
    matchesDockerTagPolicy,
    parseDockerImageReference,
} from "./tagPolicy.ts";

describe("Docker updater tag policy", () => {
    test("matches the deployed bounded version-pattern grammar without RegExp execution", () => {
        const patterns = [
            [String.raw`^\d+\.\d+\.\d+$`, "18.4.2"],
            [String.raw`^v\d+\.\d+\.\d+$`, "v3.41.3"],
            [String.raw`^\d+\.\d+\-alpine\d+\.\d+$`, "18.4-alpine3.24"],
            [String.raw`^latest$`, "latest"],
        ] as const;
        for (const [pattern, matchingTag] of patterns) {
            expect(isSafeDockerTagRegex(pattern)).toBe(true);
            expect(
                matchesDockerTagPolicy({ matchType: "regex", pattern }, matchingTag)
            ).toBe(true);
        }
        expect(
            matchesDockerTagPolicy(
                { matchType: "regex", pattern: String.raw`^v\d+\.\d+\.\d+$` },
                "3.41.3"
            )
        ).toBe(false);
    });

    test("rejects unbounded, optional, alternation, grouping and character-wildcard regexes", () => {
        for (const pattern of [
            "",
            "latest",
            "^.*$",
            "^(latest|stable)$",
            String.raw`^v\d+(?:\.\d+)?$`,
            "^v[0-9]*$",
            "^v.+$",
            String.raw`^v\d+1$`,
            `^${"a".repeat(300)}$`,
        ]) {
            expect(isSafeDockerTagRegex(pattern)).toBe(false);
            expect(createDockerTagPolicy({ pattern })).toBeUndefined();
        }
    });

    test("orders arbitrarily large digit runs deterministically", () => {
        const tags = ["v2.10.0", "v2.9.0", "v10.0.0", `v${"9".repeat(100)}.0.0`];
        expect(tags.toSorted(compareDockerTags)).toEqual([
            "v2.9.0",
            "v2.10.0",
            "v10.0.0",
            `v${"9".repeat(100)}.0.0`,
        ]);
    });

    test("parses only Docker Hub, GHCR and LSCR literal image references", () => {
        expect(parseDockerImageReference("postgres:18.4-alpine3.24")).toEqual({
            name: "postgres",
            registry: "docker.io",
            repository: "library/postgres",
            tag: "18.4-alpine3.24",
        });
        expect(
            parseDockerImageReference(
                `ghcr.io/example/app:latest@sha256:${"a".repeat(64)}`
            )
        ).toEqual({
            digest: `sha256:${"a".repeat(64)}`,
            name: "ghcr.io/example/app",
            registry: "ghcr.io",
            repository: "example/app",
            tag: "latest",
        });
        expect(parseDockerImageReference("lscr.io/linuxserver/jackett:1.2.3")).toEqual({
            name: "lscr.io/linuxserver/jackett",
            registry: "lscr.io",
            repository: "linuxserver/jackett",
            tag: "1.2.3",
        });
        for (const invalid of [
            "quay.io/example/app:latest",
            "ghcr.io/Example/App:latest",
            "ghcr.io/example/app:${TAG}",
            "ghcr.io/example/app@sha256:short",
            "ghcr.io/example/app:tag with spaces",
        ]) {
            expect(parseDockerImageReference(invalid)).toBeUndefined();
        }
    });

    test("builds tag and digest update scalars without changing repository spelling", () => {
        const digest = `sha256:${"b".repeat(64)}`;
        expect(
            buildDockerTargetImageReference(
                "postgres:18.4-alpine3.24@sha256:" + "a".repeat(64),
                { digest, tag: "18.5-alpine3.24" },
                "digest"
            )
        ).toBe(`postgres:18.5-alpine3.24@${digest}`);
        expect(
            buildDockerTargetImageReference(
                "ghcr.io/example/app:latest@sha256:" + "a".repeat(64),
                { digest, tag: "latest" },
                "tag"
            )
        ).toBe("ghcr.io/example/app:latest");
    });
});
