import path from "node:path";

import { validateExternalImport } from "./externalAuthorityPolicy.ts";
import type { SourceImport } from "./importGraph.ts";
import type { SourceBoundaryViolation } from "./policyTypes.ts";
import {
    allowedTargets,
    environmentSourceConsumers,
    environmentSourceFile,
    isTestPath,
    isReviewedApplicationServerTarget,
    normalizeRepositoryPath,
    relativeImportTarget,
    sourceRole,
} from "./sourceTopologyPolicy.ts";

export { validateDeclaredPackageImport } from "./externalAuthorityPolicy.ts";
export type { SourceBoundaryViolation } from "./policyTypes.ts";
export { isTestPath } from "./sourceTopologyPolicy.ts";

const reviewedRelativeExtensions: ReadonlySet<string> = new Set([
    ".css",
    ".html",
    ".json",
    ".ts",
    ".tsx",
]);

const reviewedDeclarationFiles: ReadonlySet<string> = new Set([
    "src/test/types/bunCanaryMatchers.d.ts",
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

/**
 * Validates that a source filename belongs to one explicitly classified process role.
 * @param importer Repository-relative source path.
 * @returns A violation for an unclassified application root, if present.
 */
export function validateSourceFile(
    importer: string
): SourceBoundaryViolation | undefined {
    const normalizedImporter = normalizeRepositoryPath(importer);
    const importerRole = sourceRole(normalizedImporter);
    if (!normalizedImporter.includes("/") && importerRole !== "scripts") {
        return {
            importer: normalizedImporter,
            line: 1,
            message:
                "Every repository-root executable source file must belong to an explicit reviewed process role",
        };
    }
    if (
        normalizedImporter.endsWith(".d.ts") &&
        !reviewedDeclarationFiles.has(normalizedImporter)
    ) {
        return {
            importer: normalizedImporter,
            line: 1,
            message:
                "Greenfield and script declaration files are forbidden unless added to an exact reviewed allowlist",
        };
    }
    if (!/\.tsx?$/u.test(normalizedImporter)) {
        return {
            importer: normalizedImporter,
            line: 1,
            message:
                "Production and test source must use .ts or .tsx so it remains in a strict TypeScript graph",
        };
    }
    if (
        normalizedImporter.endsWith(".tsx") &&
        importerRole !== "browser" &&
        importerRole !== "story" &&
        importerRole !== "test"
    ) {
        return {
            importer: normalizedImporter,
            line: 1,
            message:
                "Only browser and story source may use .tsx; every other scanned role must use .ts so it remains in its strict TypeScript graph",
        };
    }
    if (importerRole === "unclassified-app") {
        return {
            importer: normalizedImporter,
            line: 1,
            message:
                "Every src/app file must be explicitly classified as web, browser, worker, or test composition",
        };
    }
    if (importerRole === "unknown") {
        return {
            importer: normalizedImporter,
            line: 1,
            message: "Every scanned source file must belong to an explicit process role",
        };
    }
    return undefined;
}

/**
 * Rejects direct runtime-environment reads outside the one composition-owned source.
 * @param importer Repository-relative source path.
 * @param line One-based source line containing the access.
 * @returns A violation when production source bypasses typed configuration.
 */
export function validateSourceEnvironmentAccess(
    importer: string,
    line: number
): SourceBoundaryViolation | undefined {
    const normalizedImporter = normalizeRepositoryPath(importer);
    const importerRole = sourceRole(normalizedImporter);
    if (
        normalizedImporter === environmentSourceFile ||
        importerRole === "scripts" ||
        importerRole === "test"
    ) {
        return undefined;
    }
    return {
        importer: normalizedImporter,
        line,
        message:
            "Production source must receive typed configuration instead of reading a runtime environment directly",
    };
}

/**
 * Rejects per-file TypeScript ambient-authority and path references.
 * @param importer Repository-relative source path.
 * @param line One-based directive line.
 * @returns An unconditional violation for a triple-slash reference directive.
 */
export function validateSourceReferenceDirective(
    importer: string,
    line: number
): SourceBoundaryViolation {
    return {
        importer: normalizeRepositoryPath(importer),
        line,
        message:
            "Triple-slash reference directives are forbidden; use reviewed explicit imports and project configuration",
    };
}

/**
 * Rejects runtime/global authority objects escaping direct reviewed property access.
 * @param importer Repository-relative source path.
 * @param line One-based escape line.
 * @returns A violation outside test source.
 */
export function validateSourceRuntimeAuthorityEscape(
    importer: string,
    line: number
): SourceBoundaryViolation | undefined {
    const normalizedImporter = normalizeRepositoryPath(importer);
    if (sourceRole(normalizedImporter) === "test") {
        return undefined;
    }
    return {
        importer: normalizedImporter,
        line,
        message:
            "Production source may not alias, pass, return, or dynamically index runtime/global authority objects",
    };
}

/**
 * Rejects TypeScript diagnostic suppression in production source.
 * @param importer Repository-relative source path.
 * @param line One-based directive line.
 * @returns A violation outside test source.
 */
export function validateSourceTypeScriptSuppressionDirective(
    importer: string,
    line: number
): SourceBoundaryViolation | undefined {
    const normalizedImporter = normalizeRepositoryPath(importer);
    if (sourceRole(normalizedImporter) === "test") return undefined;
    return {
        importer: normalizedImporter,
        line,
        message:
            "Production source may not suppress TypeScript diagnostics with @ts-ignore, @ts-expect-error, or @ts-nocheck",
    };
}

/**
 * Rejects runtime-shaped ambient declarations in production source.
 * @param importer Repository-relative source path.
 * @param line One-based declaration line.
 * @returns A violation outside test source.
 */
export function validateSourceAmbientRuntimeDeclaration(
    importer: string,
    line: number
): SourceBoundaryViolation | undefined {
    const normalizedImporter = normalizeRepositoryPath(importer);
    if (sourceRole(normalizedImporter) === "test") return undefined;
    return {
        importer: normalizedImporter,
        line,
        message:
            "Production source may not declare ambient runtime values, globals, namespaces, or modules",
    };
}

/**
 * Applies the path and runtime policy to one parsed module edge.
 * @param importer Repository-relative importing file.
 * @param sourceImport Parsed import or re-export.
 * @returns The boundary violation, if the edge is forbidden.
 */
export function validateSourceImport(
    importer: string,
    sourceImport: SourceImport
): SourceBoundaryViolation | undefined {
    const normalizedImporter = normalizeRepositoryPath(importer);
    const importerRole = sourceRole(normalizedImporter);
    const isEvidenceRole = importerRole === "test";

    const specifier = sourceImport.specifier;
    if (specifier?.includes("%")) {
        return violation(
            normalizedImporter,
            sourceImport,
            "Production import specifiers may not contain percent-encoded resolver input"
        );
    }
    if (specifier !== undefined && /[?#]/u.test(specifier)) {
        return violation(
            normalizedImporter,
            sourceImport,
            "Production import specifiers may not contain resolver query or fragment suffixes"
        );
    }
    if (specifier?.includes("\\")) {
        return violation(
            normalizedImporter,
            sourceImport,
            "Source import specifiers must use canonical forward slashes"
        );
    }
    if (specifier === undefined || !specifier.startsWith(".")) {
        return validateExternalImport(normalizedImporter, importerRole, sourceImport);
    }

    const target = relativeImportTarget(normalizedImporter, specifier);
    if (target === ".." || target.startsWith("../")) {
        return violation(
            normalizedImporter,
            sourceImport,
            "Source imports may not escape the repository"
        );
    }
    if (/\.(?:node|wasm)$/iu.test(target)) {
        return violation(
            normalizedImporter,
            sourceImport,
            "Production source may not import native or WebAssembly executable module artifacts"
        );
    }
    const targetExtension = path.posix.extname(target);
    if ((targetExtension === "" || targetExtension === ".") && !isEvidenceRole) {
        return violation(
            normalizedImporter,
            sourceImport,
            "Production relative imports must include an explicit file extension to prevent runtime resolver fallback"
        );
    }
    if (
        targetExtension !== "" &&
        targetExtension !== "." &&
        !reviewedRelativeExtensions.has(targetExtension)
    ) {
        return violation(
            normalizedImporter,
            sourceImport,
            "Production relative imports must use a reviewed explicit .ts, .tsx, .css, .html, or .json extension"
        );
    }
    if (isTestPath(target) && !isEvidenceRole) {
        return violation(
            normalizedImporter,
            sourceImport,
            "Production source may not import tests or test-support modules"
        );
    }

    const targetRole = sourceRole(target);
    if (targetRole === "environment-source") {
        return isEvidenceRole || environmentSourceConsumers.has(normalizedImporter)
            ? undefined
            : violation(
                  normalizedImporter,
                  sourceImport,
                  "Only the web and worker composition roots may import the runtime environment source"
              );
    }
    if (targetRole === "unclassified-app") {
        return violation(
            normalizedImporter,
            sourceImport,
            "Imports may not target an unclassified src/app file"
        );
    }
    if (
        targetRole === "server" &&
        isReviewedApplicationServerTarget(normalizedImporter, target)
    ) {
        return undefined;
    }
    if (!allowedTargets[importerRole].has(targetRole)) {
        return violation(
            normalizedImporter,
            sourceImport,
            `Source role ${importerRole} may not import ${targetRole}`
        );
    }
    return undefined;
}
