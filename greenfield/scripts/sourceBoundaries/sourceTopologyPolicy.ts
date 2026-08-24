import path from "node:path";

/** Explicit process or architectural role assigned to a scanned source path. */
export type SourceRole =
    | "browser"
    | "contracts"
    | "environment-source"
    | "maintenance-app"
    | "scripts"
    | "server"
    | "shared"
    | "story"
    | "storybook-config"
    | "test"
    | "unclassified-app"
    | "unknown"
    | "web-app"
    | "worker"
    | "worker-app";

const webApplicationFiles = new Set([
    "src/app/dashboardChatRuntimeMaintenance.ts",
    "src/app/dashboardLogs.ts",
    "src/app/dashboardServer.ts",
    "src/app/dashboardTerminal.ts",
    "src/app/developmentWeb.ts",
    "src/app/server.ts",
    "src/app/trpcHttpHandler.ts",
    "src/app/trpcRequestPolicy.ts",
]);

const workerApplicationFiles = new Set([
    "src/app/developmentWorker.ts",
    "src/app/worker.ts",
]);

const applicationCompositionTestFiles: ReadonlySet<string> = new Set([
    "src/app/dashboardChatRuntimeMaintenance.test.ts",
    "src/app/dashboardServer.test.ts",
    "src/app/dashboardServerProcess.test.ts",
    "src/app/databaseMaintenance.test.ts",
    "src/app/developmentProcesses.test.ts",
    "src/app/trpcHttpHandler.test.ts",
    "src/app/trpcRequestPolicy.test.ts",
    "src/app/worker.test.ts",
]);

const reviewedApplicationServerTargets: ReadonlyMap<
    string,
    ReadonlySet<string>
> = new Map([
    [
        "src/app/worker.ts",
        new Set([
            "src/server/domains/jobs/workerRuntime.ts",
            "src/server/platform/configuration/workerConfiguration.ts",
            "src/server/platform/filesystem/projectLayout.ts",
            "src/server/platform/gateway/persistentGatewayTransport.ts",
            "src/server/platform/observability/projectFileLogSink.ts",
            "src/server/platform/observability/structuredLogger.ts",
            "src/server/platform/release/runtimeRelease.ts",
            "src/server/platform/runtime/processSignals.ts",
        ]),
    ],
    [
        "src/app/developmentWorker.ts",
        new Set([
            "src/server/domains/jobs/workerRuntime.ts",
            "src/server/platform/release/developmentRuntimeRelease.ts",
        ]),
    ],
    [
        "src/app/databaseMaintenance.ts",
        new Set([
            "src/server/database/runtime/databaseCandidateMigrationOwner.ts",
            "src/server/database/runtime/databaseService.ts",
            "src/server/database/runtime/databaseSnapshot.ts",
        ]),
    ],
]);

/** Composition-owned runtime environment source. */
export const environmentSourceFile = "src/app/environmentSource.ts";

/** Exact composition roots permitted to import the runtime environment source. */
export const environmentSourceConsumers: ReadonlySet<string> = new Set([
    "src/app/dashboardServer.ts",
    "src/app/developmentWeb.ts",
    "src/app/developmentWorker.ts",
    "src/app/worker.ts",
]);

const reviewedScriptBrowserTargets: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["scripts/developmentFrontend.ts", new Set(["src/browser/index.html"])],
]);

/**
 * Checks the one reviewed Bun full-stack HTML entry edge.
 * @param importer Normalized development script path.
 * @param target Normalized browser HTML target path.
 * @returns Whether the exact edge is the reviewed frontend composition edge.
 */
export function isReviewedScriptBrowserTarget(importer: string, target: string): boolean {
    return reviewedScriptBrowserTargets.get(importer)?.has(target) === true;
}

/**
 * Whether an application composition edge names one exact reviewed server primitive.
 * @param importer Normalized application composition-root path.
 * @param target Normalized server target path.
 * @returns Whether the exact edge was reviewed.
 */
export function isReviewedApplicationServerTarget(
    importer: string,
    target: string
): boolean {
    return reviewedApplicationServerTargets.get(importer)?.has(target) === true;
}

