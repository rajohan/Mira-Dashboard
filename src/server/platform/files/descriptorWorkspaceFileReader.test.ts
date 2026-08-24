import { afterEach, describe, expect, test } from "bun:test";
import Fs from "node:fs";
import Os from "node:os";
import Path from "node:path";

import { workspaceFileLimits } from "../../../contracts/files.ts";
import { CONFIG_REDACTION_SENTINEL } from "../../../shared/configRedaction.ts";
import { WorkspaceFileError } from "../../domains/files/errors.ts";
import type { WorkspaceFileReader } from "../../domains/files/ports.ts";
import { createDescriptorWorkspaceFileReader } from "./descriptorWorkspaceFileReader.ts";

const temporaryDirectories: string[] = [];
const readers: WorkspaceFileReader[] = [];

function fixture() {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-files-reader-"));
    temporaryDirectories.push(root);
    const reader = createDescriptorWorkspaceFileReader({
        roots: [{ id: "workspace", label: "Workspace", path: root, writable: true }],
    });
    readers.push(reader);
    return { reader, root };
}

function openClawFixture() {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-openclaw-reader-"));
    temporaryDirectories.push(root);
    Fs.chmodSync(root, 0o700);
    Fs.mkdirSync(Path.join(root, "hooks", "transforms"), { recursive: true });
    Fs.chmodSync(Path.join(root, "hooks"), 0o775);
    Fs.chmodSync(Path.join(root, "hooks", "transforms"), 0o775);
    Fs.writeFileSync(
        Path.join(root, "openclaw.json"),
        JSON.stringify({
            gateway: { token: "raw-gateway-secret", url: "ws://localhost:18789" },
            plugins: [{ apiKey: "raw-plugin-secret", enabled: true }],
        })
    );
    Fs.chmodSync(Path.join(root, "openclaw.json"), 0o600);
    Fs.writeFileSync(
        Path.join(root, "hooks", "transforms", "agentmail.ts"),
        "export const transform = 'safe';\n"
    );
    Fs.chmodSync(Path.join(root, "hooks", "transforms", "agentmail.ts"), 0o664);
    const reader = createDescriptorWorkspaceFileReader({
        roots: [
            {
                id: "openclaw-config",
                label: "OpenClaw Config",
                manifest: [
                    {
                        contentPolicy: "redacted-config-json",
                        maximumSizeBytes: workspaceFileLimits.maximumManifestFileBytes,
                        segments: ["openclaw.json"],
                        uploadContentPolicy: "reject-redaction-sentinel",
                        writable: true,
                    },
                    {
                        contentPolicy: "raw",
                        maximumSizeBytes: workspaceFileLimits.maximumManifestFileBytes,
                        segments: ["hooks", "transforms", "agentmail.ts"],
                        uploadContentPolicy: "reject-redaction-sentinel",
                        writable: true,
                    },
                ],
                path: root,
                writable: false,
            },
        ],
    });
    readers.push(reader);
    return { reader, root };
}

function reason(error: unknown): string | undefined {
    return error instanceof WorkspaceFileError ? error.reason : undefined;
}

afterEach(async () => {
    for (const reader of readers.splice(0)) {
        const disposal = reader.dispose();
        if (disposal !== undefined) await disposal;
    }
    for (const directory of temporaryDirectories.splice(0)) {
        Fs.rmSync(directory, { force: true, recursive: true });
    }
});

