import { describe, expect, jest, test } from "bun:test";

import { workspaceFileLimits, type WorkspaceFileEntry } from "../../contracts/files.ts";
import { WorkspaceFileEditorPane } from "./WorkspaceFileEditorPane.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const revision = "a".repeat(64);

function entry(name: string, mimeType: string, sizeBytes: number): WorkspaceFileEntry {
    return {
        kind: "file",
        mimeType,
        modifiedAtMs: 1_800_000_000_000,
        name,
        previewKind: "text",
        resourceId: "11111111-1111-4111-8111-111111111111",
        revision,
        sizeBytes,
        writable: true,
    };
}

function renderEditor(
    selectedEntry: WorkspaceFileEntry,
    content: string,
    options: {
        readonly onRevealSecrets?: () => Promise<void>;
        readonly secretsRevealed?: boolean;
    } = {}
) {
    return render(
        <WorkspaceFileEditorPane
            downloading={false}
            onDownload={jest.fn(() => Promise.resolve())}
            onRefreshPreview={jest.fn(() => Promise.resolve())}
            onReplace={jest.fn()}
            onRevealSecrets={options.onRevealSecrets ?? jest.fn(() => Promise.resolve())}
            onSaveText={jest.fn(() =>
                Promise.resolve({
                    jobRunId: "file-write-job",
                    status: "accepted" as const,
                    ticketId: "22222222-2222-4222-8222-222222222222",
                })
            )}
            onWriteComplete={jest.fn()}
            preview={{
                loading: false,
                prepared: {
                    content,
                    ...(options.secretsRevealed
                        ? {
                              revealTicketId: "55555555-5555-4555-8555-555555555555",
                              secretsRevealed: true as const,
                          }
                        : {}),
                    ticket: {
                        disposition: "preview",
                        expiresAtMs: 1_900_000_000_000,
                        fileName: selectedEntry.name,
                        mimeType: selectedEntry.mimeType!,
                        previewKind: "text",
                        revision,
                        sizeBytes:
                            selectedEntry.truncated === true
                                ? workspaceFileLimits.maximumTextPreviewBytes
                                : selectedEntry.sizeBytes!,
                        ...(selectedEntry.truncated === true
                            ? {
                                  sourceSizeBytes: selectedEntry.sizeBytes!,
                                  truncated: true as const,
                              }
                            : {}),
                        ticketId: "33333333-3333-4333-8333-333333333333",
                        url: "/api/files/content/33333333-3333-4333-8333-333333333333",
                    },
                },
            }}
            selection={{
                entry: selectedEntry,
                parentDirectoryId: "44444444-4444-4444-8444-444444444444",
            }}
        />
    );
}

