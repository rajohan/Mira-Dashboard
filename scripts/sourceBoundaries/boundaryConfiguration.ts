import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { SourceBoundaryViolation } from "./policyTypes.ts";
import { boundaryPathViolation, isContainedPath } from "./sourceBoundaryPaths.ts";

/** Root dependency names and configuration findings used by boundary validation. */
export interface BoundaryConfiguration {
    readonly declaredPackageNames: ReadonlySet<string>;
    readonly violations: readonly SourceBoundaryViolation[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null;
}

async function readRootJson(
    projectRoot: string,
    relativePath: string,
    violations: SourceBoundaryViolation[]
): Promise<Readonly<Record<string, unknown>> | undefined> {
    const absolutePath = path.join(projectRoot, relativePath);
    const status = await lstat(absolutePath);
    if (status.isSymbolicLink() || !status.isFile()) {
        violations.push(
            boundaryPathViolation(
                relativePath,
                "Boundary configuration must be a regular non-symbolic-link file"
            )
        );
        return undefined;
    }
    const realProjectRoot = await realpath(projectRoot);
    if (!isContainedPath(realProjectRoot, await realpath(absolutePath))) {
        violations.push(
            boundaryPathViolation(
                relativePath,
                "Boundary configuration real path escapes the repository"
            )
        );
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(await Bun.file(absolutePath).text()) as unknown;
    } catch {
        violations.push(
            boundaryPathViolation(
                relativePath,
                "Boundary configuration must be valid JSON"
            )
        );
        return undefined;
    }
    if (!isRecord(parsed)) {
        violations.push(
            boundaryPathViolation(
                relativePath,
                "Boundary configuration must be an object"
            )
        );
        return undefined;
    }
    return parsed;
}

function dependencyNames(
    packageManifest: Readonly<Record<string, unknown>>
): ReadonlySet<string> {
    const names = new Set<string>();
    for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ] as const) {
        const dependencies = packageManifest[field];
        if (!isRecord(dependencies)) continue;
        for (const name of Object.keys(dependencies)) names.add(name);
    }
    return names;
}

/**
 * Reads and validates the root package and TypeScript resolver configuration.
 * @param projectRoot Absolute repository root.
 * @returns Declared package names and configuration findings.
 */
export async function readBoundaryConfiguration(
    projectRoot: string
): Promise<BoundaryConfiguration> {
    const lexicalProjectRoot = path.resolve(projectRoot);
    const violations: SourceBoundaryViolation[] = [];
    const packageManifest = await readRootJson(
        lexicalProjectRoot,
        "package.json",
        violations
    );
    if (packageManifest?.imports !== undefined) {
        violations.push(
            boundaryPathViolation(
                "package.json",
                "Root package-import aliases are forbidden by the source-boundary policy"
            )
        );
    }
    if (packageManifest?.browser !== undefined) {
        violations.push(
            boundaryPathViolation(
                "package.json",
                "Root package browser mappings are forbidden until an exact source-boundary policy is reviewed"
            )
        );
    }
    if (packageManifest?.exports !== undefined) {
        violations.push(
            boundaryPathViolation(
                "package.json",
                "Root package exports are forbidden until an exact source-boundary policy is reviewed"
            )
        );
    }
    if (packageManifest?.workspaces !== undefined) {
        violations.push(
            boundaryPathViolation(
                "package.json",
                "Root package workspaces are forbidden until an exact source-boundary policy is reviewed"
            )
        );
    }
    if (packageManifest !== undefined) {
        for (const field of [
            "dependencies",
            "devDependencies",
            "optionalDependencies",
            "peerDependencies",
        ] as const) {
            const dependencies = packageManifest[field];
            if (!isRecord(dependencies)) continue;
            if (
                Object.values(dependencies).some(
                    (value) =>
                        typeof value === "string" &&
                        (/^(?:file|link|workspace):/u.test(value) ||
                            value.startsWith("./") ||
                            value.startsWith("../"))
                )
            ) {
                violations.push(
                    boundaryPathViolation(
                        "package.json",
                        "Local and workspace dependency aliases are forbidden by the source-boundary policy"
                    )
                );
                break;
            }
        }
    }

    const rootEntries = await readdir(lexicalProjectRoot, { withFileTypes: true });
    const tsconfigNames = rootEntries
        .filter(
            (entry) => entry.name.startsWith("tsconfig") && entry.name.endsWith(".json")
        )
        .map((entry) => entry.name)
        .toSorted();
    for (const tsconfigName of tsconfigNames) {
        const tsconfig = await readRootJson(lexicalProjectRoot, tsconfigName, violations);
        if (tsconfig === undefined) continue;
        const compilerOptions = tsconfig.compilerOptions;
        if (
            isRecord(compilerOptions) &&
            (compilerOptions.baseUrl !== undefined || compilerOptions.paths !== undefined)
        ) {
            violations.push(
                boundaryPathViolation(
                    tsconfigName,
                    "TypeScript baseUrl and paths aliases are forbidden by the source-boundary policy"
                )
            );
        }
        if (
            tsconfig.extends !== undefined &&
            (tsconfigName === "tsconfig.json" || tsconfig.extends !== "./tsconfig.json")
        ) {
            violations.push(
                boundaryPathViolation(
                    tsconfigName,
                    "Root TypeScript partitions may extend only the exact reviewed ./tsconfig.json configuration"
                )
            );
        }
    }
    return {
        declaredPackageNames:
            packageManifest === undefined ? new Set() : dependencyNames(packageManifest),
        violations,
    };
}
