import path from "node:path";

import {
    parseReleaseManifest,
    releaseBuildCommands,
    releaseProcessRoles,
} from "../../../shared/releaseManifest.ts";
import { readRuntimeIdentity } from "../runtime/readRuntimeIdentity.ts";
import type { RuntimeRelease } from "./runtimeRelease.ts";

const fullCommitShaPattern = /^[\da-f]{40}$/u;
const placeholderSha256 = "0".repeat(64);

/**
 * Creates the in-memory source identity used by development composition roots.
 * It is never serialized, published, activated, or accepted by the production
 * runtime-release loader; production startup therefore retains its immutable-file checks.
 * @param repositoryRoot Canonical self-contained repository root.
 * @param sourceCommitSha Exact Git commit from which the development checkout was created.
 * @returns A typed source/runtime identity compatible with existing process composition seams.
 */
export function createDevelopmentRuntimeRelease(
    repositoryRoot: string,
    sourceCommitSha: string
): RuntimeRelease {
    if (
        !path.isAbsolute(repositoryRoot) ||
        path.resolve(repositoryRoot) !== repositoryRoot ||
        repositoryRoot === path.parse(repositoryRoot).root ||
        !fullCommitShaPattern.test(sourceCommitSha)
    ) {
        throw new TypeError("Development source identity is invalid");
    }
    const runtime = readRuntimeIdentity();
    const manifest = parseReleaseManifest({
        artifacts: [
            {
                bytes: 0,
                path: "development.marker",
                sha256: placeholderSha256,
            },
        ],
        buildCommands: releaseBuildCommands,
        documentationSha256: placeholderSha256,
        formatVersion: 1,
        lockfileSha256: placeholderSha256,
        migrations: [
            {
                id: "00000000000000_development",
                migrationSha256: placeholderSha256,
                snapshotSha256: placeholderSha256,
            },
        ],
        packages: [
            {
                name: "mira-dashboard",
                scope: "dependency",
                version: "0.0.0-development",
            },
        ],
        processRoles: releaseProcessRoles,
        runtime: {
            revision: runtime.revision,
            version: runtime.version,
        },
        source: {
            commitSha: sourceCommitSha,
            treeState: "clean",
        },
    });
    return Object.freeze({ manifest, releaseRoot: repositoryRoot });
}
