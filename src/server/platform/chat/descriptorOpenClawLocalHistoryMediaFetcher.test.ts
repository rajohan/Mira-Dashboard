import { afterEach, describe, expect, test } from "bun:test";
import {
    chmod,
    link,
    mkdir,
    mkdtemp,
    rename,
    rm,
    symlink,
    truncate,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import Path from "node:path";

import { resolveReviewedOpenClawFileRoot } from "../files/openClawFileRootConfiguration.ts";
import {
    createDescriptorOpenClawLocalHistoryMediaFetcher,
    openClawLocalHistoryMediaMaximumBytes,
    type OpenClawLocalHistoryMediaFetcher,
} from "./descriptorOpenClawLocalHistoryMediaFetcher.ts";

const temporaryDirectories: string[] = [];
const activeFetchers: OpenClawLocalHistoryMediaFetcher[] = [];
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

afterEach(async () => {
    for (const fetcher of activeFetchers.splice(0)) fetcher.dispose();
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function fixture(): Promise<{
    readonly fetcher: OpenClawLocalHistoryMediaFetcher;
    readonly mediaRoot: string;
    readonly openClawRoot: string;
    readonly parent: string;
}> {
    const parent = await mkdtemp(Path.join(tmpdir(), "mira-local-history-media-"));
    temporaryDirectories.push(parent);
    const openClawRoot = Path.join(parent, "openclaw");
    const mediaRoot = Path.join(openClawRoot, "media");
    const productionRoot = Path.join(parent, "dashboard", "production");
    await mkdir(mediaRoot, { mode: 0o700, recursive: true });
    await chmod(openClawRoot, 0o700);
    await mkdir(productionRoot, { mode: 0o700, recursive: true });
    const fetcher = createDescriptorOpenClawLocalHistoryMediaFetcher({
        openClawRoot: await resolveReviewedOpenClawFileRoot(openClawRoot, productionRoot),
    });
    activeFetchers.push(fetcher);
    return { fetcher, mediaRoot, openClawRoot, parent };
}

function request(
    segments: readonly string[],
    options: { readonly method?: "GET" | "HEAD"; readonly range?: string } = {}
) {
    return {
        method: options.method ?? "GET",
        ...(options.range === undefined ? {} : { range: options.range }),
        segments,
        signal: new AbortController().signal,
    } as const;
}

describe("descriptor OpenClaw local-history media fetcher", () => {
    test("normalizes root-confined locators and serves bounded metadata, HEAD, and ranges", async () => {
        const { fetcher, mediaRoot } = await fixture();
        await mkdir(Path.join(mediaRoot, "nested"), { mode: 0o700 });
        const file = Path.join(mediaRoot, "nested", "diagram.png");
        await writeFile(file, png, { mode: 0o600 });
        // OpenClaw may retain these reviewed descendant modes beneath its 0700 root.
        await chmod(Path.join(mediaRoot, "nested"), 0o775);
        await chmod(file, 0o664);

        const relative = fetcher.normalizeLocator("nested/diagram.png");
        const absolute = fetcher.normalizeLocator(file);
        const fileUrl = fetcher.normalizeLocator(Bun.pathToFileURL(file).href);
        expect(relative).toEqual(["nested", "diagram.png"]);
        expect(Object.isFrozen(relative)).toBe(true);
        expect(absolute).toEqual(relative);
        expect(fileUrl).toEqual(relative);

        const full = await fetcher.fetch(request(relative!));
        expect(full.status).toBe(200);
        expect(full.headers.get("content-type")).toBe("image/png");
        expect(full.headers.get("content-length")).toBe(String(png.byteLength));
        expect(full.headers.get("accept-ranges")).toBe("bytes");
        expect(new Uint8Array(await full.arrayBuffer())).toEqual(png);

        const head = await fetcher.fetch(request(relative!, { method: "HEAD" }));
        expect(head.status).toBe(200);
        expect(head.headers.get("content-length")).toBe(String(png.byteLength));
        expect(await head.text()).toBe("");

        const partial = await fetcher.fetch(request(relative!, { range: "bytes=8-10" }));
        expect(partial.status).toBe(206);
        expect(partial.headers.get("content-range")).toBe(`bytes 8-10/${png.byteLength}`);
        expect(new Uint8Array(await partial.arrayBuffer())).toEqual(png.subarray(8, 11));

        const suffix = await fetcher.fetch(request(relative!, { range: "bytes=-2" }));
        expect(suffix.status).toBe(206);
        expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(png.subarray(-2));
        const unparsable = await fetcher.fetch(
            request(relative!, { range: "bytes=0-1,4-5" })
        );
        expect(unparsable.status).toBe(200);
        expect(unparsable.headers.get("content-range")).toBeNull();
        expect(new Uint8Array(await unparsable.arrayBuffer())).toEqual(png);
        const unsatisfiable = await fetcher.fetch(
            request(relative!, { range: "bytes=99-" })
        );
        expect(unsatisfiable.status).toBe(416);
        expect(unsatisfiable.headers.get("content-range")).toBe(
            `bytes */${png.byteLength}`
        );

        const exposed = JSON.stringify({
            headers: [...full.headers],
            relative,
            status: full.status,
        });
        expect(exposed).not.toContain(mediaRoot);
    });

    test("rejects traversal, network, remote URL, control, and outside-root locators", async () => {
        const { fetcher, mediaRoot, parent } = await fixture();
        const outside = Path.join(parent, "outside.png");
        await writeFile(outside, png, { mode: 0o600 });

        for (const candidate of [
            "../outside.png",
            "nested/../outside.png",
            String.raw`nested\outside.png`,
            "//server/share.png",
            String.raw`\\server\share.png`,
            "https://example.test/media.png",
            "data:image/png;base64,AA==",
            "file://remote.example.test/media.png",
            "bad\0name.png",
            "bad\nname.png",
            mediaRoot,
            outside,
        ]) {
            expect(fetcher.normalizeLocator(candidate)).toBeUndefined();
        }
    });

    test("rejects symlinks, hard links, directories, FIFOs, and unsafe modes without blocking", async () => {
        const { fetcher, mediaRoot, parent } = await fixture();
        const outside = Path.join(parent, "outside.png");
        await writeFile(outside, png, { mode: 0o600 });
        await symlink(outside, Path.join(mediaRoot, "linked.png"), "file");

        const original = Path.join(mediaRoot, "original.png");
        await writeFile(original, png, { mode: 0o600 });
        await link(original, Path.join(mediaRoot, "hard-linked.png"));
        await mkdir(Path.join(mediaRoot, "directory.png"), { mode: 0o700 });

        const fifo = Path.join(mediaRoot, "pipe.png");
        const fifoCreation = Bun.spawnSync({ cmd: ["mkfifo", fifo] });
        expect(fifoCreation.exitCode).toBe(0);
        const unsafe = Path.join(mediaRoot, "unsafe.png");
        await writeFile(unsafe, png, { mode: 0o600 });
        await chmod(unsafe, 0o666);

        for (const name of [
            "linked.png",
            "original.png",
            "hard-linked.png",
            "directory.png",
            "pipe.png",
            "unsafe.png",
        ]) {
            const response = await fetcher.fetch(request([name]));
            expect(response.status).toBe(404);
            expect(await response.text()).toBe("");
            expect(JSON.stringify([...response.headers])).not.toContain(parent);
        }
    });

    test("rejects oversized files and unsafe media-root mode", async () => {
        const { fetcher, mediaRoot } = await fixture();
        const oversized = Path.join(mediaRoot, "oversized.bin");
        await writeFile(oversized, "", { mode: 0o600 });
        await truncate(oversized, openClawLocalHistoryMediaMaximumBytes + 1);
        const oversizedResponse = await fetcher.fetch(request(["oversized.bin"]));
        expect(oversizedResponse.status).toBe(404);

        await writeFile(Path.join(mediaRoot, "present.png"), png, { mode: 0o600 });
        await chmod(mediaRoot, 0o777);
        const unsafeRootResponse = await fetcher.fetch(request(["present.png"]));
        expect(unsafeRootResponse.status).toBe(404);
    });

    test("only advertises sniffed passive media and allowlisted UTF-8 text", async () => {
        const { fetcher, mediaRoot } = await fixture();
        await writeFile(Path.join(mediaRoot, "note.txt"), "hello", { mode: 0o600 });
        await writeFile(Path.join(mediaRoot, "active.svg"), "<svg></svg>", {
            mode: 0o600,
        });
        await writeFile(Path.join(mediaRoot, "spoofed.png"), "not a png", {
            mode: 0o600,
        });

        const text = await fetcher.fetch(request(["note.txt"]));
        const active = await fetcher.fetch(request(["active.svg"]));
        const spoofed = await fetcher.fetch(request(["spoofed.png"]));
        expect(text.headers.get("content-type")).toBe("text/plain");
        expect(active.headers.get("content-type")).toBe("application/octet-stream");
        expect(spoofed.headers.get("content-type")).toBe("application/octet-stream");
        expect(active.headers.get("content-disposition")).toBe("attachment");
        expect(spoofed.headers.get("content-disposition")).toBe("attachment");
    });

    test("retains its descriptor anchor across a configured-root path swap", async () => {
        const { fetcher, mediaRoot, openClawRoot, parent } = await fixture();
        await writeFile(Path.join(mediaRoot, "stable.txt"), "original", {
            mode: 0o600,
        });
        const retainedRoot = Path.join(parent, "retained-openclaw");
        await rename(openClawRoot, retainedRoot);
        await mkdir(Path.join(openClawRoot, "media"), {
            mode: 0o700,
            recursive: true,
        });
        await chmod(openClawRoot, 0o700);
        await writeFile(Path.join(openClawRoot, "media", "stable.txt"), "replacement", {
            mode: 0o600,
        });

        const response = await fetcher.fetch(request(["stable.txt"]));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("original");
    });

    test("fails closed after idempotent disposal and reports only a generic abort", async () => {
        const { fetcher } = await fixture();
        fetcher.dispose();
        fetcher.dispose();
        const disposedResponse = await fetcher.fetch(request(["missing.png"]));
        expect(disposedResponse.status).toBe(404);

        const other = await fixture();
        const controller = new AbortController();
        controller.abort(new Error("sensitive-locator"));
        expect(
            other.fetcher.fetch({
                method: "GET",
                segments: ["missing.png"],
                signal: controller.signal,
            })
        ).rejects.toMatchObject({
            message: "The operation was aborted",
            name: "AbortError",
        });
    });
});
