import path from "node:path";

import * as v from "valibot";

import { buildDocumentationArtifacts } from "./documentation/artifacts.ts";
import {
    checkDocumentationArtifacts,
    writeDocumentationArtifacts,
} from "./documentation/files.ts";
import { resolveDirectPackageVersions } from "./packageIdentity.ts";

const packageManifestSchema = v.object({
    dependencies: v.record(v.string(), v.string()),
    devDependencies: v.record(v.string(), v.string()),
});

const projectRoot = path.resolve(import.meta.dir, "..");
const outputDirectory = path.join(projectRoot, "docs", "generated");
const packageManifest = v.parse(
    packageManifestSchema,
    await Bun.file(path.join(projectRoot, "package.json")).json()
);
const resolvedVersions = resolveDirectPackageVersions(
    [packageManifest.dependencies, packageManifest.devDependencies],
    await Bun.file(path.join(projectRoot, "bun.lock")).text()
);
const artifacts = buildDocumentationArtifacts({
    ...packageManifest,
    resolvedVersions,
});

const synchronizeDocumentation = process.argv.includes("--check")
    ? checkDocumentationArtifacts
    : writeDocumentationArtifacts;
await synchronizeDocumentation(outputDirectory, artifacts);