describe("WorkspaceFileEditorPane viewers", () => {
    test("requires explicit secret reveal before config editing or replacement", async () => {
        const onRevealSecrets = jest.fn(() => Promise.resolve());
        const selectedEntry = {
            ...entry("openclaw.json", "application/json", 18),
            requiresSecretReveal: true,
        };
        const user = userEvent.setup();
        const { rerender } = renderEditor(selectedEntry, '{"token":"masked"}', {
            onRevealSecrets,
        });

        expect(screen.getByText("Secrets masked")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Replace file" })).toBeNull();
        await user.click(screen.getByRole("button", { name: "Reveal secrets" }));
        expect(onRevealSecrets).toHaveBeenCalledTimes(1);

        rerender(
            <WorkspaceFileEditorPane
                downloading={false}
                onDownload={jest.fn(() => Promise.resolve())}
                onRefreshPreview={jest.fn(() => Promise.resolve())}
                onReplace={jest.fn()}
                onRevealSecrets={onRevealSecrets}
                onSaveText={jest.fn(() =>
                    Promise.resolve({
                        jobRunId: "file-write-job",
                        status: "accepted" as const,
                        ticketId: "22222222-2222-4222-8222-222222222222",
                    })
                )}
                onWriteComplete={jest.fn()}
                preview={{
                    loading: false,
                    prepared: {
                        content: '{"token":"secret"}',
                        revealTicketId: "55555555-5555-4555-8555-555555555555",
                        secretsRevealed: true,
                        ticket: {
                            disposition: "preview",
                            expiresAtMs: 1_900_000_000_000,
                            fileName: selectedEntry.name,
                            mimeType: selectedEntry.mimeType!,
                            previewKind: "text",
                            revision,
                            sizeBytes: selectedEntry.sizeBytes!,
                            ticketId: "55555555-5555-4555-8555-555555555555",
                            url: "/api/files/content/55555555-5555-4555-8555-555555555555",
                        },
                    },
                }}
                selection={{
                    entry: selectedEntry,
                    parentDirectoryId: "44444444-4444-4444-8444-444444444444",
                }}
            />
        );
        expect(screen.getByText("Secrets revealed")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Replace file" })).toBeTruthy();
    });

    test("renders an oversized-source prefix as explicitly read-only", () => {
        const selectedEntry: WorkspaceFileEntry = {
            ...entry(
                "agentmail.ts",
                "text/plain",
                workspaceFileLimits.maximumManifestFileBytes + 1
            ),
            previewKind: "download-only",
            truncated: true,
            writable: true,
        };
        renderEditor(selectedEntry, "export const prefix = true;\n");

        expect(screen.getByText("Prefix only")).toBeTruthy();
        expect(
            screen.getByText(/Only its bounded first 1 MiB prefix is available/u)
        ).toBeTruthy();
        expect(screen.getByRole("button", { name: "Download prefix" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Replace file" })).toBeNull();
    });

    test("keeps a long file name on one line with only refresh below the actions", () => {
        const selectedEntry = entry(
            "this-is-a-very-long-workspace-configuration-file-name-that-must-not-move-preview-actions.ts",
            "text/plain",
            24
        );
        renderEditor(selectedEntry, "export const ready = true;");

        const heading = screen.getByRole("heading", { name: selectedEntry.name });
        const refresh = screen.getByRole("button", {
            name: "Refresh preview",
        });
        const actionColumn = refresh.parentElement;
        const primaryActions = refresh.previousElementSibling;
        const header = heading.closest("header");

        expect(heading).toHaveClass("truncate");
        expect(header).toHaveClass("flex-col", "xl:flex-row");
        expect(actionColumn).toHaveClass("flex-col");
        expect(primaryActions).toContainElement(
            screen.getByRole("button", { name: "Raw" })
        );
        expect(actionColumn?.children).toHaveLength(2);
        expect(actionColumn?.lastElementChild).toBe(refresh);
    });

    test("shows code with its language, exact lines, and a copy action", () => {
        const content = "const answer = 42;\nconsole.log(answer);";
        const { container } = renderEditor(
            entry("dashboard.ts", "text/plain", content.length),
            content
        );

        expect(screen.getByText("TypeScript")).toBeTruthy();
        expect(screen.getByText("2 lines")).toBeTruthy();
        expect(
            screen
                .getByTestId("syntax-highlighted-source")
                .querySelectorAll(".source-viewer-line")
        ).toHaveLength(2);
        expect(screen.getByRole("switch", { name: "Wrap lines" })).toBeChecked();
        expect(screen.getByRole("button", { name: "Copy dashboard.ts" })).toBeTruthy();
        expect(
            container.querySelector("code[data-language='typescript']")?.textContent
        ).toBe(content);
    });

    test("shows formatted highlighted JSON and preserves an exact raw view", async () => {
        const content = '{"service":{"name":"Dashboard"},"enabled":true}';
        const selectedEntry = entry("settings.json", "application/json", content.length);
        const { container } = renderEditor(selectedEntry, content);
        const user = userEvent.setup();

        expect(screen.getByText("2 keys")).toBeTruthy();
        expect(screen.getByText('"Dashboard"')).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "Source" }));

        expect(container.querySelectorAll(".hljs-attr")).toHaveLength(3);
        expect(container.querySelector(".hljs-string")).toHaveTextContent('"Dashboard"');

        await user.click(screen.getByRole("button", { name: "Raw" }));

        expect(screen.getByRole("region", { name: "settings.json source" })).toBeTruthy();
        expect(container.querySelector("code[data-language='json']")?.textContent).toBe(
            content
        );
        expect(screen.getByRole("button", { name: "Copy settings.json" })).toBeTruthy();
    });
});
