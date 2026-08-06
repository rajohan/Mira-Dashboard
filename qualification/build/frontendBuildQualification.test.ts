import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    assertSelfHostedFrontendHtml,
    buildQualificationFrontend,
    qualificationFrontendPluginOrder,
} from "./frontendBuildQualification";

const hashedAssetPattern = /^assets\/.+-[a-z\d]{8}\.(?:css|js)$/u;

describe("Bun frontend build qualification", () => {
    test("proves compiler-first HTML mechanics, Tailwind, lazy chunks, and delivery policy", async () => {
        const developmentOutdir = await mkdtemp(
            path.join(tmpdir(), "mira-build-development-")
        );
        const productionOutdir = await mkdtemp(
            path.join(tmpdir(), "mira-build-production-")
        );

        try {
            expect(qualificationFrontendPluginOrder).toEqual([
                "react-compiler",
                "@tailwindcss/bun",
            ]);

            const development = await buildQualificationFrontend(
                "development",
                developmentOutdir
            );
            expect(
                development.outputPaths.some((outputPath) => outputPath.endsWith(".map"))
            ).toBeTrue();
            await assertSelfHostedFrontendHtml(
                path.join(developmentOutdir, "index.html")
            );

            const production = await buildQualificationFrontend(
                "production",
                productionOutdir
            );
            const productionFiles = await listRelativeFiles(productionOutdir);
            expect(
                production.outputPaths.some((outputPath) => outputPath.endsWith(".map"))
            ).toBeFalse();
            expect(
                production.outputPaths
                    .filter((outputPath) => /\.(?:css|js)$/u.test(outputPath))
                    .every((outputPath) => hashedAssetPattern.test(outputPath))
            ).toBeTrue();
            expect(production.compressedFileCount).toBeGreaterThan(0);
            expect(productionFiles.some((file) => file.endsWith(".br"))).toBeTrue();
            expect(productionFiles.some((file) => file.endsWith(".gz"))).toBeTrue();
            expect(production.metrics?.formatVersion).toBe(1);

            const lazyJavaScript = production.outputPaths.filter(
                (outputPath) =>
                    outputPath.endsWith(".js") &&
                    !production.initialOutputPaths.includes(outputPath)
            );
            expect(lazyJavaScript.length).toBeGreaterThan(0);
            expect(
                Object.values(production.metafile.outputs).some((output) =>
                    output.imports.some(({ kind }) => kind === "dynamic-import")
                )
            ).toBeTrue();

            const javascript = await readFilesWithExtension(
                productionOutdir,
                productionFiles,
                ".js"
            );
            const stylesheet = await readFilesWithExtension(
                productionOutdir,
                productionFiles,
                ".css"
            );
            expect(javascript).toContain("useMemoCache");
            expect(stylesheet).toContain(".bg-indigo-600");
            await assertSelfHostedFrontendHtml(path.join(productionOutdir, "index.html"));
        } finally {
            await Promise.all([
                rm(developmentOutdir, { force: true, recursive: true }),
                rm(productionOutdir, { force: true, recursive: true }),
            ]);
        }
    }, 60_000);
});

async function listRelativeFiles(directory: string): Promise<string[]> {
    const files: string[] = [];
    const pending = [directory];
    while (pending.length > 0) {
        const current = pending.pop();
        if (!current) continue;
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                pending.push(entryPath);
            } else if (entry.isFile()) {
                files.push(path.relative(directory, entryPath).replaceAll("\\", "/"));
            }
        }
    }
    return files.toSorted();
}

async function readFilesWithExtension(
    directory: string,
    files: readonly string[],
    extension: string
): Promise<string> {
    const contents = await Promise.all(
        files
            .filter((file) => file.endsWith(extension))
            .map((file) => readFile(path.join(directory, file), "utf8"))
    );
    return contents.join("\n");
}
