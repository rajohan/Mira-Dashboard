import { describe, expect, test } from "bun:test";

import {
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
        expect(
            validateSourceImport(
                "src/app/worker.ts",
                staticImport("../server/domains/jobs/workerRuntime.ts")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/app/worker.ts",
                staticImport("../server/domains/moltbook/provider.ts")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/app/worker.ts",
                staticImport("../server/platform/gateway/persistentGatewayTransport.ts")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/app/worker.ts",
                staticImport("../server/platform/gateway/previewGatewayTransport.ts")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/app/databaseMaintenance.ts",
                staticImport(
                    "../server/database/runtime/databaseCandidateMigrationOwner.ts"
                )
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/app/resetDashboardPassword.ts",
                staticImport("../contracts/auth.ts")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/app/resetDashboardPassword.ts",
                staticImport("../server/database/runtime/databaseService.ts")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/app/resetDashboardPassword.ts",
                staticImport("../server/domains/security/hostPasswordRecovery.ts")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/app/resetDashboardPassword.ts",
                staticImport(
                    "../server/domains/security/hostPasswordRecoveryRepository.ts"
                )
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/app/resetDashboardPassword.ts",
                staticImport("../server/platform/filesystem/projectLayout.ts")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/app/resetDashboardPassword.ts",
                staticImport("../server/platform/release/runtimeRelease.ts")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/app/databaseMaintenance.ts",
                staticImport("../server/database/runtime/databaseService.ts")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/browser/ui/stories/Button.stories.tsx",
                staticImport("../Button.tsx")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                ".storybook/preview.tsx",
                staticImport("../src/browser/index.css")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/browser/ui/Button.test.tsx",
                staticImport("./stories/Button.stories.tsx")
            )
        ).toBeUndefined();
        expect(validateSourceFile("tailwind.config.ts")).toBeUndefined();
        expect(validateSourceFile("drizzle.config.ts")).toBeUndefined();
        expect(validateSourceFile("oxfmt.config.ts")).toBeUndefined();
        expect(validateSourceFile("oxlint.config.ts")).toBeUndefined();
        expect(validateSourceFile(".storybook/main.ts")).toBeUndefined();
        expect(validateSourceFile(".storybook/manager.ts")).toBeUndefined();
        expect(validateSourceFile(".storybook/preview.tsx")).toBeUndefined();
        expect(validateSourceFile(".storybook/vitest.config.ts")).toBeUndefined();
        expect(validateSourceFile("src/app/dashboardLogs.ts")).toBeUndefined();
        expect(validateSourceFile("src/app/dashboardTerminal.ts")).toBeUndefined();
        expect(
            validateSourceImport(
                "scripts/developmentFrontend.ts",
                staticImport("../src/browser/index.html")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "src/server/domains/system/procedures.ts",
                staticImport("../../../../docs/generated/browser-reference.json")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                "scripts/documentation/artifacts.ts",
                staticImport(
                    "../../migrations/20260804022252_dashboard-foundation/snapshot.json"
                )
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(
                ".storybook/vitest.config.ts",
                staticImport("../scripts/storybookTestProjects.ts")
            )
        ).toBeUndefined();
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
            validateSourceImport(
                "src/worker/jobs/run.ts",
                staticImport("../../server/domains/security/authenticationLifecycle.ts")
            )?.message
        ).toContain("worker may not import server");
        expect(
            validateSourceImport(
                "src/app/worker.ts",
                staticImport("../server/database/runtime/databaseRuntimeOwner.ts")
            )?.message
        ).toContain("worker-app may not import server");
        expect(
            validateSourceImport(
                "src/app/resetDashboardPassword.ts",
                staticImport("../server/trpc/appRouter.ts")
            )?.message
        ).toContain("maintenance-app may not import server");
        expect(
            validateSourceImport(
                "src/browser/dashboard.ts",
                staticImport("./ui/stories/Button.stories.tsx")
            )?.message
        ).toContain("browser may not import story");
        expect(
            validateSourceImport(
                "src/browser/dashboard.ts",
                staticImport("../../.storybook/main.ts")
            )?.message
        ).toContain("browser may not import storybook-config");
        expect(
            validateSourceImport(
                "src/browser/dashboard.ts",
                staticImport("../../docs/generated/browser-reference.json")
            )?.message
        ).toContain("browser may not import unknown");
        expect(
            validateSourceImport(
                "src/browser/ui/stories/Button.stories.tsx",
                staticImport("../../../server/private.ts")
            )?.message
        ).toContain("story may not import server");
        expect(
            validateSourceImport(".storybook/main.ts", staticImport("./preview.tsx"))
                ?.message
        ).toContain("storybook-config may not import story");
        expect(
            validateSourceImport(
                ".storybook/main.ts",
                staticImport("../scripts/storybookTestProjects.ts")
            )?.message
        ).toContain("storybook-config may not import scripts");
        expect(
            validateSourceImport(
                ".storybook/vitest.config.ts",
                staticImport("../scripts/testBatching.ts")
            )?.message
        ).toContain("storybook-config may not import scripts");
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
            "src/app/dashboardChatRuntimeMaintenance.test.ts",
            "src/app/dashboardServer.test.ts",
            "src/app/resetDashboardPassword.test.ts",
            "src/app/trpcHttpHandler.test.ts",
            "src/app/trpcRequestPolicy.test.ts",
        ]) {
            expect(validateSourceFile(file)).toBeUndefined();
        }
        expect(validateSourceFile("src/app/resetDashboardPassword.ts")).toBeUndefined();
        expect(validateSourceFile("src/newRoot.ts")?.message).toContain(
            "explicit process role"
        );
        expect(validateSourceFile(".storybook/future.ts")?.message).toContain(
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
        expect(
            validateSourceFile("src/test/types/bunCanaryMatchers.d.ts")
        ).toBeUndefined();
    });

    test("permits TSX only in the strict browser and story graphs", () => {
        expect(validateSourceFile("src/browser/view.tsx")).toBeUndefined();
        expect(
            validateSourceFile("src/browser/ui/stories/Button.stories.tsx")
        ).toBeUndefined();
        expect(validateSourceFile(".storybook/preview.tsx")).toBeUndefined();
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
                "Only browser and story source may use .tsx"
            );
        }
    });

    test("treats story sources as browser authority and keeps config tooling separate", () => {
        expect(
            validateSourceImport(
                "src/browser/ui/stories/Button.stories.tsx",
                staticImport("@storybook/tanstack-react")
            )
        ).toBeUndefined();
        expect(
            validateSourceImport(".storybook/manager.ts", staticImport("node:fs"))
                ?.message
        ).toContain("Browser and story source");
        expect(
            validateSourceImport(
                "src/browser/storySupport/database.ts",
                staticImport("drizzle-orm")
            )?.message
        ).toContain("Browser and story source");
        expect(
            validateSourceImport(".storybook/main.ts", staticImport("node:path"))
        ).toBeUndefined();
        expect(
            validateSourceImport(".storybook/vitest.config.ts", staticImport("node:url"))
        ).toBeUndefined();
        expect(
            validateSourceImport(".storybook/main.ts", {
                kind: "process-execution",
                line: 1,
            })?.message
        ).toContain("scripts and worker");
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
            validateSourceImport("src/contracts/jobModel.ts", staticImport("effect/Cron"))
        ).toBeUndefined();
        expect(
            validateSourceImport("src/contracts/jobModel.ts", staticImport("effect"))
                ?.message
        ).toContain("environment-neutral packages");
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
        ).toContain("exact reviewed worker adapter");
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
            validateSourceImport("scripts/development/developmentRemoteProxy.ts", {
                kind: "import",
                importedBindings: [{ imported: "ServerWebSocket", typeOnly: true }],
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

    test("allows Bun FFI only through the exact reviewed Linux rename adapter", () => {
        const reviewedImport = {
            kind: "import" as const,
            importedBindings: [
                { imported: "dlopen", typeOnly: false },
                { imported: "FFIType", typeOnly: false },
                { imported: "read", typeOnly: false },
            ],
            line: 1,
            specifier: "bun:ffi",
        };
        expect(
            validateSourceImport(
                "src/worker/files/linuxRenameExchange.ts",
                reviewedImport
            )
        ).toBeUndefined();

        for (const [importer, sourceImport] of [
            ["src/worker/files/otherAdapter.ts", reviewedImport],
            [
                "src/worker/files/linuxRenameExchange.ts",
                {
                    ...reviewedImport,
                    importedBindings: [
                        ...reviewedImport.importedBindings,
                        { imported: "JSCallback", typeOnly: false },
                    ],
                },
            ],
            [
                "src/worker/files/linuxRenameExchange.ts",
                { ...reviewedImport, specifier: "bun:ffi/internal" },
            ],
        ] as const) {
            expect(validateSourceImport(importer, sourceImport)?.message).toContain(
                "exact reviewed worker adapter"
            );
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
});
