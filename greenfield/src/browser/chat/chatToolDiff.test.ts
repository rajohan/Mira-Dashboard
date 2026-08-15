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
});
