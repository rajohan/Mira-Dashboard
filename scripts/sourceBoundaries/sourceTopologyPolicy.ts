import path from "node:path";

/** Explicit process or architectural role assigned to a scanned source path. */
export type SourceRole =
    | "browser"
    | "browser-app"
    | "contracts"
    | "environment-source"
    | "legacy-backend"
    | "legacy-frontend"
    | "scripts"
    | "server"
    | "shared"
    | "test"
    | "unclassified-app"
    | "unknown"
    | "web-app"
    | "worker"
    | "worker-app";

const webApplicationFiles = new Set([
    "src/app/dashboardServer.ts",
    "src/app/server.ts",
    "src/app/trpcHttpHandler.ts",
    "src/app/trpcRequestPolicy.ts",
]);

const applicationCompositionTestFiles: ReadonlySet<string> = new Set([
    "src/app/dashboardServer.test.ts",
    "src/app/trpcHttpHandler.test.ts",
    "src/app/trpcRequestPolicy.test.ts",
]);

/** Composition-owned runtime environment source. */
export const environmentSourceFile = "src/app/environmentSource.ts";

/** Exact composition roots permitted to import the runtime environment source. */
export const environmentSourceConsumers: ReadonlySet<string> = new Set([
    "src/app/dashboardServer.ts",
    "src/app/worker.ts",
]);

/**
 * Creates a stable key for one script edge into a legacy implementation.
 * @param importer Normalized script importer.
 * @param target Normalized legacy target.
 * @returns Stable allowlist key.
 */
export function legacyEdge(importer: string, target: string): string {
    return `${importer}\0${target}`;
}

/** Exact coexistence edges into the legacy implementation. New edges are rejected. */
export const legacyScriptImportAllowlist: ReadonlySet<string> = new Set([
    legacyEdge("scripts/buildBackend.ts", "backend/src/services/releases/runtime.ts"),
    legacyEdge("scripts/developmentFrontend.ts", "frontend/index.html"),
    legacyEdge(
        "scripts/developmentFrontend.ts",
        "frontend/src/lib/developmentProxyHeaders.ts"
    ),
    legacyEdge(
        "scripts/developmentStack.ts",
        "backend/src/development/developmentEnvironment.ts"
    ),
    legacyEdge(
        "scripts/developmentStack.ts",
        "backend/src/development/developmentRuntime.ts"
    ),
    legacyEdge(
        "scripts/developmentStack.ts",
        "backend/src/development/developmentStackConfig.ts"
    ),
    legacyEdge(
        "scripts/developmentStack.ts",
        "backend/src/development/developmentState.ts"
    ),
    legacyEdge("scripts/frontendBuild.ts", "backend/src/services/releases/runtime.ts"),
    legacyEdge("scripts/productionBootstrap.ts", "backend/src/database/connection.ts"),
    legacyEdge("scripts/productionBootstrap.ts", "backend/src/lib/dashboardPaths.ts"),
    legacyEdge("scripts/productionBootstrap.ts", "backend/src/lib/processes.ts"),
    legacyEdge("scripts/productionBootstrap.ts", "backend/src/lib/systemdProperties.ts"),
    legacyEdge("scripts/productionBootstrap.ts", "backend/src/releaseLifecycle.ts"),
    legacyEdge(
        "scripts/productionBootstrap.ts",
        "backend/src/services/releases/deployment.ts"
    ),
    legacyEdge(
        "scripts/productionBootstrap.ts",
        "backend/src/services/releases/releaseActivation.ts"
    ),
    legacyEdge(
        "scripts/productionBootstrap.ts",
        "backend/src/services/releases/systemdPolicy.ts"
    ),
    legacyEdge(
        "scripts/qualification/legacyBackendRouteProbe.ts",
        "backend/src/routes/registry.ts"
    ),
    legacyEdge(
        "scripts/writeReleaseManifest.ts",
        "backend/src/services/releases/manifestArtifacts.ts"
    ),
]);

/** Reviewed dependency-direction matrix for every source role. */
export const allowedTargets: Readonly<Record<SourceRole, ReadonlySet<SourceRole>>> = {
    browser: new Set(["browser", "contracts", "shared"]),
    "browser-app": new Set(["browser", "browser-app", "contracts", "shared"]),
    contracts: new Set(["contracts", "shared"]),
    "environment-source": new Set(["shared"]),
    "legacy-backend": new Set(),
    "legacy-frontend": new Set(),
    scripts: new Set(["contracts", "scripts", "shared"]),
    server: new Set(["contracts", "server", "shared"]),
    shared: new Set(["shared"]),
    test: new Set([
        "browser",
        "browser-app",
        "contracts",
        "scripts",
        "server",
        "shared",
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
 * Normalizes a repository-relative source path for policy evaluation.
 * @param filePath Candidate repository-relative path.
 * @returns Canonical forward-slash path without a leading dot segment.
 */
export function normalizeRepositoryPath(filePath: string): string {
    return filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

/**
 * Resolves a relative import lexically within repository path semantics.
 * @param importer Normalized repository-relative importer.
 * @param specifier Relative module specifier.
 * @returns Normalized repository-relative lexical target.
 */
export function relativeImportTarget(importer: string, specifier: string): string {
    const importerDirectory = path.posix.dirname(importer);
    const targetPath = path.posix.join(importerDirectory, specifier);
    return normalizeRepositoryPath(path.posix.normalize(targetPath));
}

/**
 * Identifies source and target paths reserved for tests or test support.
 * @param filePath Normalized repository-relative path.
 * @returns Whether the path belongs to test-only source.
 */
export function isTestPath(filePath: string): boolean {
    return (
        /(?:^|\/)(?:__tests__|test(?:Support)?)\//u.test(filePath) ||
        /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(filePath)
    );
}

/**
 * Classifies one normalized repository path into its explicit source role.
 * @param filePath Normalized repository-relative path.
 * @returns Explicit process or architectural source role.
 */
export function sourceRole(filePath: string): SourceRole {
    if (applicationCompositionTestFiles.has(filePath)) return "test";
    if (filePath.startsWith("src/app/") && isTestPath(filePath)) {
        return "unclassified-app";
    }
    if (isTestPath(filePath)) return "test";
    if (filePath === environmentSourceFile) return "environment-source";
    if (webApplicationFiles.has(filePath)) return "web-app";
    if (filePath === "src/app/browser.tsx") return "browser-app";
    if (filePath === "src/app/worker.ts") return "worker-app";
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
    if (filePath.startsWith("backend/")) return "legacy-backend";
    if (filePath.startsWith("frontend/")) return "legacy-frontend";
    return "unknown";
}
