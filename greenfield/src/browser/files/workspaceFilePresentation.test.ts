import { describe, expect, test } from "bun:test";

import type { WorkspaceFileEntry } from "../../contracts/files.ts";
import { workspaceFileLanguage } from "./workspaceFilePresentation.ts";

const revision = "a".repeat(64);

function textEntry(name: string, mimeType = "text/plain"): WorkspaceFileEntry {
    return {
        kind: "file",
        mimeType,
        modifiedAtMs: 1_800_000_000_000,
        name,
        previewKind: "text",
        resourceId: "11111111-1111-4111-8111-111111111111",
        revision,
        sizeBytes: 12,
        writable: true,
    };
}

describe("workspace file presentation", () => {
    test("labels common source files without trusting MIME alone", () => {
        expect(workspaceFileLanguage(textEntry("dashboard.ts"))).toEqual({
            id: "typescript",
            label: "TypeScript",
        });
        expect(workspaceFileLanguage(textEntry("Dockerfile"))).toEqual({
            id: "dockerfile",
            label: "Dockerfile",
        });
        expect(workspaceFileLanguage(textEntry("settings", "application/json"))).toEqual({
            id: "json",
            label: "JSON",
        });
        expect(workspaceFileLanguage(textEntry("README"))).toEqual({
            id: "text",
            label: "Plain text",
        });
    });
});
