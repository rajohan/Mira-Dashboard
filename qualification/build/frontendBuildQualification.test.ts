import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
            const developmentFiles = await listRelativeFiles(developmentOutdir);
            const developmentJavaScript = await readFilesWithExtension(
                developmentOutdir,
                developmentFiles,
                ".js"
            );
            expect(developmentJavaScript).toContain("useMemoCache");

            const production = await buildQualificationFrontend(
                "production",
                productionOutdir
            );
            const productionFiles = await listRelativeFiles(productionOutdir);
            expect(
                production.outputPaths.some((outputPath) => outputPath.endsWith(".map"))
            ).toBeFalse();
            const productionAssets = production.outputPaths.filter((outputPath) =>
                /\.(?:css|js)$/u.test(outputPath)
            );
            expect(productionAssets.length).toBeGreaterThan(0);
            expect(
                productionAssets.every((outputPath) =>
                    hashedAssetPattern.test(outputPath)
                )
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
            expect(javascript.length).toBeGreaterThan(0);
            expect(stylesheet).toContain(".bg-indigo-600");
            await assertSelfHostedFrontendHtml(path.join(productionOutdir, "index.html"));
        } finally {
            await Promise.all([
                rm(developmentOutdir, { force: true, recursive: true }),
                rm(productionOutdir, { force: true, recursive: true }),
            ]);
        }
    }, 60_000);

    test("parses HTML and rejects encoded or inline CSP dependencies", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "mira-build-html-"));
        const indexPath = path.join(directory, "index.html");
        try {
            await writeFile(
                indexPath,
                '<!doctype html><link rel="stylesheet" href="/assets/app.css"><img srcset="/assets/image.png 1x, /assets/image@2x.png 2x"><script type="module" src="/assets/app.js"></script>',
                "utf8"
            );
            await assertSelfHostedFrontendHtml(indexPath);

            for (const html of [
                '<script type="module" src="/assets/app.js">inline()</script>',
                '<script type="module" src="/assets/app.js"></script><script>inline()</script >',
                '<link href="&#x2f;&#x2f;third-party.invalid/app.css"><script type="module" src="/assets/app.js"></script>',
                '<link href="//third-party.invalid/app.css"><script type="module" src="/assets/app.js"></script>',
                '<link href="/assets/../outside.css"><script type="module" src="/assets/app.js"></script>',
                '<link href="/assets/%2e%2e/outside.css"><script type="module" src="/assets/app.js"></script>',
                '<body onload="inline()"><script type="module" src="/assets/app.js"></script>',
                '<body style="color:red"><script type="module" src="/assets/app.js"></script>',
                '<style>body{color:red}</style><script type="module" src="/assets/app.js"></script>',
                '<base href="https://third-party.invalid/"><script type="module" src="/assets/app.js"></script>',
                '<iframe srcdoc="<script src=\'https://third-party.invalid/x.js\'></script>"></iframe><script type="module" src="/assets/app.js"></script>',
                '<img srcset="/assets/image.png 1x, https://third-party.invalid/image.png 2x"><script type="module" src="/assets/app.js"></script>',
                '<img srcset="/assets/image.png invalid"><script type="module" src="/assets/app.js"></script>',
                '<video poster="https://third-party.invalid/poster.png"></video><script type="module" src="/assets/app.js"></script>',
            ]) {
                await writeFile(indexPath, html, "utf8");
                let rejected = false;
                try {
                    await assertSelfHostedFrontendHtml(indexPath);
                } catch (error) {
                    rejected = true;
                    expect(error).toBeInstanceOf(Error);
                }
                expect(rejected).toBeTrue();
            }
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });
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
