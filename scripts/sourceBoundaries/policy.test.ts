import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { checkSourceBoundaries } from "../checkSourceBoundaries.ts";
import {
    legacyScriptImportAllowlist,
    validateDeclaredPackageImport,
    validateSourceAmbientRuntimeDeclaration,
    validateSourceEnvironmentAccess,
    validateSourceFile,
    validateSourceImport,
    validateSourceReferenceDirective,
    validateSourceRuntimeAuthorityEscape,
    validateSourceTypeScriptSuppressionDirective,
} from "./policy.ts";

const staticImport = (specifier: string) => ({
    kind: "import" as const,
    line: 1,
    specifier,
});

describe("source-boundary policy", () => {
    test("allows the intended production dependency directions", () => {
        expect(
            validateSourceImport(
                "src/contracts/auth.ts",
                staticImport("../shared/validation.ts")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/browser/auth.ts",
                staticImport("../contracts/auth.ts")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/app/server.ts",
                staticImport("../server/trpc/appRouter.ts")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/worker/jobs/run.ts",
                staticImport("../../shared/dateTime.ts")
            )
        ).toBeUndefined();
        expect(validateSourceFile("tailwind.config.ts")).toBeUndefined();
        expect(validateSourceFile("drizzle.config.ts")).toBeUndefined();
        expect(
            validateSourceImport(
                "tailwind.config.ts",
                staticImport("./src/browser/client.ts")
            )?.message
        ).toContain("scripts may not import browser");
    });

    test("rejects cross-process, reverse-composition, and test imports", () => {
        expect(
            validateSourceImport(
                "src/browser/auth.ts",
                staticImport("../server/trpc/appRouter.ts")
            )?.message
        ).toContain("browser may not import server");
        expect(
            validateSourceImport(
                "src/server/domains/task.ts",
                staticImport("../../app/server.ts")
            )?.message
        ).toContain("server may not import web-app");
        expect(
            validateSourceImport(
                "src/app/server.ts",
                staticImport("../worker/adapters/systemd.ts")
            )?.message
        ).toContain("web-app may not import worker");
        expect(
            validateSourceImport("src/contracts/auth.ts", staticImport("./auth.test.ts"))
                ?.message
        ).toContain("may not import tests");
        expect(
            validateSourceImport("src/contracts/auth.ts", staticImport("./auth.spec.ts"))
                ?.message
        ).toContain("may not import tests");
        expect(
            validateSourceImport(
                "src/contracts/auth.ts",
                staticImport("./__tests__/auth.ts")
            )?.message
        ).toContain("may not import tests");
    });

    test("fails closed for unclassified application roots and dynamic imports", () => {
        expect(validateSourceFile("src/app/newRoot.ts")?.message).toContain(
            "explicitly classified"
        );
        for (const file of [
            "src/app/future.test.ts",
            "src/app/future.spec.ts",
            "src/app/__tests__/future.ts",
        ]) {
            expect(validateSourceFile(file)?.message).toContain("explicitly classified");
        }
        for (const file of [
            "src/app/dashboardServer.test.ts",
            "src/app/trpcHttpHandler.test.ts",
            "src/app/trpcRequestPolicy.test.ts",
        ]) {
            expect(validateSourceFile(file)).toBeUndefined();
        }
        expect(validateSourceFile("src/newRoot.ts")?.message).toContain(
            "explicit process role"
        );
        for (const file of [
            "evil.spec.ts",
            "evil.test.ts",
            "foo.ts",
            "vite.config.js",
        ] as const) {
            expect(validateSourceFile(file)?.message).toContain(
                "explicit reviewed process role"
            );
        }
        expect(
            validateSourceImport("src/browser/load.ts", {
                kind: "dynamic-import",
                line: 4,
            })?.message
        ).toContain("literal specifier");
        expect(validateSourceFile("src/contracts/escape.d.ts")?.message).toContain(
            "declaration files are forbidden"
        );
    });

    test("permits TSX only in the strict browser graph", () => {
        expect(validateSourceFile("src/browser/view.tsx")).toBeUndefined();
        expect(validateSourceFile("src/app/browser.tsx")).toBeUndefined();
        for (const file of [
            "drizzle.config.tsx",
            "scripts/generate.tsx",
            "src/app/dashboardServer.tsx",
            "src/contracts/auth.tsx",
            "src/server/domains/task.tsx",
            "src/shared/dateTime.tsx",
            "src/worker/jobs/run.tsx",
        ]) {
            expect(validateSourceFile(file)?.message).toContain(
                "Only browser source may use .tsx"
            );
        }
    });

    test("allows only reviewed neutral packages in contracts and shared", () => {
        expect(
            validateSourceImport("src/contracts/auth.ts", staticImport("valibot"))
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/server/domains/task.ts",
                staticImport("node:process")
            )?.message
        ).toContain("may not import the process module");
        expect(
            validateSourceImport("src/shared/dateTime.ts", staticImport("date-fns"))
        ).toBeUndefined();
        expect(
            validateSourceImport("src/contracts/auth.ts", staticImport("node:fs"))
                ?.message
        ).toContain("environment-neutral packages");
        expect(
            validateSourceReferenceDirective("src/shared/network.ts", 1).message
        ).toContain("Triple-slash reference directives are forbidden");
        expect(
            validateSourceAmbientRuntimeDeclaration("src/shared/network.ts", 2)?.message
        ).toContain("may not declare ambient runtime values");
        expect(
            validateSourceAmbientRuntimeDeclaration("src/server/runtime.ts", 2)?.message
        ).toContain("may not declare ambient runtime values");
        expect(
            validateSourceAmbientRuntimeDeclaration("scripts/runtime.ts", 2)?.message
        ).toContain("may not declare ambient runtime values");
        expect(
            validateSourceAmbientRuntimeDeclaration("src/server/runtime.test.ts", 2)
        ).toBeUndefined();
    });

    test("rejects module-loader and dynamic-code authority primitives", () => {
        for (const specifier of [
            "bun:jsc",
            "module",
            "node:module",
            "node:module/register",
            "node:vm",
            "vm",
        ]) {
            expect(
                validateSourceImport(
                    "src/server/runtimeLoader.ts",
                    staticImport(specifier)
                )?.message
            ).toContain("dynamic module-loader or code-evaluation APIs");
        }
        expect(
            validateSourceImport("src/server/runtimeLoader.ts", {
                kind: "module-loader",
                line: 4,
            })?.message
        ).toContain("module-loader primitive");
        expect(
            validateSourceImport("src/server/runtimeLoader.ts", {
                kind: "dynamic-code",
                line: 5,
            })?.message
        ).toContain("dynamic-code primitives");
        expect(
            validateSourceImport("src/server/runtimeLoader.ts", {
                kind: "shell-execution",
                line: 6,
            })?.message
        ).toContain("Bun.$ shell-execution authority");
        for (const importer of [
            "src/app/server.ts",
            "src/browser/runtimeLoader.ts",
            "src/server/runtimeLoader.ts",
        ] as const) {
            expect(
                validateSourceImport(importer, {
                    kind: "process-execution",
                    line: 7,
                })?.message
            ).toContain("scripts and worker");
        }
        for (const importer of [
            "scripts/runtimeLoader.ts",
            "src/app/worker.ts",
            "src/worker/runtimeLoader.ts",
        ] as const) {
            expect(
                validateSourceImport(importer, {
                    kind: "process-execution",
                    line: 8,
                })
            ).toBeUndefined();
        }
        expect(
            validateSourceImport("src/server/runtimeLoader.ts", {
                kind: "module-loader",
                line: 9,
                specifier: "node:fs",
            })
        ).toBeUndefined();
    });

    test("canonicalizes restricted Node and Bun runtime imports", () => {
        for (const specifier of ["bun:test", "node:test", "test"] as const) {
            expect(
                validateSourceImport(
                    "src/server/runtimeImport.ts",
                    staticImport(specifier)
                )?.message
            ).toContain("test-runner APIs");
        }
        for (const specifier of ["process", "node:process"] as const) {
            expect(
                validateSourceImport(
                    "src/server/runtimeImport.ts",
                    staticImport(specifier)
                )?.message
            ).toContain("process module");
        }
        for (const specifier of [
            "cluster",
            "inspector",
            "node:cluster",
            "node:inspector",
            "node:repl",
            "node:worker_threads",
            "repl",
            "worker_threads",
        ] as const) {
            expect(
                validateSourceImport(
                    "src/server/runtimeImport.ts",
                    staticImport(specifier)
                )?.message
            ).toContain("unreviewed process");
        }
        for (const specifier of ["child_process", "node:child_process"] as const) {
            expect(
                validateSourceImport(
                    "src/server/runtimeImport.ts",
                    staticImport(specifier)
                )?.message
            ).toContain("scripts and worker");
            expect(
                validateSourceImport("scripts/runtimeImport.ts", staticImport(specifier))
            ).toBeUndefined();
            expect(
                validateSourceImport(
                    "src/worker/runtimeImport.ts",
                    staticImport(specifier)
                )
            ).toBeUndefined();
        }
        expect(
            validateSourceImport("src/server/runtimeImport.ts", staticImport("bun:ffi"))
                ?.message
        ).toContain("Bun FFI APIs");
        for (const specifier of ["node:wasi", "wasi"] as const) {
            expect(
                validateSourceImport(
                    "src/server/runtimeImport.ts",
                    staticImport(specifier)
                )?.message
            ).toContain("WebAssembly System Interface APIs");
        }
    });

    test("allows only exact reviewed bare Bun import bindings", () => {
        expect(
            validateSourceImport("scripts/developmentFrontend.ts", {
                kind: "import",
                importedBindings: [{ imported: "Server", typeOnly: true }],
                line: 1,
                specifier: "bun",
            })
        ).toBeUndefined();
        expect(
            validateSourceImport("src/server/rawHttp/authenticationCredentials.ts", {
                kind: "import",
                importedBindings: [{ imported: "CookieMap", typeOnly: false }],
                line: 1,
                specifier: "bun",
            })
        ).toBeUndefined();
        for (const sourceImport of [
            staticImport("bun"),
            {
                kind: "import" as const,
                importedBindings: [{ imported: "spawn", typeOnly: false }],
                line: 1,
                specifier: "bun",
            },
            {
                kind: "import" as const,
                importedBindings: [
                    { imported: "CookieMap", typeOnly: false },
                    { imported: "plugin", typeOnly: false },
                ],
                line: 1,
                specifier: "bun",
            },
        ]) {
            expect(
                validateSourceImport(
                    "src/server/rawHttp/authenticationCredentials.ts",
                    sourceImport
                )?.message
            ).toContain("exact reviewed importer and named binding allowlist");
        }
    });

    test("rejects escaped runtime authority even where direct script env reads coexist", () => {
        expect(
            validateSourceRuntimeAuthorityEscape("src/server/runtime.ts", 3)?.message
        ).toContain("may not alias, pass, return, or dynamically index");
        expect(
            validateSourceRuntimeAuthorityEscape("scripts/build.ts", 3)?.message
        ).toContain("may not alias, pass, return, or dynamically index");
        expect(
            validateSourceRuntimeAuthorityEscape("src/server/runtime.test.ts", 3)
        ).toBeUndefined();
        expect(validateSourceEnvironmentAccess("scripts/build.ts", 4)).toBeUndefined();
        expect(
            validateSourceTypeScriptSuppressionDirective("src/browser/escape.ts", 5)
                ?.message
        ).toContain("may not suppress TypeScript diagnostics");
        expect(
            validateSourceTypeScriptSuppressionDirective("src/browser/escape.test.ts", 5)
        ).toBeUndefined();
    });

    test("rejects repository aliases, self-package edges, and unreviewed schemes", () => {
        expect(
            validateSourceImport("src/browser/auth.ts", staticImport("#server/auth"))
                ?.message
        ).toContain("query or fragment suffixes");
        for (const specifier of ["@/server/auth", "mira-dashboard/src/server/auth"]) {
            expect(
                validateSourceImport("src/browser/auth.ts", staticImport(specifier))
                    ?.message
            ).toContain("aliases are forbidden");
        }
        for (const specifier of [
            "data:text/javascript,export default 1",
            "file:///srv/private.ts",
            "https://example.com/module.ts",
            "npm:valibot",
        ]) {
            expect(
                validateSourceImport(
                    "src/server/domains/task.ts",
                    staticImport(specifier)
                )?.message
            ).toContain("unreviewed URL specifiers");
        }
        expect(
            validateSourceImport("src/server/domains/task.ts", staticImport("node:path"))
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/server/domains/task.ts",
                staticImport(String.raw`..\shared\task.ts`)
            )?.message
        ).toContain("canonical forward slashes");
        expect(
            validateDeclaredPackageImport(
                "src/browser/auth.ts",
                staticImport("undeclared-browser-alias/module"),
                new Set(["react"])
            )?.message
        ).toContain("declared by the root manifest");
        expect(
            validateDeclaredPackageImport(
                "src/browser/auth.ts",
                staticImport("react/jsx-runtime"),
                new Set(["react"])
            )
        ).toBeUndefined();
    });

    test("rejects percent-encoded resolver input before path classification", () => {
        for (const specifier of [
            "./%2e%2e/server/private.ts",
            "./%2E./server/private.ts",
            "./.%2e/server/private.ts",
            "./%2e%2E/server/private.ts",
            "./safe%2f..%2fserver/private.ts",
            "./safe%5C..%5Cserver/private.ts",
            "./%00server/private.ts",
        ]) {
            expect(
                validateSourceImport("src/browser/escape.ts", staticImport(specifier))
                    ?.message
            ).toContain("percent-encoded resolver input");
        }
    });

    test("rejects resolver queries and fragments before path classification", () => {
        for (const sourceImport of [
            staticImport("./fixture.test.ts?x"),
            {
                kind: "require" as const,
                line: 2,
                specifier: "../shared/encoding.ts?raw",
            },
            {
                kind: "dynamic-import" as const,
                line: 3,
                specifier: "../shared/encoding.ts#source",
            },
            {
                kind: "export" as const,
                line: 4,
                specifier: "../shared/encoding.ts?module#source",
            },
        ]) {
            expect(
                validateSourceImport("src/server/queryEscape.ts", sourceImport)?.message
            ).toContain("query or fragment suffixes");
        }
    });

    test("rejects unscanned native and WebAssembly module artifacts", () => {
        for (const sourceImport of [
            staticImport("./addon.node"),
            {
                kind: "require" as const,
                line: 2,
                specifier: "./addon.NoDe",
            },
            {
                kind: "dynamic-import" as const,
                line: 3,
                specifier: "./module.wasm",
            },
            {
                kind: "export" as const,
                line: 4,
                specifier: "./MODULE.WASM",
            },
        ]) {
            expect(
                validateSourceImport("src/server/nativeArtifact.ts", sourceImport)
                    ?.message
            ).toContain("native or WebAssembly executable module artifacts");
        }
        expect(
            validateSourceImport("src/browser/styles.ts", staticImport("./styles.css"))
        ).toBeUndefined();
        expect(
            validateSourceImport("src/server/fixture.ts", staticImport("./fixture.json"))
        ).toBeUndefined();
    });

    test("rejects extensionless relative runtime resolution", () => {
        for (const sourceImport of [
            staticImport("./module"),
            {
                kind: "require" as const,
                line: 2,
                specifier: "../shared/module",
            },
            {
                kind: "dynamic-import" as const,
                line: 3,
                specifier: "./directory/entry",
            },
            {
                kind: "export" as const,
                line: 4,
                specifier: "./package",
            },
        ]) {
            expect(
                validateSourceImport("src/server/extensionless.ts", sourceImport)?.message
            ).toContain("explicit file extension");
        }
        expect(
            validateSourceImport("src/server/explicit.ts", staticImport("./module.ts"))
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/server/nativeFallback.ts",
                staticImport("./addon.safe")
            )?.message
        ).toContain("reviewed explicit");
        expect(
            validateSourceImport("scripts/page.ts", staticImport("./template.html"))
        ).toBeUndefined();
    });

    test("limits the runtime environment source to composition roots", () => {
        expect(
            validateSourceImport(
                "src/app/dashboardServer.ts",
                staticImport("./environmentSource.ts")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/app/worker.ts",
                staticImport("./environmentSource.ts")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/app/server.ts",
                staticImport("./environmentSource.ts")
            )?.message
        ).toContain("Only the web and worker composition roots");
        expect(
            validateSourceEnvironmentAccess("src/worker/jobs/run.ts", 7)?.message
        ).toContain("typed configuration");
        expect(validateSourceEnvironmentAccess("src/app/environmentSource.ts", 7)).toBe(
            undefined
        );
    });

    test("freezes the exact legacy script coexistence allowlist", () => {
        expect(legacyScriptImportAllowlist.size).toBe(18);
        expect(
            validateSourceImport(
                "scripts/buildBackend.ts",
                staticImport("../backend/src/services/releases/runtime.ts")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "scripts/newTool.ts",
                staticImport("../backend/src/services/releases/runtime.ts")
            )?.message
        ).toContain("New script imports");
    });

    test("accepts the complete current repository graph", async () => {
        const projectRootUrl = new URL("../..", import.meta.url);
        const violations = await checkSourceBoundaries(fileURLToPath(projectRootUrl));
        expect(violations).toEqual([]);
    }, 30_000);
});
