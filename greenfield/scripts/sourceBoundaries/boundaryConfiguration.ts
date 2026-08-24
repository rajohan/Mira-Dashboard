import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { parse, type ParseError } from "jsonc-parser";

import type { SourceBoundaryViolation } from "./policyTypes.ts";
import { boundaryPathViolation, isContainedPath } from "./sourceBoundaryPaths.ts";

/** Root dependency names and configuration findings used by boundary validation. */
export interface BoundaryConfiguration {
    readonly declaredPackageNames: ReadonlySet<string>;
    readonly violations: readonly SourceBoundaryViolation[];
}

type ReviewedCompilerOption = boolean | string | readonly string[];

interface TypeScriptConfigurationPolicy {
    readonly compilerOptions?: Readonly<Record<string, ReviewedCompilerOption>>;
    readonly exclude?: readonly string[];
    readonly extends?: "./tsconfig.json";
    readonly files?: readonly string[];
    readonly include?: readonly string[];
    readonly references?: readonly string[];
}

const reviewedTypeScriptConfigurations: Readonly<
    Record<string, TypeScriptConfigurationPolicy>
> = Object.freeze({
    "tsconfig.json": {
        compilerOptions: {
            allowImportingTsExtensions: true,
            erasableSyntaxOnly: true,
            forceConsistentCasingInFileNames: true,
            module: "Preserve",
            moduleDetection: "force",
            moduleResolution: "bundler",
            noEmit: true,
            noFallthroughCasesInSwitch: true,
            noImplicitAny: true,
            noImplicitOverride: true,
            noImplicitReturns: true,
            noUncheckedIndexedAccess: true,
            noUncheckedSideEffectImports: true,
            noUnusedLocals: true,
            noUnusedParameters: true,
            skipLibCheck: true,
            strict: true,
            target: "ESNext",
            verbatimModuleSyntax: true,
        },
        files: [],
        references: ["./tsconfig.browser.json", "./tsconfig.bun.json"],
    },
    "tsconfig.browser.json": {
        compilerOptions: {
            jsx: "react-jsx",
            lib: ["ESNext", "DOM", "DOM.Iterable"],
            types: [],
            useDefineForClassFields: true,
        },
        exclude: ["node_modules"],
        extends: "./tsconfig.json",
        files: [
            "node_modules/bun-types/test.d.ts",
            "src/test/types/bunCanaryMatchers.d.ts",
        ],
        include: ["src/browser/**/*.ts", "src/browser/**/*.tsx"],
    },
    "tsconfig.bun.json": {
        compilerOptions: {
            lib: ["ESNext"],
            types: ["bun-types", "node"],
        },
        exclude: ["node_modules", "src/browser/**/*"],
        extends: "./tsconfig.json",
        include: ["**/*"],
    },
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function equalsStringArray(value: unknown, expected: readonly string[]): boolean {
    return (
        Array.isArray(value) &&
        value.length === expected.length &&
        value.every((entry, index) => entry === expected[index])
    );
}

function equalsCompilerOptions(
    value: unknown,
    expected: Readonly<Record<string, ReviewedCompilerOption>>
): boolean {
    if (!isRecord(value)) return false;
    const actualNames = Object.keys(value).toSorted();
    const expectedNames = Object.keys(expected).toSorted();
    return (
        equalsStringArray(actualNames, expectedNames) &&
        expectedNames.every((name) => {
            const expectedValue = expected[name];
            return typeof expectedValue === "object"
                ? equalsStringArray(value[name], expectedValue)
                : value[name] === expectedValue;
        })
    );
}

function equalsReferences(value: unknown, expected: readonly string[]): boolean {
    return (
        Array.isArray(value) &&
        value.length === expected.length &&
        value.every((entry, index) => {
            const expectedPath = expected[index];
            return (
                isRecord(entry) &&
                equalsStringArray(Object.keys(entry), ["path"]) &&
                entry.path === expectedPath
            );
        })
    );
}

function hasReviewedTypeScriptConfiguration(
    tsconfig: Readonly<Record<string, unknown>>,
    policy: TypeScriptConfigurationPolicy
): boolean {
    const expectedTopLevelNames: string[] = [];
    if (policy.compilerOptions !== undefined) {
        expectedTopLevelNames.push("compilerOptions");
    }
    if (policy.exclude !== undefined) expectedTopLevelNames.push("exclude");
    if (policy.extends !== undefined) expectedTopLevelNames.push("extends");
    if (policy.files !== undefined) expectedTopLevelNames.push("files");
    if (policy.include !== undefined) expectedTopLevelNames.push("include");
    if (policy.references !== undefined) expectedTopLevelNames.push("references");
    return (
        equalsStringArray(
            Object.keys(tsconfig).toSorted(),
            expectedTopLevelNames.toSorted()
        ) &&
        (policy.compilerOptions === undefined
            ? tsconfig.compilerOptions === undefined
            : equalsCompilerOptions(tsconfig.compilerOptions, policy.compilerOptions)) &&
        tsconfig.extends === policy.extends &&
        (policy.include === undefined
            ? tsconfig.include === undefined
            : equalsStringArray(tsconfig.include, policy.include)) &&
        (policy.files === undefined
            ? tsconfig.files === undefined
            : equalsStringArray(tsconfig.files, policy.files)) &&
        (policy.exclude === undefined
            ? tsconfig.exclude === undefined
            : equalsStringArray(tsconfig.exclude, policy.exclude)) &&
        (policy.references === undefined
            ? tsconfig.references === undefined
            : equalsReferences(tsconfig.references, policy.references))
    );
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
        const source = await Bun.file(absolutePath).text();
        if (relativePath === "package.json") {
            parsed = JSON.parse(source) as unknown;
        } else {
            const parseErrors: ParseError[] = [];
            parsed = parse(source, parseErrors, {
                allowTrailingComma: true,
                disallowComments: false,
            });
            if (parseErrors.length > 0) {
                throw new SyntaxError("TypeScript configuration is not valid JSONC");
            }
        }
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
 * Reads and validates the root package and TypeScript boundary configuration.
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
    const tsconfigNameSet = new Set(tsconfigNames);
    for (const reviewedName of Object.keys(reviewedTypeScriptConfigurations)) {
        if (!tsconfigNameSet.has(reviewedName)) {
            violations.push(
                boundaryPathViolation(
                    reviewedName,
                    "Reviewed TypeScript boundary configuration is missing"
                )
            );
        }
    }
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
        const configurationPolicy = reviewedTypeScriptConfigurations[tsconfigName];
        if (
            tsconfig.extends !== undefined &&
            (configurationPolicy === undefined ||
                tsconfig.extends !== configurationPolicy.extends)
        ) {
            violations.push(
                boundaryPathViolation(
                    tsconfigName,
                    "TypeScript partitions may extend only their exact reviewed configuration"
                )
            );
        }
        if (
            configurationPolicy !== undefined &&
            !hasReviewedTypeScriptConfiguration(tsconfig, configurationPolicy)
        ) {
            violations.push(
                boundaryPathViolation(
                    tsconfigName,
                    "TypeScript boundary authority and graph membership must match the exact reviewed configuration"
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
