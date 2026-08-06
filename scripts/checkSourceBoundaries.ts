import { realpath } from "node:fs/promises";
import path from "node:path";

import { readBoundaryConfiguration } from "./sourceBoundaries/boundaryConfiguration.ts";
import { parseSourceAnalysis } from "./sourceBoundaries/importGraph.ts";
import {
    validateExactRelativeImportTarget,
    validateLegacyAllowlistTarget,
} from "./sourceBoundaries/importTargetValidation.ts";
import {
    legacyScriptImportAllowlist,
    legacyScriptImportKey,
    type SourceBoundaryViolation,
    validateDeclaredPackageImport,
    validateSourceAmbientRuntimeDeclaration,
    validateSourceEnvironmentAccess,
    validateSourceFile,
    validateSourceImport,
    validateSourceReferenceDirective,
    validateSourceRuntimeAuthorityEscape,
    validateSourceTypeScriptSuppressionDirective,
} from "./sourceBoundaries/policy.ts";
import { discoverSourceFiles } from "./sourceBoundaries/sourceDiscovery.ts";

const sourceAnalysisConcurrency = 4;

interface SourceAnalysisResult {
    readonly observedLegacyScriptImports: readonly string[];
    readonly violations: readonly SourceBoundaryViolation[];
}

async function mapWithBoundedConcurrency<A, B>(
    values: readonly A[],
    maximumConcurrency: number,
    transform: (value: A) => Promise<B>
): Promise<readonly B[]> {
    const results = Array.from<B>({ length: values.length });
    let nextIndex = 0;
    const workers = Array.from(
        { length: Math.min(maximumConcurrency, values.length) },
        async () => {
            while (nextIndex < values.length) {
                const index = nextIndex;
                nextIndex += 1;
                const value = values[index];
                if (value !== undefined) results[index] = await transform(value);
            }
        }
    );
    await Promise.all(workers);
    return results;
}

async function analyzeSourceFile(
    projectRoot: string,
    realProjectRoot: string,
    importer: string,
    declaredPackageNames: ReadonlySet<string>
): Promise<SourceAnalysisResult> {
    const violations: SourceBoundaryViolation[] = [];
    const observedLegacyScriptImports: string[] = [];
    const fileViolation = validateSourceFile(importer);
    if (fileViolation !== undefined) violations.push(fileViolation);

    const analysis = await parseSourceAnalysis(
        await Bun.file(path.join(projectRoot, importer)).text(),
        importer
    );
    for (const declaration of analysis.ambientRuntimeDeclarations) {
        const declarationViolation = validateSourceAmbientRuntimeDeclaration(
            importer,
            declaration.line
        );
        if (declarationViolation !== undefined) violations.push(declarationViolation);
    }
    for (const referenceDirective of analysis.referenceDirectives) {
        violations.push(
            validateSourceReferenceDirective(importer, referenceDirective.line)
        );
    }
    for (const runtimeAuthorityEscape of analysis.runtimeAuthorityEscapes) {
        const escapeViolation = validateSourceRuntimeAuthorityEscape(
            importer,
            runtimeAuthorityEscape.line
        );
        if (escapeViolation !== undefined) violations.push(escapeViolation);
    }
    for (const suppression of analysis.typeScriptSuppressionDirectives) {
        const suppressionViolation = validateSourceTypeScriptSuppressionDirective(
            importer,
            suppression.line
        );
        if (suppressionViolation !== undefined) violations.push(suppressionViolation);
    }
    for (const environmentAccess of analysis.environmentAccesses) {
        const environmentViolation = validateSourceEnvironmentAccess(
            importer,
            environmentAccess.line
        );
        if (environmentViolation !== undefined) violations.push(environmentViolation);
    }
    for (const sourceImport of analysis.imports) {
        const legacyImportKey = legacyScriptImportKey(importer, sourceImport);
        if (
            legacyImportKey !== undefined &&
            legacyScriptImportAllowlist.has(legacyImportKey)
        ) {
            observedLegacyScriptImports.push(legacyImportKey);
            const legacyTargetViolation = await validateLegacyAllowlistTarget(
                projectRoot,
                realProjectRoot,
                legacyImportKey
            );
            if (legacyTargetViolation !== undefined) {
                violations.push(legacyTargetViolation);
            }
        }
        const importViolation = validateSourceImport(importer, sourceImport);
        if (importViolation === undefined) {
            const exactTargetViolation = await validateExactRelativeImportTarget(
                projectRoot,
                realProjectRoot,
                importer,
                sourceImport
            );
            if (exactTargetViolation !== undefined) {
                violations.push(exactTargetViolation);
            }
        } else {
            violations.push(importViolation);
        }
        const packageViolation = validateDeclaredPackageImport(
            importer,
            sourceImport,
            declaredPackageNames
        );
        if (packageViolation !== undefined) violations.push(packageViolation);
    }
    return { observedLegacyScriptImports, violations };
}

/**
 * Scans all greenfield and script source against the explicit process-boundary policy.
 * @param projectRoot Absolute repository root.
 * @returns Sorted actionable violations.
 */
export async function checkSourceBoundaries(
    projectRoot: string
): Promise<readonly SourceBoundaryViolation[]> {
    const discovery = await discoverSourceFiles(projectRoot);
    const configuration = await readBoundaryConfiguration(projectRoot);
    const violations: SourceBoundaryViolation[] = [
        ...discovery.violations,
        ...configuration.violations,
    ];
    const observedLegacyScriptImports = new Set<string>();
    const realProjectRoot = await realpath(path.resolve(projectRoot));
    const sourceResults = await mapWithBoundedConcurrency(
        discovery.files,
        sourceAnalysisConcurrency,
        (importer) =>
            analyzeSourceFile(
                projectRoot,
                realProjectRoot,
                importer,
                configuration.declaredPackageNames
            )
    );
    for (const result of sourceResults) {
        violations.push(...result.violations);
        for (const observedImport of result.observedLegacyScriptImports) {
            observedLegacyScriptImports.add(observedImport);
        }
    }
    for (const allowlistedImport of legacyScriptImportAllowlist) {
        if (observedLegacyScriptImports.has(allowlistedImport)) continue;
        const separatorIndex = allowlistedImport.indexOf("\0");
        violations.push({
            importer: allowlistedImport.slice(0, separatorIndex),
            line: 1,
            message: "Legacy script allowlist entry is stale or no longer imported",
            specifier: allowlistedImport.slice(separatorIndex + 1),
        });
    }
    return violations.toSorted(
        (left, right) =>
            left.importer.localeCompare(right.importer) || left.line - right.line
    );
}

function renderViolation(violation: SourceBoundaryViolation): string {
    const specifier =
        violation.specifier === undefined ? "" : ` (${violation.specifier})`;
    return `${violation.importer}:${violation.line}: ${violation.message}${specifier}`;
}

async function main(): Promise<void> {
    const projectRoot = path.resolve(import.meta.dir, "..");
    const violations = await checkSourceBoundaries(projectRoot);
    if (violations.length > 0) {
        throw new Error(
            `Source-boundary check failed:\n${violations.map((current) => renderViolation(current)).join("\n")}`
        );
    }
    console.log("Source boundaries: ok");
}

if (import.meta.main) await main();
