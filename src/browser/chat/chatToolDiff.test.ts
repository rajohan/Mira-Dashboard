import { describe, expect, test } from "bun:test";

import { chatToolDiff } from "./chatToolDiff.ts";

describe("chat tool diff", () => {
    test("parses native apply-patch input into complete highlighted file changes", () => {
        const diff = chatToolDiff({
            input: {
                patch: `*** Begin Patch
*** Update File: src/example.ts
@@ -1,2 +1,2 @@
-const state = "old";
+const state = "new";
 export { state };
*** Add File: src/added.ts
+export const added = true;
*** End Patch`,
            },
            name: "functions.apply_patch",
        });

        expect(diff).toMatchObject({
            added: 2,
            files: ["src/example.ts", "src/added.ts"],
            removed: 1,
        });
        expect(diff?.lines).toContainEqual({
            kind: "delete",
            language: "typescript",
            lineNumber: 1,
            text: 'const state = "old";',
        });
        expect(diff?.lines).toContainEqual({
            kind: "add",
            language: "typescript",
            lineNumber: 1,
            text: 'const state = "new";',
        });
        expect(diff?.lines).toContainEqual({
            kind: "file",
            text: "Add src/added.ts",
        });
    });

    test("parses unified diffs and ignores unrelated tools", () => {
        const input = `diff --git a/src/old.ts b/src/old.ts
--- a/src/old.ts
+++ b/src/old.ts
@@ -4,2 +4,2 @@
-oldValue
+newValue
 context`;

        expect(chatToolDiff({ input, name: "bash" })).toBeUndefined();
        expect(chatToolDiff({ input: { diff: input }, name: "patch" })).toMatchObject({
            added: 1,
            files: ["src/old.ts"],
            removed: 1,
        });
    });

    test("parses structured apply-patch changes returned by Codex tools", () => {
        const diff = chatToolDiff({
            input: {
                changes: [
                    {
                        diff: `@@ -33,2 +33,3 @@
 <LoginPanel
+ description="Log in with your dashboard username and password"
 footer="Forgotten passwords are reset with the host-local recovery command."`,
                        kind: { move_path: null, type: "update" },
                        path: "/workspace/src/browser/auth/PasswordLoginForm.tsx",
                        stat: { added: 1, removed: 0 },
                    },
                ],
            },
            name: "functions.apply_patch",
        });

        expect(diff).toMatchObject({
            added: 1,
            files: ["/workspace/src/browser/auth/PasswordLoginForm.tsx"],
            removed: 0,
        });
        expect(diff?.lines).toContainEqual({
            kind: "add",
            language: "typescript",
            lineNumber: 34,
            text: ' description="Log in with your dashboard username and password"',
        });
        expect(diff?.lines).toContainEqual({
            kind: "file",
            text: "Update /workspace/src/browser/auth/PasswordLoginForm.tsx",
        });
    });

    test("keeps file changes beyond the Control UI preview limit", () => {
        const addedLines = Array.from(
            { length: 450 },
            (_, index) => `+export const value${index} = ${index};`
        ).join("\n");
        const diff = chatToolDiff({
            input: `*** Begin Patch
*** Add File: src/generated.ts
${addedLines}
*** End Patch`,
            name: "apply_patch",
        });

        expect(diff?.added).toBe(450);
        expect(diff?.lines.filter((line) => line.kind === "add")).toHaveLength(450);
        expect(diff?.lines.at(-1)?.kind).toBe("add");
    });

    test("parses structured add, delete, move, stats, and multiple hunks", () => {
        const diff = chatToolDiff({
            input: JSON.stringify({
                changes: [
                    null,
                    { diff: "ignored", kind: "update", path: "" },
                    {
                        diff: "+FROM oven/bun\n+RUN bun test",
                        kind: "add",
                        path: "Dockerfile",
                        stat: { added: 2, removed: 0 },
                    },
                    {
                        diff: "-enabled: true\n-enabled: false",
                        kind: { type: "delete" },
                        path: "config.yaml",
                        stat: { added: 0, removed: 2 },
                    },
                    {
                        diff: "@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n context",
                        kind: { movePath: "src/new.js", type: "update" },
                        path: "src/old.js",
                        stat: { added: -1, removed: 0 },
                    },
                ],
            }),
            name: "applypatch",
        });

        expect(diff).toMatchObject({
            added: 2,
            files: ["Dockerfile", "config.yaml", "src/new.js"],
            removed: 2,
        });
        expect(diff?.lines).toContainEqual({
            kind: "add",
            language: "dockerfile",
            lineNumber: 1,
            text: "FROM oven/bun",
        });
        expect(diff?.lines).toContainEqual({
            kind: "delete",
            language: "yaml",
            lineNumber: 2,
            text: "enabled: false",
        });
        expect(diff?.lines).toContainEqual({
            kind: "file",
            text: "Move src/old.js → src/new.js",
        });
        expect(diff?.lines.filter((line) => line.kind === "skip")).toHaveLength(1);
    });

    test("recognizes supported source languages and leaves unknown files plain", () => {
        const expected = [
            ["value.tsx", "typescript"],
            ["value.mjs", "javascript"],
            ["value.jsonc", "json"],
            ["value.zsh", "shell"],
            ["value.scss", "css"],
            ["value.htm", "html"],
            ["value.mdx", "markdown"],
            ["value.py", "python"],
            ["value.sql", "sql"],
            ["value.yml", "yaml"],
            ["value.svg", "xml"],
            ["value.unknown", undefined],
        ] as const;

        for (const [path, language] of expected) {
            const diff = chatToolDiff({
                input: {
                    changes: [{ diff: "+value", kind: "add", path }],
                },
                name: "patch",
            });
            expect(diff?.lines.find((line) => line.kind === "add")?.language).toBe(
                language
            );
        }
    });

    test("handles apply-patch moves, deletes, unnumbered hunks, and JSON wrappers", () => {
        const patch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@ not-a-numbered-hunk
-old
+new
 context
@@ -8 +8 @@
-later
+latest
*** Delete File: src/removed.css
-body {}
*** End of File
*** End Patch`;
        const diff = chatToolDiff({
            input: JSON.stringify({ input: patch }),
            name: "functions.patch",
        });

        expect(diff).toMatchObject({
            added: 2,
            files: ["src/new.ts", "src/removed.css"],
            removed: 3,
        });
        expect(diff?.lines).toContainEqual({
            kind: "file",
            text: "Move src/old.ts → src/new.ts",
        });
        expect(diff?.lines).toContainEqual({
            kind: "add",
            language: "typescript",
            text: "new",
        });
        expect(diff?.lines).toContainEqual({
            kind: "delete",
            language: "css",
            lineNumber: 1,
            text: "body {}",
        });
        expect(diff?.lines.filter((line) => line.kind === "skip")).toHaveLength(1);
    });

    test("parses header-only unified add and delete files with tab metadata", () => {
        const diff = chatToolDiff({
            input: `--- /dev/null
+++ b/index.html\t2026-08-15
@@ -0,0 +1,2 @@
+<main>
+</main>
--- a/retired.sql\t2026-08-14
+++ /dev/null
@@ -1 +0,0 @@
-DROP TABLE retired;`,
            name: "patch",
        });

        expect(diff).toMatchObject({
            added: 2,
            files: ["index.html", "retired.sql"],
            removed: 1,
        });
        expect(diff?.lines).toContainEqual({
            kind: "file",
            text: "Add index.html",
        });
        expect(diff?.lines).toContainEqual({
            kind: "file",
            text: "Delete retired.sql",
        });
    });

    test("extracts patch source through malformed and nested input wrappers", () => {
        const patch = `*** Begin Patch
*** Add File: src/wrapped.ts
+export const wrapped = true;
*** End Patch`;

        expect(
            chatToolDiff({
                input: `{not-json\n${patch}`,
                name: " apply_patch ",
            })
        ).toMatchObject({ added: 1, files: ["src/wrapped.ts"], removed: 0 });
        expect(
            chatToolDiff({
                input: JSON.stringify({ diff: patch }),
                name: "functions.applypatch",
            })
        ).toMatchObject({ added: 1, files: ["src/wrapped.ts"], removed: 0 });
        expect(
            chatToolDiff({
                input: { diff: patch, input: " ", patch: 7 },
                name: "patch",
            })
        ).toMatchObject({ added: 1, files: ["src/wrapped.ts"], removed: 0 });

        for (const input of [[], "[1,2]", { diff: 7, input: null, patch: [] }]) {
            expect(chatToolDiff({ input, name: "patch" })).toBeUndefined();
        }
    });

    test("deduplicates unified files and skip markers across adjacent hunks", () => {
        const diff = chatToolDiff({
            input: `diff --git a/src/value.ts b/src/value.ts
diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ unnumbered
+first
@@ unnumbered
@@ -8 +8 @@
-old
+new
 plain`,
            name: "patch",
        });

        expect(diff).toMatchObject({
            added: 2,
            files: ["src/value.ts"],
            removed: 1,
        });
        expect(diff?.lines.filter((line) => line.kind === "file")).toHaveLength(2);
        expect(diff?.lines.filter((line) => line.kind === "skip")).toHaveLength(1);
        expect(diff?.lines).toContainEqual({
            kind: "context",
            language: "typescript",
            lineNumber: 9,
            text: "plain",
        });

        expect(
            chatToolDiff({ input: "diff --git a/  b/ ", name: "patch" })
        ).toBeUndefined();
    });

    test("ignores incomplete structured changes and invalid apply-patch directives", () => {
        const structured = chatToolDiff({
            input: {
                changes: [
                    [],
                    { diff: "+missing path" },
                    { diff: 7, path: "src/non-string.ts" },
                    {
                        diff: "not a diff line\n\n+added\n-removed\n context",
                        kind: null,
                        path: "src/value.ts",
                        stat: { added: Number.MAX_SAFE_INTEGER + 1, removed: -1 },
                    },
                    {
                        diff: "without-prefix",
                        kind: "add",
                        path: "src/value.ts",
                    },
                ],
            },
            name: "patch",
        });

        expect(structured).toMatchObject({
            added: 2,
            files: ["src/value.ts"],
            removed: 1,
        });
        expect(structured?.lines).toContainEqual({
            kind: "add",
            language: "typescript",
            lineNumber: 1,
            text: "without-prefix",
        });

        const moved = chatToolDiff({
            input: `before the patch
*** Begin Patch
*** Update File: src/value.ts
*** Move to: ${" ".repeat(3)}
ignored directive
@@ malformed
+value
*** End of File
*** End Patch`,
            name: "patch",
        });
        expect(moved).toMatchObject({ added: 1, files: ["src/value.ts"], removed: 0 });
    });

    test("fails closed for empty, malformed, and unrelated patch payloads", () => {
        for (const input of [
            undefined,
            null,
            42,
            {},
            { patch: "  " },
            { changes: [] },
            { changes: [{ diff: 7, path: "file.ts" }] },
            "[]",
            "{not-json",
            "ordinary output",
            "*** Begin Patch\n*** End Patch",
        ]) {
            expect(chatToolDiff({ input, name: "apply_patch" })).toBeUndefined();
        }
        expect(
            chatToolDiff({ input: "*** Add File: \n+value", name: "apply_patch" })
        ).toBeUndefined();
    });
});
