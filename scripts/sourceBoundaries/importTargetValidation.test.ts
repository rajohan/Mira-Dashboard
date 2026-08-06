import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

describe("source-boundary import target validation", () => {
    test("rejects encoded path input before the runtime resolver normalizes it", async () => {
        const projectRoot = await temporaryProject();
        try {
            await writeFile(
                path.join(projectRoot, "src", "browser", "encoded.ts"),
                `import "./%2e%2e/server/private.ts";
                 import "./%2E./server/private.ts";
                 import "./.%2e/server/private.ts";
                 import "./%2e%2E/server/private.ts";
                 import "./safe%2f..%2fserver/private.ts";
                 import "./safe%5C..%5Cserver/private.ts";
                 import "./%00server/private.ts";`
            );

            const violations = await checkSourceBoundaries(projectRoot);
            expect(
                violations
                    .filter(
                        (violation) =>
                            violation.importer === "src/browser/encoded.ts" &&
                            violation.message.includes("percent-encoded resolver input")
                    )
                    .map(({ line }) => line)
            ).toEqual([1, 2, 3, 4, 5, 6, 7]);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("rejects resolver queries and fragments before target classification", async () => {
        const projectRoot = await temporaryProject();
        try {
            await mkdir(path.join(projectRoot, "src", "server"));
            await writeFile(
                path.join(projectRoot, "src", "server", "queryEscape.ts"),
                `const testModule = require("./fixture.test.ts?x");
                 void import("../shared/encoding.ts?raw");
                 export * from "../shared/encoding.ts#source";
                 void testModule;`
            );

            const violations = await checkSourceBoundaries(projectRoot);
            expect(
                violations
                    .filter(
                        (violation) =>
                            violation.importer === "src/server/queryEscape.ts" &&
                            violation.message.includes("query or fragment suffixes")
                    )
                    .map(({ line }) => line)
            ).toEqual([1, 2, 3]);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("rejects unscanned executable module extensions", async () => {
        const projectRoot = await temporaryProject();
        try {
            await mkdir(path.join(projectRoot, "src", "server"));
            await writeFile(
                path.join(projectRoot, "src", "server", "nativeArtifact.ts"),
                `import "./addon.node";
                 const addon = require("./addon.NoDe");
                 void import("./module.wasm");
                 export * from "./MODULE.WASM";
                 import "./styles.css";
                 void addon;`
            );
            await writeFile(
                path.join(projectRoot, "src", "server", "styles.css"),
                ":root {}"
            );

            const violations = await checkSourceBoundaries(projectRoot);
            expect(
                violations
                    .filter(
                        (violation) =>
                            violation.importer === "src/server/nativeArtifact.ts" &&
                            violation.message.includes(
                                "native or WebAssembly executable module artifacts"
                            )
                    )
                    .map(({ line }) => line)
            ).toEqual([1, 2, 3, 4]);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/server/nativeArtifact.ts" &&
                        violation.line === 5
                )
            ).toBe(false);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("rejects extensionless runtime resolver fallback", async () => {
        const projectRoot = await temporaryProject();
        try {
            await mkdir(path.join(projectRoot, "src", "server"));
            await writeFile(
                path.join(projectRoot, "src", "server", "extensionless.ts"),
                `import "./module";
                 const required = require("./required");
                 void import("./dynamic");
                 export * from "./reexported";
                 import "./addon.safe";
                 import "./explicit.css";
                 void required;`
            );
            await writeFile(
                path.join(projectRoot, "src", "server", "addon.safe.node"),
                "ignored native fixture"
            );
            await writeFile(
                path.join(projectRoot, "src", "server", "explicit.css"),
                ":root {}"
            );

            const violations = await checkSourceBoundaries(projectRoot);
            expect(
                violations
                    .filter(
                        (violation) =>
                            violation.importer === "src/server/extensionless.ts" &&
                            violation.message.includes("explicit file extension")
                    )
                    .map(({ line }) => line)
            ).toEqual([1, 2, 3, 4]);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/server/extensionless.ts" &&
                        violation.line === 5 &&
                        violation.message.includes("reviewed explicit")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/server/extensionless.ts" &&
                        violation.line === 6
                )
            ).toBe(false);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("requires exact regular non-symbolic relative targets", async () => {
        const projectRoot = await temporaryProject();
        try {
            const serverRoot = path.join(projectRoot, "src", "server");
            await mkdir(serverRoot);
            await writeFile(
                path.join(serverRoot, "exactTarget.ts"),
                `import "./missing.ts";
                 import "./directory.json";
                 import "./linked.css";
                 import "./exact.css";`
            );
            await writeFile(
                path.join(serverRoot, "missing.ts.node"),
                "ignored native fixture"
            );
            await mkdir(path.join(serverRoot, "directory.json"));
            await writeFile(
                path.join(serverRoot, "directory.json", "index.node"),
                "ignored native fixture"
            );
            await writeFile(path.join(serverRoot, "exact.css"), ":root {}");
            await symlink(
                path.join(serverRoot, "exact.css"),
                path.join(serverRoot, "linked.css")
            );

            const violations = await checkSourceBoundaries(projectRoot);

            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/server/exactTarget.ts" &&
                        violation.line === 1 &&
                        violation.message.includes("existing exact target")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/server/exactTarget.ts" &&
                        violation.line === 2 &&
                        violation.message.includes("exact regular files")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/server/exactTarget.ts" &&
                        violation.line === 3 &&
                        violation.message.includes("symbolic links")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/server/exactTarget.ts" &&
                        violation.line === 4
                )
            ).toBe(false);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("validates exact legacy allowlist targets without following symlinks", async () => {
        const projectRoot = await temporaryProject();
        const externalRoot = await mkdtemp(path.join(tmpdir(), "mira-legacy-external-"));
        try {
            await writeFile(
                path.join(projectRoot, "scripts", "buildBackend.ts"),
                'import "../backend/src/services/releases/runtime.ts";'
            );
            await mkdir(
                path.join(projectRoot, "backend", "src", "services", "releases"),
                { recursive: true }
            );
            const externalTarget = path.join(externalRoot, "runtime.ts");
            await writeFile(externalTarget, "export const runtime = true;");
            await symlink(
                externalTarget,
                path.join(
                    projectRoot,
                    "backend",
                    "src",
                    "services",
                    "releases",
                    "runtime.ts"
                )
            );

            const violations = await checkSourceBoundaries(projectRoot);

            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "scripts/buildBackend.ts" &&
                        violation.message.includes("may not contain symbolic links")
                )
            ).toBe(true);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
            await rm(externalRoot, { force: true, recursive: true });
        }
    });
});
