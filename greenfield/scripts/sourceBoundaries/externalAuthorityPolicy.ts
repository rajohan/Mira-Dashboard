import type { SourceImport } from "./importGraph.ts";
import type { SourceBoundaryViolation } from "./policyTypes.ts";
import {
    normalizeRepositoryPath,
    sourceRole,
    type SourceRole,
} from "./sourceTopologyPolicy.ts";

const reviewedBareBunImportSignatures: ReadonlyMap<string, string> = new Map([
    ["src/server/rawHttp/authenticationCredentials.ts", "value:CookieMap"],
]);
const policyHandledNodeBuiltinNames: ReadonlySet<string> = new Set([
    "child_process",
    "cluster",
    "inspector",
    "module",
    "process",
    "repl",
    "test",
    "vm",
    "wasi",
    "worker_threads",
]);

function violation(
    importer: string,
    sourceImport: SourceImport,
    message: string
): SourceBoundaryViolation {
    return {
        importer,
        line: sourceImport.line,
        message,
        ...(sourceImport.specifier === undefined
            ? {}
            : { specifier: sourceImport.specifier }),
    };
}

function isInternalBareSpecifier(specifier: string): boolean {
    return /^(?:scripts|src)\//u.test(specifier);
}

function isInternalAliasSpecifier(specifier: string): boolean {
    return (
        specifier.startsWith("#") ||
        specifier.startsWith("@/") ||
        specifier === "mira-dashboard" ||
        specifier.startsWith("mira-dashboard/")
    );
}

function hasUnreviewedUrlScheme(specifier: string): boolean {
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(specifier)?.[1];
    return scheme !== undefined && scheme !== "bun" && scheme !== "node";
}

function barePackageName(specifier: string): string | undefined {
    if (specifier === "bun") return undefined;
    if (specifier.startsWith("@")) {
        const [scope, name] = specifier.split("/");
        return scope && name ? `${scope}/${name}` : specifier;
    }
    return specifier.split("/", 1)[0];
}

function isForbiddenBrowserPackage(specifier: string): boolean {
    return (
        /^(?:bun|node)(?::|$)/u.test(specifier) ||
        /^(?:@simplewebauthn\/server|@trpc\/server)(?:\/|$)/u.test(specifier) ||
        /^drizzle-orm(?:\/|$)/u.test(specifier)
    );
}

function isAllowedNeutralPackage(specifier: string): boolean {
    return (
        /^(?:date-fns(?:\/|$)|valibot(?:\/|$))/u.test(specifier) ||
        /^(?:effect\/(?:Cron|Result))$/u.test(specifier)
    );
}

function importBindingSignature(sourceImport: SourceImport): string | undefined {
    if (sourceImport.importedBindings === undefined) return undefined;
    return sourceImport.importedBindings
        .map((binding) => `${binding.typeOnly ? "type" : "value"}:${binding.imported}`)
        .toSorted()
        .join("\0");
}

function canonicalNodeBuiltinName(specifier: string): string | undefined {
    if (specifier.startsWith("node:")) {
        return specifier.slice("node:".length).split("/", 1)[0];
    }
    return specifier.includes(":") ? undefined : specifier.split("/", 1)[0];
}

function isProcessExecutionRole(importerRole: SourceRole): boolean {
    return (
        importerRole === "scripts" ||
        importerRole === "test" ||
        importerRole === "worker" ||
        importerRole === "worker-app"
    );
}

/**
 * Validates non-relative imports and runtime authority primitives for one role.
 * @param importer Normalized repository-relative importer.
 * @param importerRole Explicit importer process role.
 * @param sourceImport Parsed external or runtime-authority edge.
 * @returns Policy violation when the authority is not reviewed for the role.
 */
