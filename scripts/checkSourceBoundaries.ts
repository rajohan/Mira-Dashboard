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
    for (const importer of discovery.files) {
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
            if (declarationViolation !== undefined) {
                violations.push(declarationViolation);
            }
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
            if (suppressionViolation !== undefined) {
                violations.push(suppressionViolation);
            }
        }
        for (const environmentAccess of analysis.environmentAccesses) {
            const environmentViolation = validateSourceEnvironmentAccess(
                importer,
                environmentAccess.line
            );
            if (environmentViolation !== undefined) {
                violations.push(environmentViolation);
            }
        }
        for (const sourceImport of analysis.imports) {
            const legacyImportKey = legacyScriptImportKey(importer, sourceImport);
            if (
                legacyImportKey !== undefined &&
                legacyScriptImportAllowlist.has(legacyImportKey)
            ) {
                observedLegacyScriptImports.add(legacyImportKey);
                const legacyTargetViolation = await validateLegacyAllowlistTarget(
                    projectRoot,
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
                configuration.declaredPackageNames
            );
            if (packageViolation !== undefined) violations.push(packageViolation);
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
