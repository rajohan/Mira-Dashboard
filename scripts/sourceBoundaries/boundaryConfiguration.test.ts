import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkSourceBoundaries } from "../checkSourceBoundaries.ts";

async function temporaryProject(): Promise<string> {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "mira-source-boundary-"));
    await mkdir(path.join(projectRoot, "scripts"));
    await mkdir(path.join(projectRoot, "src", "browser"), { recursive: true });
    await writeFile(path.join(projectRoot, "package.json"), "{}");
    return projectRoot;
}

describe("source-boundary root configuration", () => {
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