/** Reviewed dependency-direction matrix for every source role. */
export const allowedTargets: Readonly<Record<SourceRole, ReadonlySet<SourceRole>>> = {
    browser: new Set(["browser", "contracts", "shared"]),
    contracts: new Set(["contracts", "shared"]),
    "environment-source": new Set(["shared"]),
    "maintenance-app": new Set(["maintenance-app", "shared"]),
    scripts: new Set(["contracts", "scripts", "shared"]),
    server: new Set(["contracts", "server", "shared"]),
    shared: new Set(["shared"]),
    story: new Set(["browser", "contracts", "shared", "story"]),
    "storybook-config": new Set(["storybook-config"]),
    test: new Set([
        "browser",
        "contracts",
        "environment-source",
        "maintenance-app",
        "scripts",
        "server",
        "shared",
        "story",
        "test",
        "web-app",
        "worker",
        "worker-app",
    ]),
    "unclassified-app": new Set(),
    unknown: new Set(),
    "web-app": new Set(["contracts", "server", "shared", "web-app"]),
    worker: new Set(["contracts", "shared", "worker"]),
    "worker-app": new Set(["contracts", "shared", "worker", "worker-app"]),
};

/**
 * Normalizes a project-relative source path for policy evaluation.
 * @param filePath Candidate project-relative path.
 * @returns Canonical forward-slash path without a leading dot segment.
 */
export function normalizeRepositoryPath(filePath: string): string {
    return filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

/**
 * Resolves a relative import lexically within project path semantics.
 * @param importer Normalized project-relative importer.
 * @param specifier Relative module specifier.
 * @returns Normalized project-relative lexical target.
 */
export function relativeImportTarget(importer: string, specifier: string): string {
    const importerDirectory = path.posix.dirname(importer);
    const targetPath = path.posix.join(importerDirectory, specifier);
    return normalizeRepositoryPath(path.posix.normalize(targetPath));
}

/**
 * Identifies paths reserved for tests or test support.
 * @param filePath Normalized project-relative source path.
 * @returns Whether the path belongs to test code or support.
 */
export function isTestPath(filePath: string): boolean {
    return (
        /(?:^|\/)(?:__tests__|test(?:Support)?)\//u.test(filePath) ||
        /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(filePath)
    );
}

/**
 * Classifies one normalized project path into its explicit source role.
 * @param filePath Normalized project-relative source path.
 * @returns The reviewed source role for the path.
 */
export function sourceRole(filePath: string): SourceRole {
    if (filePath === ".storybook/main.ts" || filePath === ".storybook/vitest.config.ts") {
        return "storybook-config";
    }
    if (filePath === ".storybook/manager.ts" || filePath === ".storybook/preview.tsx") {
        return "story";
    }
    if (
        filePath.startsWith("src/browser/") &&
        (filePath.endsWith(".stories.tsx") || filePath.includes("/storySupport/"))
    ) {
        return "story";
    }
    if (applicationCompositionTestFiles.has(filePath)) return "test";
    if (filePath.startsWith("src/app/") && isTestPath(filePath)) {
        return "unclassified-app";
    }
    if (isTestPath(filePath)) return "test";
    if (filePath === environmentSourceFile) return "environment-source";
    if (filePath === "src/app/databaseMaintenance.ts") return "maintenance-app";
    if (webApplicationFiles.has(filePath)) return "web-app";
    if (workerApplicationFiles.has(filePath)) return "worker-app";
    if (filePath.startsWith("src/app/")) return "unclassified-app";
    if (filePath.startsWith("src/browser/")) return "browser";
    if (filePath.startsWith("src/contracts/")) return "contracts";
    if (filePath.startsWith("src/server/")) return "server";
    if (filePath.startsWith("src/shared/")) return "shared";
    if (filePath.startsWith("src/worker/")) return "worker";
    if (
        filePath.startsWith("scripts/") ||
        filePath === "tailwind.config.ts" ||
        /^drizzle\.config\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u.test(filePath)
    ) {
        return "scripts";
    }
    return "unknown";
}