describe("descriptor workspace file reader", () => {
    test("resolves only regular files beneath a reviewed root", async () => {
        const { reader, root } = fixture();
        Fs.mkdirSync(Path.join(root, "docs"));
        const file = Path.join(root, "docs", "guide.md");
        Fs.writeFileSync(file, "# Guide\n");
        const resolveReference = reader.resolveReference;
        if (resolveReference === undefined) {
            throw new TypeError("Descriptor reader does not resolve references");
        }

        expect(await resolveReference(file)).toEqual({
            rootId: "workspace",
            segments: ["docs", "guide.md"],
        });
        expect(await resolveReference(Path.join(root, "docs"))).toBeUndefined();
        expect(await resolveReference("/etc/passwd")).toBeUndefined();
        expect(await resolveReference(`${root}/docs/../docs/guide.md`)).toBeUndefined();
    });

    test("lists stable visible regular entries without exposing symlinks or hard links", async () => {
        const { reader, root } = fixture();
        Fs.mkdirSync(Path.join(root, "docs"));
        Fs.writeFileSync(Path.join(root, "README.md"), "# Hello\n");
        Fs.writeFileSync(Path.join(root, ".secret"), "hidden");
        Fs.writeFileSync(Path.join(root, ".env.example"), "SAFE=true\n");
        Fs.symlinkSync("/etc/passwd", Path.join(root, "escape"));
        Fs.linkSync(Path.join(root, "README.md"), Path.join(root, "linked.md"));

        const result = await reader.list({ rootId: "workspace", segments: [] });

        expect(result.directory).toMatchObject({
            kind: "directory",
            name: "Workspace",
            writable: true,
        });
        expect(result.entries.map(({ kind, name }) => [kind, name])).toEqual([
            ["directory", "docs"],
            ["file", ".env.example"],
        ]);
        expect(JSON.stringify(result)).not.toContain(root);
    });

    test("rejects traversal, hidden segments, and symlinked ancestors", async () => {
        const { reader, root } = fixture();
        Fs.mkdirSync(Path.join(root, "real"));
        Fs.writeFileSync(Path.join(root, "real", "file.txt"), "safe");
        Fs.symlinkSync("real", Path.join(root, "alias"));

        for (const segments of [[".."], [".secret"], ["alias", "file.txt"]]) {
            const caught = await reader
                .describe({ rootId: "workspace", segments })
                .catch((error: unknown) => error);
            expect(reason(caught)).toBe("access-denied");
        }
    });

    test("shows only the OpenClaw manifest tree and redacts config before reads", async () => {
        const { reader, root } = openClawFixture();
        Fs.writeFileSync(Path.join(root, "credentials.json"), '{"token":"sibling"}');
        Fs.mkdirSync(Path.join(root, "sessions"));
        Fs.writeFileSync(Path.join(root, "sessions", "session.jsonl"), "private");
        Fs.writeFileSync(Path.join(root, "hooks", "secret.ts"), "private");

        const rootListing = await reader.list({
            rootId: "openclaw-config",
            segments: [],
        });
        expect(rootListing.directory).toMatchObject({
            name: "OpenClaw Config",
            writable: false,
        });
        expect(
            rootListing.entries.map(({ kind, name, writable }) => [kind, name, writable])
        ).toEqual([
            ["directory", "hooks", false],
            ["file", "openclaw.json", true],
        ]);
        expect(JSON.stringify(rootListing)).not.toContain(root);
        expect(JSON.stringify(rootListing)).not.toContain("credentials");
        expect(JSON.stringify(rootListing)).not.toContain("sessions");

        const hooks = await reader.list({
            rootId: "openclaw-config",
            segments: ["hooks"],
        });
        expect(hooks.entries.map(({ name }) => name)).toEqual(["transforms"]);
        const transforms = await reader.list({
            rootId: "openclaw-config",
            segments: ["hooks", "transforms"],
        });
        expect(transforms.entries.map(({ name }) => name)).toEqual(["agentmail.ts"]);

        const locator = {
            rootId: "openclaw-config",
            segments: ["openclaw.json"],
        } as const;
        const described = await reader.describe(locator);
        const result = await reader.read(locator, described.revision, undefined);
        const text = new TextDecoder().decode(result.bytes);
        expect(result.sizeBytes).toBe(result.bytes.byteLength);
        expect(described.sizeBytes).toBe(result.sizeBytes);
        expect(text).toContain(CONFIG_REDACTION_SENTINEL);
        expect(text).toContain("ws://localhost:18789");
        expect(text).not.toContain("raw-gateway-secret");
        expect(text).not.toContain("raw-plugin-secret");
        expect(described).toMatchObject({
            requiresSecretReveal: true,
            uploadContentPolicy: "reject-redaction-sentinel",
            writable: true,
            writeMaximumSizeBytes: workspaceFileLimits.maximumManifestFileBytes,
        });
        const revealed = await reader.describe(locator, undefined, "reveal-secrets");
        const revealedResult = await reader.read(
            locator,
            revealed.revision,
            undefined,
            undefined,
            "reveal-secrets"
        );
        expect(new TextDecoder().decode(revealedResult.bytes)).toContain(
            "raw-gateway-secret"
        );

        const transformLocator = {
            rootId: "openclaw-config",
            segments: ["hooks", "transforms", "agentmail.ts"],
        } as const;
        const transform = await reader.describe(transformLocator);
        expect(transform).toMatchObject({
            uploadContentPolicy: "reject-redaction-sentinel",
            writable: true,
        });
        const transformResult = await reader.read(
            transformLocator,
            transform.revision,
            undefined
        );
        expect(new TextDecoder().decode(transformResult.bytes)).toBe(
            "export const transform = 'safe';\n"
        );
    });

    test("rejects non-manifest paths, symlinks, hard links, and unsafe modes", async () => {
        const { reader, root } = openClawFixture();
        for (const segments of [
            [".."],
            ["sessions"],
            ["hooks", "secret.ts"],
            ["hooks", "transforms", "..", "openclaw.json"],
        ]) {
            const caught = await reader
                .describe({ rootId: "openclaw-config", segments })
                .catch((error: unknown) => error);
            expect(reason(caught)).toBe("access-denied");
        }

        const transformPath = Path.join(root, "hooks", "transforms", "agentmail.ts");
        Fs.unlinkSync(transformPath);
        Fs.symlinkSync("/etc/passwd", transformPath);
        expect(
            reason(
                await reader
                    .describe({
                        rootId: "openclaw-config",
                        segments: ["hooks", "transforms", "agentmail.ts"],
                    })
                    .catch((error: unknown) => error)
            )
        ).toBe("access-denied");

        const configPath = Path.join(root, "openclaw.json");
        const linkedSource = Path.join(root, "linked-source.json");
        Fs.unlinkSync(configPath);
        Fs.writeFileSync(linkedSource, '{"safe":true}');
        Fs.linkSync(linkedSource, configPath);
        expect(
            reason(
                await reader
                    .describe({
                        rootId: "openclaw-config",
                        segments: ["openclaw.json"],
                    })
                    .catch((error: unknown) => error)
            )
        ).toBe("access-denied");

        Fs.unlinkSync(configPath);
        Fs.writeFileSync(configPath, '{"safe":true}');
        Fs.chmodSync(configPath, 0o602);
        expect(
            reason(
                await reader
                    .describe({
                        rootId: "openclaw-config",
                        segments: ["openclaw.json"],
                    })
                    .catch((error: unknown) => error)
            )
        ).toBe("access-denied");

        Fs.chmodSync(configPath, 0o600);
        Fs.chmodSync(root, 0o750);
        expect(
            reason(
                await reader
                    .describe({
                        rootId: "openclaw-config",
                        segments: ["openclaw.json"],
                    })
                    .catch((error: unknown) => error)
            )
        ).toBe("access-denied");
    });

    test("fails closed when redacted configuration is not valid JSON", async () => {
        const { reader, root } = openClawFixture();
        Fs.writeFileSync(Path.join(root, "openclaw.json"), '{"token":"raw-secret"');
        Fs.chmodSync(Path.join(root, "openclaw.json"), 0o600);

        const caught = await reader
            .describe({
                rootId: "openclaw-config",
                segments: ["openclaw.json"],
            })
            .catch((error: unknown) => error);
        expect(reason(caught)).toBe("unavailable");
        expect(String(caught)).not.toContain("raw-secret");
        const listing = await reader.list({
            rootId: "openclaw-config",
            segments: [],
        });
        expect(
            listing.entries.find(({ name }) => name === "openclaw.json")
        ).toMatchObject({ requiresSecretReveal: true, writable: true });
        const revealed = await reader.describe(
            { rootId: "openclaw-config", segments: ["openclaw.json"] },
            undefined,
            "reveal-secrets"
        );
        expect(revealed.previewKind).toBe("text");
    });

    test("keeps reviewed files above the text-preview budget download-only", async () => {
        const { reader, root } = openClawFixture();
        const secretPrefix = "raw-oversized-secret";
        const rawConfig = JSON.stringify({
            token: secretPrefix + "a".repeat(workspaceFileLimits.maximumTextPreviewBytes),
        });
        expect(Buffer.byteLength(rawConfig)).toBeGreaterThan(
            workspaceFileLimits.maximumTextPreviewBytes
        );
        expect(Buffer.byteLength(rawConfig)).toBeLessThanOrEqual(
            workspaceFileLimits.maximumManifestFileBytes
        );
        const configPath = Path.join(root, "openclaw.json");
        Fs.writeFileSync(configPath, rawConfig);
        Fs.chmodSync(configPath, 0o600);

        const transformPath = Path.join(root, "hooks", "transforms", "agentmail.ts");
        Fs.writeFileSync(
            transformPath,
            Buffer.alloc(workspaceFileLimits.maximumTextPreviewBytes + 1, 0x61)
        );
        Fs.chmodSync(transformPath, 0o664);

        const configLocator = {
            rootId: "openclaw-config",
            segments: ["openclaw.json"],
        } as const;
        const rootListing = await reader.list({
            rootId: "openclaw-config",
            segments: [],
        });
        expect(
            rootListing.entries.find(({ name }) => name === "openclaw.json")
        ).toMatchObject({
            previewKind: "download-only",
            requiresSecretReveal: true,
            writeMaximumSizeBytes: workspaceFileLimits.maximumManifestFileBytes,
        });
        const config = await reader.describe(configLocator);
        expect(config).toMatchObject({
            previewKind: "download-only",
            requiresSecretReveal: true,
            writeMaximumSizeBytes: workspaceFileLimits.maximumManifestFileBytes,
        });
        expect(config.sizeBytes).toBeLessThan(
            workspaceFileLimits.maximumTextPreviewBytes
        );
        const configResult = await reader.read(configLocator, config.revision, undefined);
        const redacted = new TextDecoder().decode(configResult.bytes);
        expect(configResult.previewKind).toBe("download-only");
        expect(redacted).toContain(CONFIG_REDACTION_SENTINEL);
        expect(redacted).not.toContain(secretPrefix);

        const transforms = await reader.list({
            rootId: "openclaw-config",
            segments: ["hooks", "transforms"],
        });
        expect(
            transforms.entries.find(({ name }) => name === "agentmail.ts")
        ).toMatchObject({
            previewKind: "download-only",
            sizeBytes: workspaceFileLimits.maximumTextPreviewBytes + 1,
            writeMaximumSizeBytes: workspaceFileLimits.maximumManifestFileBytes,
        });
    });

    test("keeps the exact manifest ceiling whole and bounds larger exact sources to a prefix", async () => {
        const { reader, root } = openClawFixture();
        const transformPath = Path.join(root, "hooks", "transforms", "agentmail.ts");
        const locator = {
            rootId: "openclaw-config",
            segments: ["hooks", "transforms", "agentmail.ts"],
        } as const;
        Fs.writeFileSync(
            transformPath,
            Buffer.alloc(workspaceFileLimits.maximumManifestFileBytes, 0x61)
        );
        Fs.chmodSync(transformPath, 0o664);

        expect(await reader.describe(locator)).toMatchObject({
            previewKind: "download-only",
            sizeBytes: workspaceFileLimits.maximumManifestFileBytes,
            writeMaximumSizeBytes: workspaceFileLimits.maximumManifestFileBytes,
            writable: true,
        });

        Fs.appendFileSync(transformPath, "a");
        const sourceSizeBytes = workspaceFileLimits.maximumManifestFileBytes + 1;
        const listing = await reader.list({
            rootId: "openclaw-config",
            segments: ["hooks", "transforms"],
        });
        expect(listing.entries.find(({ name }) => name === "agentmail.ts")).toMatchObject(
            {
                previewKind: "download-only",
                sizeBytes: sourceSizeBytes,
                truncated: true,
                writable: false,
            }
        );

        const described = await reader.describe(locator);
        expect(described).toMatchObject({
            previewKind: "text",
            sizeBytes: workspaceFileLimits.maximumTextPreviewBytes,
            sourceSizeBytes,
            truncated: true,
            writable: false,
        });
        const result = await reader.read(locator, described.revision, undefined);
        expect(result).toMatchObject({
            previewKind: "text",
            sizeBytes: workspaceFileLimits.maximumTextPreviewBytes,
            sourceSizeBytes,
            truncated: true,
        });
        expect(result.bytes).toHaveLength(workspaceFileLimits.maximumTextPreviewBytes);
        expect(result.bytes.every((byte) => byte === 0x61)).toBe(true);
        expect(
            reason(
                await reader
                    .read(locator, described.revision, {
                        endExclusive: workspaceFileLimits.maximumTextPreviewBytes + 1,
                        start: workspaceFileLimits.maximumTextPreviewBytes,
                    })
                    .catch((error: unknown) => error)
            )
        ).toBe("invalid-input");
    });

    test("bounds oversized manifest prefixes by the entry ceiling", async () => {
        const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-manifest-prefix-"));
        temporaryDirectories.push(root);
        Fs.chmodSync(root, 0o700);
        const fileName = "limited.json";
        const maximumSizeBytes = 512 * 1024;
        const sourceSizeBytes = 600 * 1024;
        Fs.writeFileSync(Path.join(root, fileName), "a".repeat(sourceSizeBytes));
        Fs.chmodSync(Path.join(root, fileName), 0o600);
        const reader = createDescriptorWorkspaceFileReader({
            roots: [
                {
                    id: "limited-manifest",
                    label: "Limited manifest",
                    manifest: [
                        {
                            contentPolicy: "redacted-config-json",
                            maximumSizeBytes,
                            segments: [fileName],
                            uploadContentPolicy: "reject-redaction-sentinel",
                            writable: true,
                        },
                    ],
                    path: root,
                    writable: false,
                },
            ],
        });
        readers.push(reader);
        const locator = {
            rootId: "limited-manifest",
            segments: [fileName],
        } as const;

        expect(
            reason(await reader.describe(locator).catch((error: unknown) => error))
        ).toBe("too-large");
        const described = await reader.describe(locator, undefined, "reveal-secrets");
        expect(described).toMatchObject({
            requiresSecretReveal: true,
            sizeBytes: maximumSizeBytes,
            sourceSizeBytes,
            truncated: true,
            writable: false,
        });
        expect(described.sourceSizeBytes).toBeGreaterThan(described.sizeBytes!);
        const result = await reader.read(
            locator,
            described.revision,
            undefined,
            undefined,
            "reveal-secrets"
        );
        expect(result).toMatchObject({
            sizeBytes: maximumSizeBytes,
            sourceSizeBytes,
            truncated: true,
        });
        expect(result.sourceSizeBytes).toBeGreaterThan(result.sizeBytes);
        expect(result.bytes).toHaveLength(maximumSizeBytes);
        expect(result.bytes.every((byte) => byte === 0x61)).toBe(true);
    });

    test("keeps oversized masked config closed until reveal and then exposes only its prefix", async () => {
        const { reader, root } = openClawFixture();
        const configPath = Path.join(root, "openclaw.json");
        const sourceSizeBytes = workspaceFileLimits.maximumManifestFileBytes + 1;
        const secret = "raw-prefix-secret";
        Fs.writeFileSync(
            configPath,
            `${secret}${"a".repeat(sourceSizeBytes - secret.length)}`
        );
        Fs.chmodSync(configPath, 0o600);
        const locator = {
            rootId: "openclaw-config",
            segments: ["openclaw.json"],
        } as const;

        const listing = await reader.list({
            rootId: "openclaw-config",
            segments: [],
        });
        expect(
            listing.entries.find(({ name }) => name === "openclaw.json")
        ).toMatchObject({
            requiresSecretReveal: true,
            sizeBytes: sourceSizeBytes,
            truncated: true,
            writable: false,
        });
        expect(
            reason(await reader.describe(locator).catch((error: unknown) => error))
        ).toBe("too-large");

        const revealed = await reader.describe(locator, undefined, "reveal-secrets");
        expect(revealed).toMatchObject({
            previewKind: "text",
            sizeBytes: workspaceFileLimits.maximumTextPreviewBytes,
            sourceSizeBytes,
            truncated: true,
            writable: false,
        });
        const result = await reader.read(
            locator,
            revealed.revision,
            undefined,
            undefined,
            "reveal-secrets"
        );
        expect(new TextDecoder().decode(result.bytes)).toStartWith(secret);
        expect(result).toMatchObject({
            sizeBytes: workspaceFileLimits.maximumTextPreviewBytes,
            sourceSizeBytes,
            truncated: true,
        });
    });

    test("does not apply the generic download ceiling to an exact manifest source", async () => {
        const { reader, root } = openClawFixture();
        const transformPath = Path.join(root, "hooks", "transforms", "agentmail.ts");
        const sourceSizeBytes = workspaceFileLimits.maximumDownloadBytes + 1;
        Fs.writeFileSync(transformPath, "prefix");
        Fs.truncateSync(transformPath, sourceSizeBytes);
        Fs.chmodSync(transformPath, 0o664);
        const locator = {
            rootId: "openclaw-config",
            segments: ["hooks", "transforms", "agentmail.ts"],
        } as const;

        const listing = await reader.list({
            rootId: "openclaw-config",
            segments: ["hooks", "transforms"],
        });
        expect(listing.entries[0]).toMatchObject({
            sizeBytes: sourceSizeBytes,
            truncated: true,
            writable: false,
        });
        const described = await reader.describe(locator);
        expect(described).toMatchObject({
            previewKind: "download-only",
            sizeBytes: workspaceFileLimits.maximumTextPreviewBytes,
            sourceSizeBytes,
            truncated: true,
            writable: false,
        });
        const result = await reader.read(locator, described.revision, {
            endExclusive: 6,
            start: 0,
        });
        expect(new TextDecoder().decode(result.bytes)).toBe("prefix");
        expect(result).toMatchObject({
            sizeBytes: workspaceFileLimits.maximumTextPreviewBytes,
            sourceSizeBytes,
            truncated: true,
        });
    });

    test("sniffs text, reads exact byte ranges, and rejects stale revisions", async () => {
        const { reader, root } = fixture();
        Fs.writeFileSync(Path.join(root, "notes.md"), "abcdef");
        const locator = { rootId: "workspace", segments: ["notes.md"] } as const;
        const described = await reader.describe(locator);
        expect(described).toMatchObject({
            mimeType: "text/markdown",
            previewKind: "text",
            sizeBytes: 6,
        });

        const selected = await reader.read(locator, described.revision, {
            endExclusive: 5,
            start: 2,
        });
        expect(new TextDecoder().decode(selected.bytes)).toBe("cde");

        Fs.writeFileSync(Path.join(root, "notes.md"), "changed");
        const caught = await reader
            .read(locator, described.revision, undefined)
            .catch((error: unknown) => error);
        expect(reason(caught)).toBe("conflict");
    });

    test("projects oversized UTF-8 and redacted text as download-only", async () => {
        const { reader, root } = fixture();
        const oversizedSize = workspaceFileLimits.maximumTextPreviewBytes + 1;
        const oversized = "a".repeat(oversizedSize);
        Fs.writeFileSync(Path.join(root, "oversized.txt"), oversized);
        const locator = {
            rootId: "workspace",
            segments: ["oversized.txt"],
        } as const;
        const described = await reader.describe(locator);
        expect(described).toMatchObject({
            mimeType: "text/plain",
            previewKind: "download-only",
            sizeBytes: oversizedSize,
        });
        const listing = await reader.list({ rootId: "workspace", segments: [] });
        expect(
            listing.entries.find(({ name }) => name === "oversized.txt")
        ).toMatchObject({
            previewKind: "download-only",
            sizeBytes: oversizedSize,
        });
        const result = await reader.read(locator, described.revision, undefined);
        expect(result).toMatchObject({
            previewKind: "download-only",
            sizeBytes: oversizedSize,
        });

        const openClaw = openClawFixture();
        const secrets = Object.fromEntries(
            Array.from({ length: 60_000 }, (_, index) => [`token${index}`, ""])
        );
        const raw = JSON.stringify(secrets);
        expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(
            workspaceFileLimits.maximumTextPreviewBytes
        );
        const configPath = Path.join(openClaw.root, "openclaw.json");
        Fs.writeFileSync(configPath, raw);
        Fs.chmodSync(configPath, 0o600);
        const configLocator = {
            rootId: "openclaw-config",
            segments: ["openclaw.json"],
        } as const;
        const redacted = await openClaw.reader.describe(configLocator);
        expect(redacted.previewKind).toBe("download-only");
        if (redacted.sizeBytes === undefined) {
            throw new TypeError("Expected redacted file size");
        }
        expect(redacted.sizeBytes).toBeGreaterThan(
            workspaceFileLimits.maximumTextPreviewBytes
        );
        const redactedResult = await openClaw.reader.read(
            configLocator,
            redacted.revision,
            undefined
        );
        expect(redactedResult.previewKind).toBe("download-only");
        expect(redactedResult.sizeBytes).toBe(redacted.sizeBytes);
    });

    test("does not follow a selected file after it is replaced by a symlink", async () => {
        const { reader, root } = fixture();
        const target = Path.join(root, "selected.txt");
        Fs.writeFileSync(target, "selected");
        const locator = { rootId: "workspace", segments: ["selected.txt"] } as const;
        const described = await reader.describe(locator);
        Fs.unlinkSync(target);
        Fs.symlinkSync("/etc/passwd", target);

        const caught = await reader
            .read(locator, described.revision, undefined)
            .catch((error: unknown) => error);
        expect(reason(caught)).toBe("access-denied");
    });

    test("reads a zero-byte file without inventing an invalid byte range", async () => {
        const { reader, root } = fixture();
        Fs.writeFileSync(Path.join(root, "empty.txt"), "");
        const locator = { rootId: "workspace", segments: ["empty.txt"] } as const;
        const described = await reader.describe(locator);
        const result = await reader.read(locator, described.revision, undefined);
        expect(result.sizeBytes).toBe(0);
        expect(result.bytes).toHaveLength(0);
    });

    test("rejects symbolic and filesystem-root configurations", () => {
        const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-files-root-"));
        const alias = `${root}-alias`;
        temporaryDirectories.push(root, alias);
        Fs.symlinkSync(root, alias);
        expect(() =>
            createDescriptorWorkspaceFileReader({
                roots: [
                    { id: "workspace", label: "Workspace", path: alias, writable: false },
                ],
            })
        ).toThrow("canonical");
        expect(() =>
            createDescriptorWorkspaceFileReader({
                roots: [
                    {
                        id: "workspace",
                        label: "Workspace",
                        path: Path.parse(root).root,
                        writable: false,
                    },
                ],
            })
        ).toThrow("filesystem root");
        Fs.chmodSync(root, 0o770);
        expect(() =>
            createDescriptorWorkspaceFileReader({
                roots: [
                    {
                        id: "workspace",
                        label: "Workspace",
                        path: root,
                        writable: true,
                    },
                ],
            })
        ).toThrow("owner or mode");
        Fs.chmodSync(root, 0o700);
        expect(() =>
            createDescriptorWorkspaceFileReader({
                roots: [
                    {
                        id: "../workspace",
                        label: "Workspace",
                        path: root,
                        writable: true,
                    },
                ],
            })
        ).toThrow("metadata");
    });
});
