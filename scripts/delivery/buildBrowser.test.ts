import { afterEach, describe, expect, test } from "bun:test";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { buildBrowserArtifact } from "./buildBrowser.ts";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const scriptPath = path.join(import.meta.dir, "buildBrowser.ts");
const outputDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        outputDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function relativeFiles(directory: string): Promise<string[]> {
    const files: string[] = [];
    const pending = [directory];
    while (pending.length > 0) {
        const current = pending.pop();
        if (!current) continue;
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) pending.push(entryPath);
            else if (entry.isFile()) {
                files.push(path.relative(directory, entryPath).replaceAll("\\", "/"));
            }
        }
    }
    return files.toSorted();
}

async function runBuild(outputDirectory: string) {
    const child = Bun.spawn(
        [process.execPath, scriptPath, `--output=${outputDirectory}`],
        {
            cwd: repositoryRoot,
            stderr: "pipe",
            stdin: "ignore",
            stdout: "pipe",
        }
    );
    const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
    ]);
    return { exitCode, stderr, stdout };
}

describe("Dashboard browser artifact", () => {
    test("builds the product entry with budgets, hashes and precompression", async () => {
        const outputDirectory = path.join(
            repositoryRoot,
            `dist/test-browser-${Bun.randomUUIDv7()}`
        );
        outputDirectories.push(outputDirectory);

        const execution = await runBuild(outputDirectory);
        expect(execution).toMatchObject({ exitCode: 0, stderr: "" });
        const result = JSON.parse(execution.stdout) as {
            compressedFileCount: number;
            outputDirectory: string;
            status: string;
        };
        const files = await relativeFiles(outputDirectory);
        const html = await readFile(path.join(outputDirectory, "index.html"), "utf8");
        const stylesheet = files.find((file) => file.endsWith(".css"));
        if (stylesheet === undefined) {
            throw new Error("Browser build did not emit a stylesheet.");
        }
        const css = await readFile(path.join(outputDirectory, stylesheet), "utf8");
        const metrics = JSON.parse(
            await readFile(path.join(outputDirectory, "bundle-metrics.json"), "utf8")
        ) as { formatVersion: number };

        expect(result).toMatchObject({ outputDirectory, status: "BUILT" });
        expect(result.compressedFileCount).toBeGreaterThan(0);
        expect(metrics.formatVersion).toBe(1);
        expect(html).toContain("<title>Mira Dashboard</title>");
        expect(html).toMatch(/<meta name="theme-color" content="#0f172a"\s*\/?>/u);
        expect(html).toMatch(
            /<link rel="icon" href="\/assets\/favicon-[a-z\d]{8}\.png" sizes="96x96" type="image\/png"\s*\/?>/u
        );
        expect(html).toMatch(
            /<link rel="apple-touch-icon" href="\/assets\/apple-touch-icon-[a-z\d]{8}\.png" sizes="180x180"\s*\/?>/u
        );
        expect(
            files.some((file) => /^assets\/favicon-[a-z\d]{8}\.png$/u.test(file))
        ).toBeTrue();
        expect(
            files.some((file) => /^assets\/apple-touch-icon-[a-z\d]{8}\.png$/u.test(file))
        ).toBeTrue();
        expect(css).toContain("::-webkit-search-cancel-button{-webkit-appearance:none}");
        expect(css).toContain("::-webkit-search-cancel-button{appearance:none}");
        expect(css).toContain("infinite loading-state-second-dot}");
        expect(css).toContain("infinite loading-state-third-dot}");
        expect(css).toContain("@keyframes loading-state-second-dot");
        expect(css).toContain("@keyframes loading-state-third-dot");
        expect(css).toContain(String.raw`.motion-reduce\:animate-none{animation:none}`);
        expect(css).toContain(String.raw`.motion-reduce\:opacity-100{opacity:1}`);
        expect(css).toContain("-webkit-overflow-scrolling:touch");
        expect(css).not.toContain("scroll-margin-top:123.456px");
        expect(html).toMatch(
            /<script\b[^>]*\bsrc="\/assets\/.+-[a-z\d]{8}\.js"[^>]*><\/script>/u
        );
        expect(files).toContain("bundle-metrics.json");
        expect(files.some((file) => file.endsWith(".br"))).toBeTrue();
        expect(files.some((file) => file.endsWith(".gz"))).toBeTrue();
        expect(files.filter((file) => file.endsWith(".js")).length).toBeGreaterThan(1);
        expect(
            files
                .filter((file) => /\.(?:css|js)$/u.test(file))
                .every((file) => /^assets\/.+-[a-z\d]{8}\.(?:css|js)$/u.test(file))
        ).toBeTrue();
    }, 60_000);

    test("rejects output outside the repository build boundary", async () => {
        const outputDirectory = path.join(repositoryRoot, "dist");
        const execution = await runBuild(outputDirectory);

        expect(execution.exitCode).toBe(1);
        expect(execution.stdout).toBe("");
        expect(execution.stderr).toBe("Browser build paths are invalid\n");
        expect(buildBrowserArtifact(repositoryRoot, outputDirectory)).rejects.toThrow(
            "Browser build paths are invalid"
        );
    });
});
