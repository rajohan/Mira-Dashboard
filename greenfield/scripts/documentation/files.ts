import { mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";

async function generatedFiles(directory: string, prefix = ""): Promise<string[]> {
    const entries = await readdir(path.join(directory, prefix), {
        withFileTypes: true,
    }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            return [];
        }
        throw error;
    });
    const files: string[] = [];
    for (const entry of entries) {
        const relativePath = path.join(prefix, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await generatedFiles(directory, relativePath)));
        } else if (entry.isFile()) {
            files.push(relativePath);
        }
    }
    return files;
}

/**
 * Writes generated docs and removes stale generated files.
 * @param outputDirectory Generated documentation root.
 * @param artifacts Expected path/content pairs.
 */
export async function writeDocumentationArtifacts(
    outputDirectory: string,
    artifacts: ReadonlyMap<string, string>
): Promise<void> {
    for (const [relativePath, content] of artifacts) {
        const outputPath = path.join(outputDirectory, relativePath);
        await mkdir(path.dirname(outputPath), { recursive: true });
        await Bun.write(outputPath, content);
    }

    for (const relativePath of await generatedFiles(outputDirectory)) {
        if (!artifacts.has(relativePath)) {
            await unlink(path.join(outputDirectory, relativePath));
        }
    }
}

/**
 * Verifies that committed generated docs exactly match the current registries.
 * @param outputDirectory Generated documentation root.
 * @param artifacts Expected path/content pairs.
 */
export async function checkDocumentationArtifacts(
    outputDirectory: string,
    artifacts: ReadonlyMap<string, string>
): Promise<void> {
    const actualFiles = await generatedFiles(outputDirectory);
    const expectedFiles = [...artifacts.keys()];
    if (actualFiles.toSorted().join("\n") !== expectedFiles.toSorted().join("\n")) {
        throw new Error(
            "Generated documentation file set is stale; run bun run docs:generate"
        );
    }

    for (const [relativePath, expected] of artifacts) {
        const actual = await Bun.file(path.join(outputDirectory, relativePath)).text();
        if (actual !== expected) {
            throw new Error(
                `Generated documentation is stale at ${relativePath}; run bun run docs:generate`
            );
        }
    }
}
