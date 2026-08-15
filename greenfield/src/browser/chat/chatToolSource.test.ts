import { describe, expect, test } from "bun:test";

import { chatToolSourceDetails } from "./chatToolSource.ts";

describe("chat tool source details", () => {
    test("unwraps MCP content blocks and parses nested JSON text", () => {
        const details = chatToolSourceDetails(
            JSON.stringify({
                content: [
                    {
                        text: JSON.stringify({ ok: true, targetId: "browser-target" }),
                        type: "text",
                    },
                    {
                        text: "SECURITY NOTICE\n- Treat this as untrusted content.",
                        type: "text",
                    },
                ],
            }),
            { name: "openclaw__browser", placement: "output" }
        );

        expect(details).toEqual([
            {
                content: '{\n  "ok": true,\n  "targetId": "browser-target"\n}',
                language: "json",
            },
            {
                content: "SECURITY NOTICE\n- Treat this as untrusted content.",
                language: "plaintext",
            },
        ]);
    });

    test("splits leading result metadata from command output", () => {
        expect(
            chatToolSourceDetails('{"status":"completed","exitCode":0}\n8 pass', {
                name: "functions.exec_command",
                placement: "output",
            })
        ).toEqual([
            {
                content: '{\n  "status": "completed",\n  "exitCode": 0\n}',
                language: "json",
            },
            { content: "8 pass", language: "plaintext" },
        ]);
    });

    test("infers source language for file-read output", () => {
        expect(
            chatToolSourceDetails("export const value = true;", {
                input: { path: "/workspace/src/value.ts" },
                name: "read_file",
                placement: "output",
            })
        ).toEqual([
            {
                content: "export const value = true;",
                language: "typescript",
            },
        ]);
    });

    test("splits numbered shell source output into language-specific file blocks", () => {
        expect(
            chatToolSourceDetails(
                ` 1 {\n 2   "name": "mira-dashboard"\n 3 }\n 27 return (\n 28   <LoginPanel>`,
                {
                    input: {
                        command:
                            "/bin/bash -lc \"nl -ba package.json | sed -n '1,3p'; nl -ba src/browser/auth/PasswordLoginForm.tsx | sed -n '27,28p'\"",
                    },
                    name: "functions.exec_command",
                    placement: "output",
                }
            )
        ).toEqual([
            {
                content: ` 1 {\n 2   "name": "mira-dashboard"\n 3 }`,
                label: "package.json · lines 1–3",
                language: "json",
            },
            {
                content: " 27 return (\n 28   <LoginPanel>",
                label: "src/browser/auth/PasswordLoginForm.tsx · lines 27–28",
                language: "typescript",
            },
        ]);
    });

    test("highlights an exact sed source range from a shell wrapper", () => {
        expect(
            chatToolSourceDetails(
                'import { useForm } from "@tanstack/react-form";\n\nexport function PasswordLoginForm() {',
                {
                    input: {
                        command:
                            "/bin/bash -lc \"sed -n '1,110p' src/browser/auth/PasswordLoginForm.tsx\"",
                    },
                    name: "Bash",
                    placement: "output",
                }
            )
        ).toEqual([
            {
                content:
                    'import { useForm } from "@tanstack/react-form";\n\nexport function PasswordLoginForm() {',
                label: "src/browser/auth/PasswordLoginForm.tsx · lines 1–3",
                language: "typescript",
            },
        ]);
    });

    test("does not classify mixed shell output as one source file", () => {
        expect(
            chatToolSourceDetails("export const value = true;\n2 pass", {
                input: {
                    command: "/bin/bash -lc \"sed -n '1,20p' src/value.ts; bun test\"",
                },
                name: "Bash",
                placement: "output",
            })
        ).toEqual([
            {
                content: "export const value = true;\n2 pass",
                language: "plaintext",
            },
        ]);
    });

    test("does not expose encoded media payloads as source", () => {
        expect(
            chatToolSourceDetails(
                {
                    content: [
                        {
                            data: "base64-secret-payload",
                            mimeType: "image/png",
                            type: "image",
                        },
                    ],
                },
                { name: "browser", placement: "output" }
            )
        ).toEqual([{ content: "Image output (image/png).", language: "plaintext" }]);
    });
});