export function validateExternalImport(
    importer: string,
    importerRole: SourceRole,
    sourceImport: SourceImport
): SourceBoundaryViolation | undefined {
    const specifier = sourceImport.specifier;
    const isEvidenceRole = importerRole === "test";
    if (sourceImport.kind === "dynamic-code") {
        return isEvidenceRole
            ? undefined
            : violation(
                  importer,
                  sourceImport,
                  "Production source may not use eval, Function, constructor access, module compilation, WebAssembly compilation, or string-form timer dynamic-code primitives"
              );
    }
    if (sourceImport.kind === "shell-execution") {
        return isEvidenceRole
            ? undefined
            : violation(
                  importer,
                  sourceImport,
                  "Production source may not invoke Bun.$ shell-execution authority"
              );
    }
    if (sourceImport.kind === "process-execution") {
        return isProcessExecutionRole(importerRole)
            ? undefined
            : violation(
                  importer,
                  sourceImport,
                  "Only scripts and worker source may invoke reviewed process-execution authority"
              );
    }
    if (
        sourceImport.kind === "module-loader" &&
        specifier === undefined &&
        !isEvidenceRole
    ) {
        return violation(
            importer,
            sourceImport,
            "Production source may not escape or invoke an unreviewed module-loader primitive"
        );
    }
    if (specifier === undefined) {
        if (isEvidenceRole) return undefined;
        return violation(
            importer,
            sourceImport,
            "Production dynamic imports and require calls must use a literal specifier"
        );
    }
    if (specifier.startsWith("/") || hasUnreviewedUrlScheme(specifier)) {
        return violation(
            importer,
            sourceImport,
            "Source imports may not use absolute filesystem or unreviewed URL specifiers"
        );
    }
    if (isInternalAliasSpecifier(specifier)) {
        return violation(
            importer,
            sourceImport,
            "Repository package, package-import, and path aliases are forbidden; use an explicit relative specifier"
        );
    }
    if (isInternalBareSpecifier(specifier)) {
        return violation(
            importer,
            sourceImport,
            "Repository source imports must use an explicit relative specifier"
        );
    }
    if (isEvidenceRole) return undefined;
    if (/^bun:test(?:\/|$)/u.test(specifier)) {
        return violation(
            importer,
            sourceImport,
            "Production source may not import Bun test-runner APIs"
        );
    }
    if (/^bun:ffi(?:\/|$)/u.test(specifier)) {
        return violation(
            importer,
            sourceImport,
            "Production source may not import Bun FFI APIs until an exact worker adapter is reviewed"
        );
    }
    if (specifier === "bun") {
        const expectedSignature = reviewedBareBunImportSignatures.get(importer);
        if (
            expectedSignature === undefined ||
            importBindingSignature(sourceImport) !== expectedSignature
        ) {
            return violation(
                importer,
                sourceImport,
                "Bare Bun imports must match the exact reviewed importer and named binding allowlist"
            );
        }
        return undefined;
    }
    const nodeBuiltinName = canonicalNodeBuiltinName(specifier);
    if (nodeBuiltinName === "test") {
        return violation(
            importer,
            sourceImport,
            "Production source may not import Node test-runner APIs"
        );
    }
    if (nodeBuiltinName === "process") {
        return violation(
            importer,
            sourceImport,
            "Production source may not import the process module; inject typed configuration and explicit runtime facts"
        );
    }
    if (nodeBuiltinName === "wasi") {
        return violation(
            importer,
            sourceImport,
            "Production source may not import WebAssembly System Interface APIs or host preopen authority"
        );
    }
    if (
        nodeBuiltinName === "module" ||
        nodeBuiltinName === "vm" ||
        /^bun:jsc(?:\/|$)/u.test(specifier)
    ) {
        return violation(
            importer,
            sourceImport,
            "Production source may not import dynamic module-loader or code-evaluation APIs"
        );
    }
    if (
        nodeBuiltinName === "cluster" ||
        nodeBuiltinName === "inspector" ||
        nodeBuiltinName === "repl" ||
        nodeBuiltinName === "worker_threads"
    ) {
        return violation(
            importer,
            sourceImport,
            "Production source may not import unreviewed process, inspector, REPL, cluster, or worker-thread APIs"
        );
    }
    if (nodeBuiltinName === "child_process" && !isProcessExecutionRole(importerRole)) {
        return violation(
            importer,
            sourceImport,
            "Only scripts and worker source may import child-process APIs"
        );
    }
    if (
        (importerRole === "browser" || importerRole === "story") &&
        isForbiddenBrowserPackage(specifier)
    ) {
        return violation(
            importer,
            sourceImport,
            "Browser and story source may not import Bun, Node, database, or server transport packages"
        );
    }
    if (
        (importerRole === "contracts" || importerRole === "shared") &&
        !isAllowedNeutralPackage(specifier)
    ) {
        return violation(
            importer,
            sourceImport,
            "Contracts and shared source may import only reviewed environment-neutral packages"
        );
    }
    return undefined;
}

/**
 * Requires production bare imports to name a root-manifest dependency.
 * @param importer Repository-relative importing source.
 * @param sourceImport Parsed external module edge.
 * @param declaredPackageNames Dependency names from the root manifest.
 * @returns Violation for an undeclared bare package.
 */
export function validateDeclaredPackageImport(
    importer: string,
    sourceImport: SourceImport,
    declaredPackageNames: ReadonlySet<string>
): SourceBoundaryViolation | undefined {
    const normalizedImporter = normalizeRepositoryPath(importer);
    if (sourceRole(normalizedImporter) === "test") return undefined;
    const specifier = sourceImport.specifier;
    if (
        specifier === undefined ||
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        isInternalAliasSpecifier(specifier) ||
        isInternalBareSpecifier(specifier) ||
        /^([A-Za-z][A-Za-z0-9+.-]*):/u.test(specifier)
    ) {
        return undefined;
    }
    if (policyHandledNodeBuiltinNames.has(canonicalNodeBuiltinName(specifier) ?? "")) {
        return undefined;
    }
    const packageName = barePackageName(specifier);
    if (packageName === undefined || declaredPackageNames.has(packageName)) {
        return undefined;
    }
    return violation(
        normalizedImporter,
        sourceImport,
        "Bare package imports must resolve to a dependency declared by the root manifest"
    );
}
