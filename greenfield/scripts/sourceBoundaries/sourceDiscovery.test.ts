import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkSourceBoundaries } from "../checkSourceBoundaries.ts";
import { temporaryProject } from "./testSupport.ts";

describe("source-boundary repository discovery", () => {
    test("reports missing reviewed source roots as layout violations", async () => {
        const projectRoot = await temporaryProject();
        try {
            await rm(path.join(projectRoot, ".storybook"), { recursive: true });
            await rm(path.join(projectRoot, "scripts"), { recursive: true });
            await rm(path.join(projectRoot, "src"), { recursive: true });

            const violations = await checkSourceBoundaries(projectRoot);

            for (const importer of [".storybook", "scripts", "src"] as const) {
                expect(
                    violations.some(
                        (violation) =>
                            violation.importer === importer &&
                            violation.message.includes("source directory is missing")
                    )
                ).toBe(true);
            }
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("requires every adopted Storybook source file", async () => {
        const projectRoot = await temporaryProject();
        try {
            const requiredFiles = [
                "main.ts",
                "manager.ts",
                "preview.tsx",
                "vitest.config.ts",
            ] as const;
            for (const file of requiredFiles) {
                await rm(path.join(projectRoot, ".storybook", file));
            }

            const violations = await checkSourceBoundaries(projectRoot);

            for (const file of requiredFiles) {
                expect(
                    violations.some(
                        (violation) =>
                            violation.importer === `.storybook/${file}` &&
                            violation.message.includes(
                                "Required Storybook source file is missing"
                            )
                    )
                ).toBe(true);
            }
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("scans only explicitly classified Storybook source roles", async () => {
        const projectRoot = await temporaryProject();
        try {
            await writeFile(
                path.join(projectRoot, ".storybook", "main.ts"),
                'import "../src/browser/client.ts";'
            );
            await writeFile(
                path.join(projectRoot, ".storybook", "manager.ts"),
                'import "node:fs";'
            );
            await writeFile(
                path.join(projectRoot, ".storybook", "preview.tsx"),
                'import "../src/server/private.ts";'
            );
            await writeFile(
                path.join(projectRoot, ".storybook", "future.ts"),
                "export const future = true;"
            );

            const violations = await checkSourceBoundaries(projectRoot);

            expect(
                violations.some(
                    (violation) =>
                        violation.importer === ".storybook/main.ts" &&
                        violation.message.includes(
                            "storybook-config may not import browser"
                        )
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === ".storybook/manager.ts" &&
                        violation.message.includes("Browser and story source")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === ".storybook/preview.tsx" &&
                        violation.message.includes("story may not import server")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === ".storybook/future.ts" &&
                        violation.message.includes("explicit process role")
                )
            ).toBe(true);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("discovers and fails closed outside strict TS and TSX graphs", async () => {
        const projectRoot = await temporaryProject();
        try {
            const extensions = [
                "cjs",
                "cts",
                "js",
                "jsx",
                "mjs",
                "mts",
                "ts",
                "tsx",
            ] as const;
            for (const extension of extensions) {
                await writeFile(
                    path.join(projectRoot, "src", "browser", `forbidden.${extension}`),
                    'const server = require("../server/private.ts"); void server;'
                );
            }

            const violations = await checkSourceBoundaries(projectRoot);

            for (const extension of extensions) {
                expect(
                    violations.some(
                        (violation) =>
                            violation.importer === `src/browser/forbidden.${extension}` &&
                            (extension === "ts" || extension === "tsx"
                                ? violation.message.includes(
                                      "browser may not import server"
                                  )
                                : violation.message.includes("must use .ts or .tsx"))
                    )
                ).toBe(true);
            }
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("discovers the exact executable Tailwind root configuration", async () => {
        const projectRoot = await temporaryProject();
        try {
            await writeFile(
                path.join(projectRoot, "tailwind.config.ts"),
                'import "./src/browser/client.ts"; export default {};'
            );

            const violations = await checkSourceBoundaries(projectRoot);

            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "tailwind.config.ts" &&
                        violation.message.includes("scripts may not import browser")
                )
            ).toBe(true);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("fails closed on unreviewed repository-root executable sources", async () => {
        const projectRoot = await temporaryProject();
        try {
            const unreviewedSources = [
                "unknown.cjs",
                "unknown.cts",
                "vite.config.js",
                "unknown.jsx",
                "unknown.mjs",
                "unknown.mts",
                "evil.spec.ts",
                "evil.test.ts",
                "foo.ts",
                "unknown.tsx",
            ] as const;
            for (const source of unreviewedSources) {
                await writeFile(path.join(projectRoot, source), "export default {};");
            }
            await writeFile(
                path.join(projectRoot, "drizzle.config.ts"),
                "export default {};"
            );
            await writeFile(
                path.join(projectRoot, "tailwind.config.ts"),
                "export default {};"
            );

            const violations = await checkSourceBoundaries(projectRoot);

            for (const importer of unreviewedSources) {
                expect(
                    violations.some(
                        (violation) =>
                            violation.importer === importer &&
                            violation.message.includes("explicit reviewed process role")
                    )
                ).toBe(true);
            }
            for (const importer of ["drizzle.config.ts", "tailwind.config.ts"] as const) {
                expect(
                    violations.some((violation) => violation.importer === importer)
                ).toBe(false);
            }
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("rejects an unknown empty repository-root directory", async () => {
        const projectRoot = await temporaryProject();
        try {
            await mkdir(path.join(projectRoot, "tools"));

            const violations = await checkSourceBoundaries(projectRoot);

            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "tools" &&
                        violation.message.includes("exact reviewed project layout")
                )
            ).toBe(true);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("rejects executable source hidden in an unknown root directory", async () => {
        const projectRoot = await temporaryProject();
        try {
            await mkdir(path.join(projectRoot, "tools"));
            await writeFile(
                path.join(projectRoot, "tools", "evil.ts"),
                "export const escaped = true;"
            );

            const violations = await checkSourceBoundaries(projectRoot);

            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "tools" &&
                        violation.message.includes("exact reviewed project layout")
                )
            ).toBe(true);
            expect(
                violations.some((violation) => violation.importer === "tools/evil.ts")
            ).toBe(false);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("rejects non-browser TSX that is outside the strict partitions", async () => {
        const projectRoot = await temporaryProject();
        try {
            await mkdir(path.join(projectRoot, "src", "shared"));
            await writeFile(
                path.join(projectRoot, "src", "shared", "outsideGraph.tsx"),
                "export const outsideGraph = <div />;"
            );
            await writeFile(
                path.join(projectRoot, "scripts", "outsideGraph.tsx"),
                "export const outsideGraph = <div />;"
            );

            const violations = await checkSourceBoundaries(projectRoot);

            for (const importer of [
                "scripts/outsideGraph.tsx",
                "src/shared/outsideGraph.tsx",
            ]) {
                expect(
                    violations.some(
                        (violation) =>
                            violation.importer === importer &&
                            violation.message.includes(
                                "Only browser and story source may use .tsx"
                            )
                    )
                ).toBe(true);
            }
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("allows only app composition tests assigned to the strict graph", async () => {
        const projectRoot = await temporaryProject();
        try {
            await mkdir(path.join(projectRoot, "src", "app", "__tests__"), {
                recursive: true,
            });
            const allowlistedFiles = [
                "dashboardServer.test.ts",
                "trpcHttpHandler.test.ts",
                "trpcRequestPolicy.test.ts",
            ] as const;
            const unassignedFiles = [
                "future.test.ts",
                "future.spec.ts",
                "__tests__/future.ts",
            ] as const;
            for (const file of [...allowlistedFiles, ...unassignedFiles]) {
                await writeFile(path.join(projectRoot, "src", "app", file), "export {};");
            }

            const violations = await checkSourceBoundaries(projectRoot);

            for (const file of allowlistedFiles) {
                expect(
                    violations.some(
                        (violation) => violation.importer === `src/app/${file}`
                    )
                ).toBe(false);
            }
            for (const file of unassignedFiles) {
                expect(
                    violations.some(
                        (violation) =>
                            violation.importer === `src/app/${file}` &&
                            violation.message.includes("explicitly classified")
                    )
                ).toBe(true);
            }
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("rejects symbolic-link files and directories without following them", async () => {
        const projectRoot = await temporaryProject();
        const externalRoot = await mkdtemp(path.join(tmpdir(), "mira-source-external-"));
        try {
            const externalFile = path.join(externalRoot, "external.ts");
            const externalDirectory = path.join(externalRoot, "directory");
            await writeFile(externalFile, "export const external = true;");
            await mkdir(externalDirectory);
            await writeFile(
                path.join(externalDirectory, "external.ts"),
                "export const external = true;"
            );
            await symlink(
                externalFile,
                path.join(projectRoot, "src", "browser", "linked.ts")
            );
            await symlink(
                externalDirectory,
                path.join(projectRoot, "src", "browser", "linkedDirectory")
            );
            await symlink(
                externalFile,
                path.join(projectRoot, ".storybook", "linked.ts")
            );
            await symlink(
                externalDirectory,
                path.join(projectRoot, ".storybook", "linkedDirectory")
            );

            const violations = await checkSourceBoundaries(projectRoot);

            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/browser/linked.ts" &&
                        violation.message ===
                            "Production source paths may not be symbolic links"
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === ".storybook/linked.ts" &&
                        violation.message ===
                            "Production source paths may not be symbolic links"
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === ".storybook/linkedDirectory" &&
                        violation.message ===
                            "Production source paths may not be symbolic links"
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/browser/linkedDirectory" &&
                        violation.message ===
                            "Production source paths may not be symbolic links"
                )
            ).toBe(true);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
            await rm(externalRoot, { force: true, recursive: true });
        }
    });

    test("rejects nested package and project resolver metadata", async () => {
        const projectRoot = await temporaryProject();
        try {
            await mkdir(path.join(projectRoot, "src", "browser", "alias"));
            await mkdir(path.join(projectRoot, "src", "server"));
            await writeFile(
                path.join(projectRoot, "src", "browser", "entry.ts"),
                'import "./alias";'
            );
            await writeFile(
                path.join(projectRoot, "src", "browser", "alias", "package.json"),
                JSON.stringify({
                    main: "../../server/private.ts",
                    module: "../../server/private.ts",
                })
            );
            await writeFile(
                path.join(projectRoot, "src", "browser", "tsconfig.paths.json"),
                JSON.stringify({
                    compilerOptions: { paths: { "safe/*": ["../server/*"] } },
                })
            );
            await writeFile(
                path.join(projectRoot, "src", "browser", "bunfig.toml"),
                "[install]\nproduction = true\n"
            );
            await writeFile(
                path.join(projectRoot, "src", "server", "private.ts"),
                "export const privateValue = true;"
            );

            const violations = await checkSourceBoundaries(projectRoot);
            for (const importer of [
                "src/browser/alias/package.json",
                "src/browser/bunfig.toml",
                "src/browser/tsconfig.paths.json",
            ]) {
                expect(
                    violations.some(
                        (violation) =>
                            violation.importer === importer &&
                            violation.message.includes("Nested source resolver metadata")
                    )
                ).toBe(true);
            }
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });
});
