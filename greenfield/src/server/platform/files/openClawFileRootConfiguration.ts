import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { workspaceFileLimits } from "../../../contracts/files.ts";
import type {
    WorkspaceFileManifestEntry,
    WorkspaceFileRootConfiguration,
} from "../../domains/files/ports.ts";

const openClawManifest = Object.freeze([
    Object.freeze({
        contentPolicy: "redacted-config-json",
        maximumSizeBytes: workspaceFileLimits.maximumTextPreviewBytes,
        segments: Object.freeze(["openclaw.json"]),
    }),
    Object.freeze({
        contentPolicy: "raw",
        maximumSizeBytes: workspaceFileLimits.maximumTextPreviewBytes,
        segments: Object.freeze(["hooks", "transforms", "agentmail.ts"]),
    }),
] satisfies readonly WorkspaceFileManifestEntry[]);

function invalidOpenClawRoot(): TypeError {
    return new TypeError("OpenClaw file root is invalid");
}

function sameSegments(left: readonly string[], right: readonly string[]): boolean {
    return (
        left.length === right.length &&
        left.every((segment, index) => segment === right[index])
    );
}

/**
 * Rejects any composition-time attempt to substitute a broader OpenClaw manifest.
 * @param configuration Candidate resolved root configuration.
 * @returns Nothing.
 */
export function assertReviewedOpenClawFileRoot(
    configuration: WorkspaceFileRootConfiguration
): void {
    if (
        configuration.id !== "openclaw-config" ||
        configuration.label !== "OpenClaw Config" ||
        configuration.writable ||
        configuration.manifest?.length !== openClawManifest.length ||
        !openClawManifest.every((reviewed, index) => {
            const candidate = configuration.manifest?.[index];
            return (
                candidate !== undefined &&
                candidate.contentPolicy === reviewed.contentPolicy &&
                candidate.maximumSizeBytes === reviewed.maximumSizeBytes &&
                sameSegments(candidate.segments, reviewed.segments)
            );
        })
    ) {
        throw invalidOpenClawRoot();
    }
}

function pathsOverlap(left: string, right: string): boolean {
    const relative = path.relative(left, right);
    return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) &&
            relative !== ".." &&
            !path.isAbsolute(relative))
    );
}

/**
 * Resolves the explicit OpenClaw configuration root used by web startup.
 * Only the fixed manifest is returned; callers never derive this path from HOME.
 * @param openClawRoot Explicit configured OpenClaw home.
 * @param productionRoot Canonical Dashboard production root to fence out.
 * @returns Fixed read-only manifest configuration.
 */
export async function resolveReviewedOpenClawFileRoot(
    openClawRoot: string,
    productionRoot: string
): Promise<WorkspaceFileRootConfiguration> {
    if (
        process.platform !== "linux" ||
        typeof process.getuid !== "function" ||
        !path.isAbsolute(openClawRoot) ||
        path.resolve(openClawRoot) !== openClawRoot ||
        openClawRoot === path.parse(openClawRoot).root ||
        !path.isAbsolute(productionRoot) ||
        path.resolve(productionRoot) !== productionRoot ||
        productionRoot === path.parse(productionRoot).root
    ) {
        throw invalidOpenClawRoot();
    }
    try {
        const [canonical, status] = await Promise.all([
            realpath(openClawRoot),
            lstat(openClawRoot, { bigint: true }),
        ]);
        if (
            canonical !== openClawRoot ||
            !status.isDirectory() ||
            status.isSymbolicLink() ||
            status.uid !== BigInt(process.getuid()) ||
            (status.mode & 0o777n) !== 0o700n ||
            pathsOverlap(openClawRoot, productionRoot) ||
            pathsOverlap(productionRoot, openClawRoot)
        ) {
            throw invalidOpenClawRoot();
        }
    } catch {
        throw invalidOpenClawRoot();
    }
    const configuration = Object.freeze({
        id: "openclaw-config",
        label: "OpenClaw Config",
        manifest: openClawManifest,
        path: openClawRoot,
        writable: false,
    });
    assertReviewedOpenClawFileRoot(configuration);
    return configuration;
}
