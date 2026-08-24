import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkSourceBoundaries } from "../checkSourceBoundaries.ts";
import { temporaryProject } from "./testSupport.ts";

describe("source-boundary root configuration", () => {
    test("accepts TypeScript JSONC while keeping package.json strict", async () => {
        const projectRoot = await temporaryProject();
        try {
            await writeFile(
                path.join(projectRoot, "tsconfig.json"),
                `{
                    // TypeScript configuration permits comments.
                    "compilerOptions": {},
                }`
            );

            const violations = await checkSourceBoundaries(projectRoot);

            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "tsconfig.json" &&
                        violation.message.includes("valid JSON")
                )
            ).toBe(false);

            await writeFile(path.join(projectRoot, "package.json"), "{/* invalid */}");
            const strictViolations = await checkSourceBoundaries(projectRoot);
            expect(
                strictViolations.some(
                    (violation) =>
                        violation.importer === "package.json" &&
                        violation.message.includes("valid JSON")
                )
            ).toBe(true);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("rejects array-shaped root and dependency configuration", async () => {
        const projectRoot = await temporaryProject();
        try {
            await writeFile(path.join(projectRoot, "package.json"), "[]");
            let violations = await checkSourceBoundaries(projectRoot);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "package.json" &&
                        violation.message.includes("must be an object")
                )
            ).toBe(true);

            await writeFile(
                path.join(projectRoot, "package.json"),
                JSON.stringify({ dependencies: ["undeclared-array-package"] })
            );
            await writeFile(
                path.join(projectRoot, "src", "browser", "arrayDependency.ts"),
                'import value from "undeclared-array-package"; void value;'
            );
            violations = await checkSourceBoundaries(projectRoot);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/browser/arrayDependency.ts" &&
                        violation.message.includes("declared by the root manifest")
                )
            ).toBe(true);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("rejects root aliases and undeclared bare package imports", async () => {
        const projectRoot = await temporaryProject();
        try {
            await writeFile(
                path.join(projectRoot, "package.json"),
                JSON.stringify({
                    dependencies: { "internal-alias": "file:./src/server" },
                    imports: { "#server": "./src/server/index.ts" },
                })
            );
            await writeFile(
                path.join(projectRoot, "tsconfig.json"),
                JSON.stringify({ compilerOptions: { paths: { "~/*": ["src/*"] } } })
            );
            await mkdir(path.join(projectRoot, "config"));
            await writeFile(
                path.join(projectRoot, "config", "base.json"),
                JSON.stringify({ compilerOptions: { paths: { "hidden/*": ["src/*"] } } })
            );
            await writeFile(
                path.join(projectRoot, "tsconfig.server.json"),
                JSON.stringify({ extends: "./config/base.json" })
            );
            await writeFile(
                path.join(projectRoot, "src", "browser", "undeclared.ts"),
                'import value from "unreviewed-alias"; void value;'
            );

            const violations = await checkSourceBoundaries(projectRoot);

            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "package.json" &&
                        violation.message.includes("package-import aliases")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "package.json" &&
                        violation.message.includes("dependency aliases")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "tsconfig.json" &&
                        violation.message.includes("baseUrl and paths aliases")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "tsconfig.server.json" &&
                        violation.message.includes("exact reviewed ./tsconfig.json")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/browser/undeclared.ts" &&
                        violation.message.includes("declared by the root manifest")
                )
            ).toBe(true);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("requires every reviewed TypeScript boundary configuration", async () => {
        const projectRoot = await temporaryProject();
        try {
            const violations = await checkSourceBoundaries(projectRoot);

            for (const importer of [
                "tsconfig.json",
                "tsconfig.browser.json",
                "tsconfig.contracts.json",
                "tsconfig.qualification.json",
                "tsconfig.scripts.json",
                "tsconfig.server.json",
                "tsconfig.worker.json",
            ] as const) {
                expect(
                    violations.some(
                        (violation) =>
                            violation.importer === importer &&
                            violation.message.includes("configuration is missing")
                    )
                ).toBe(true);
            }
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("rejects authority and membership drift in strict TypeScript partitions", async () => {
        const projectRoot = await temporaryProject();
        try {
            await writeFile(path.join(projectRoot, "tsconfig.json"), "{}");
            await mkdir(path.join(projectRoot, "src", "shared"));
            await writeFile(
                path.join(projectRoot, "src", "shared", "ambient.ts"),
                "setImmediate(() => undefined);"
            );
            const reviewedConfiguration = {
                compilerOptions: { lib: ["ESNext"], types: [] },
                exclude: [
                    "src/**/*.spec.ts",
                    "src/**/*.test.ts",
                    "src/**/__tests__/**/*.ts",
                    "src/**/testSupport/**/*.ts",
                ],
                extends: "./tsconfig.json",
                include: ["src/contracts/**/*.ts", "src/shared/**/*.ts"],
            };
            await writeFile(
                path.join(projectRoot, "tsconfig.contracts.json"),
                JSON.stringify(reviewedConfiguration)
            );
            let violations = await checkSourceBoundaries(projectRoot);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "tsconfig.contracts.json" &&
                        violation.message.includes("exact reviewed configuration")
                )
            ).toBe(false);
            expect(
                violations.some(
                    (violation) => violation.importer === "src/shared/ambient.ts"
                )
            ).toBe(false);

            const partitionDrift = [
                {
                    ...reviewedConfiguration,
                    compilerOptions: { lib: ["ESNext"], types: ["node"] },
                },
                {
                    ...reviewedConfiguration,
                    compilerOptions: { lib: ["ESNext", "DOM"], types: [] },
                },
                {
                    ...reviewedConfiguration,
                    compilerOptions: {
                        lib: ["ESNext"],
                        typeRoots: ["./types"],
                        types: [],
                    },
                },
                {
                    ...reviewedConfiguration,
                    compilerOptions: {
                        lib: ["ESNext"],
                        libReplacement: true,
                        types: [],
                    },
                },
                {
                    ...reviewedConfiguration,
                    typeAcquisition: { enable: true },
                },
                {
                    ...reviewedConfiguration,
                    include: ["src/contracts/**/*.ts"],
                },
                {
                    ...reviewedConfiguration,
                    compilerOptions: {
                        lib: ["ESNext"],
                        rootDirs: ["src/shared", "src/server"],
                        types: [],
                    },
                },
                {
                    ...reviewedConfiguration,
                    compilerOptions: {
                        jsxImportSource: "unreviewed-runtime",
                        lib: ["ESNext"],
                        types: [],
                    },
                },
                {
                    ...reviewedConfiguration,
                    compilerOptions: {
                        lib: ["ESNext"],
                        strict: false,
                        types: [],
                    },
                },
                {
                    compilerOptions: reviewedConfiguration.compilerOptions,
                    exclude: reviewedConfiguration.exclude,
                    include: reviewedConfiguration.include,
                },
            ] as const;

            for (const configuration of partitionDrift) {
                await writeFile(
                    path.join(projectRoot, "tsconfig.contracts.json"),
                    JSON.stringify(configuration)
                );
                violations = await checkSourceBoundaries(projectRoot);
                expect(
                    violations.some(
                        (violation) =>
                            violation.importer === "tsconfig.contracts.json" &&
                            violation.message.includes("exact reviewed configuration")
                    )
                ).toBe(true);
            }
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("rejects inherited root authority drift", async () => {
        const projectRoot = await temporaryProject();
        try {
            const reviewedRootSource = await Bun.file(
                path.join(import.meta.dir, "..", "..", "tsconfig.json")
            ).text();
            await writeFile(path.join(projectRoot, "tsconfig.json"), reviewedRootSource);
            let violations = await checkSourceBoundaries(projectRoot);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "tsconfig.json" &&
                        violation.message.includes("exact reviewed configuration")
                )
            ).toBe(false);

            const driftedRootSource = reviewedRootSource.replace(
                '"moduleResolution": "bundler",',
                '"moduleResolution": "bundler",\n        "rootDirs": ["src/shared", "src/server"],'
            );
            expect(driftedRootSource).not.toBe(reviewedRootSource);
            await writeFile(path.join(projectRoot, "tsconfig.json"), driftedRootSource);
            violations = await checkSourceBoundaries(projectRoot);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "tsconfig.json" &&
                        violation.message.includes("exact reviewed configuration")
                )
            ).toBe(true);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("rejects root package browser mappings, exports, and workspace linkage", async () => {
        const projectRoot = await temporaryProject();
        try {
            await writeFile(
                path.join(projectRoot, "package.json"),
                JSON.stringify({
                    browser: {
                        "./src/browser/reviewed.ts": "./src/server/private.ts",
                    },
                    exports: { ".": "./src/server/private.ts" },
                    workspaces: ["packages/*"],
                })
            );

            const violations = await checkSourceBoundaries(projectRoot);

            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "package.json" &&
                        violation.message.includes("Root package browser mappings")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "package.json" &&
                        violation.message.includes("Root package exports")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "package.json" &&
                        violation.message.includes("Root package workspaces")
                )
            ).toBe(true);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });
});
