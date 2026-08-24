import path from "node:path";

import * as v from "valibot";

import { buildDocumentationArtifacts } from "./documentation/artifacts.ts";
import {
    checkDocumentationArtifacts,
    readDocumentationSources,
    writeDocumentationArtifacts,
} from "./documentation/files.ts";
import { resolveDirectPackageVersions } from "./packageIdentity.ts";

const packageManifestSchema = v.object({
    dependencies: v.record(v.string(), v.string()),
    devDependencies: v.record(v.string(), v.string()),
});

/** Documentation synchronization mode selected by the repository command. */
export type DocumentationSynchronizationMode = "check" | "write";

/**
 * Builds and synchronizes the generated documentation for one repository checkout.
 * @param projectRoot Canonical future-root checkout.
 * @param mode Whether to verify or write the generated artifact tree.
 * @returns Completion after the selected documentation operation succeeds.
 */
export async function synchronizeGeneratedDocumentation(
    projectRoot: string,
    mode: DocumentationSynchronizationMode
): Promise<void> {
    const packageManifest = v.parse(
        packageManifestSchema,
        await Bun.file(path.join(projectRoot, "package.json")).json()
    );
    const resolvedVersions = resolveDirectPackageVersions(
        [packageManifest.dependencies, packageManifest.devDependencies],
        await Bun.file(path.join(projectRoot, "bun.lock")).text()
    );
    const artifacts = buildDocumentationArtifacts(
        { ...packageManifest, resolvedVersions },
        await readDocumentationSources(path.join(projectRoot, "docs"))
    );
    const synchronizeDocumentation =
        mode === "check" ? checkDocumentationArtifacts : writeDocumentationArtifacts;
    await synchronizeDocumentation(
        path.join(projectRoot, "docs", "generated"),
        artifacts
    );
}

if (import.meta.main) {
    await synchronizeGeneratedDocumentation(
        path.resolve(import.meta.dir, ".."),
        process.argv.includes("--check") ? "check" : "write"
    );
}
