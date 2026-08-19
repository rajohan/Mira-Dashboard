/* eslint-disable jsx-a11y/media-has-caption -- Workspace audio has no authored caption track. */
import JSON5 from "json5";
import { Download, Eye, FilePenLine, RefreshCw, Save, Upload } from "lucide-react";
import { useState } from "react";

import type {
    WorkspaceFileEntry,
    WorkspaceFileWriteStatus,
} from "../../contracts/files.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { formatByteCount } from "../lib/formatMeasurements.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { CopyTextButton } from "../ui/CopyTextButton.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Form } from "../ui/Form.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { JsonViewer } from "../ui/JsonViewer.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { SourceViewer } from "../ui/SourceViewer.tsx";
import { Text } from "../ui/Text.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import {
    workspaceFileFailureMessage,
    workspaceFileKindLabel,
    workspaceFileLanguage,
} from "./workspaceFilePresentation.ts";
import type { WorkspaceFilePreparedPreview } from "./workspaceFileTransfers.ts";

export interface WorkspaceFilePaneSelection {
    readonly entry: WorkspaceFileEntry;
    readonly parentDirectoryId: string;
}

export interface WorkspaceFilePanePreview {
    readonly error?: string;
    readonly loading: boolean;
    readonly prepared?: WorkspaceFilePreparedPreview;
    readonly revealError?: string;
    readonly revealLoading?: boolean;
}

interface WorkspaceFileEditorPaneProps {
    readonly downloading: boolean;
    readonly onDownload: () => Promise<void>;
    readonly onRefreshPreview: () => Promise<void>;
    readonly onReplace: () => void;
    readonly onRevealSecrets: () => Promise<void>;
    readonly onSaveText: (content: string) => Promise<WorkspaceFileWriteStatus>;
    readonly onWriteComplete: (status: WorkspaceFileWriteStatus) => void;
    readonly preview: WorkspaceFilePanePreview;
    readonly selection: WorkspaceFilePaneSelection;
}

type TextMode = "edit" | "raw" | "rendered";

const paneAlertClassName = "rounded-none border-x-0 border-t-0";

function renderableKind(
    entry: WorkspaceFileEntry
): "json" | "json5" | "markdown" | undefined {
    const name = entry.name.toLowerCase();
    if (name.endsWith(".json5") || entry.mimeType === "application/json5") {
        return "json5";
    }
    if (entry.mimeType === "application/json" || name.endsWith(".json")) return "json";
    if (
        entry.mimeType === "text/markdown" ||
        name.endsWith(".md") ||
        name.endsWith(".markdown")
    ) {
        return "markdown";
    }
    return undefined;
}

function jsonPresentation(
    content: string,
    format: "json" | "json5"
): { readonly valid: true } | { readonly error: string; readonly valid: false } {
    try {
        if (format === "json5") JSON5.parse(content);
        else JSON.parse(content);
        return { valid: true };
    } catch {
        return {
            error: "Enter valid JSON before saving this file.",
            valid: false,
        };
    }
}

function TextPresentation({
    content,
    entry,
}: Readonly<{ content: string; entry: WorkspaceFileEntry }>) {
    const kind = renderableKind(entry);
    const language = workspaceFileLanguage(entry);
    if (kind === "markdown") {
        return (
            <div className="flex min-h-full min-w-0 flex-col">
                <div className="border-primary-700 bg-primary-900/80 flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                    <Badge variant="info">Markdown</Badge>
                    <CopyTextButton label={`Copy ${entry.name}`} text={content} />
                </div>
                <Markdown
                    className="p-5"
                    components={{
                        a: ({ children }) => <span>{children}</span>,
                        img: ({ alt }) => (
                            <span className="text-primary-400">
                                [Image omitted: {alt}]
                            </span>
                        ),
                    }}
                    source={content}
                    urlTransform={() => ""}
                />
            </div>
        );
    }
    if (kind === "json" || kind === "json5") {
        return (
            <JsonViewer
                ariaLabel={`${entry.name} JSON preview`}
                content={content}
                copyLabel={`Copy ${entry.name}`}
                format={kind}
            />
        );
    }
    return (
        <SourceViewer
            ariaLabel={`${entry.name} source`}
            content={content}
            copyLabel={`Copy ${entry.name}`}
            language={language.id}
            languageLabel={language.label}
        />
    );
}

function MediaPresentation({
    entry,
    prepared,
}: Readonly<{ entry: WorkspaceFileEntry; prepared: WorkspaceFilePreparedPreview }>) {
    switch (prepared.ticket.previewKind) {
        case "audio": {
            return (
                <div className="flex h-full items-center p-6">
                    <audio
                        aria-label={`Audio preview of ${entry.name}`}
                        className="w-full"
                        controls
                        src={prepared.ticket.url}
                    />
                </div>
            );
        }
        case "image": {
            return (
                <div className="flex h-full items-center justify-center p-4">
                    <img
                        alt={`Preview of ${entry.name}`}
                        className="max-h-full max-w-full rounded-lg object-contain"
                        src={prepared.ticket.url}
                    />
                </div>
            );
        }
        case "pdf": {
            return (
                <iframe
                    className="size-full min-h-128 bg-white"
                    src={prepared.ticket.url}
                    title={`PDF preview of ${entry.name}`}
                />
            );
        }
        case "download-only": {
            return (
                <EmptyState
                    description="The Dashboard cannot preview this file type. Download it to open it."
                    headingLevel={3}
                    icon={Download}
                    surface="plain"
                    title="Download to inspect"
                />
            );
        }
        case "text": {
            return null;
        }
    }
}

/**
 * Persistent metadata, preview, and CAS-backed text editor for one selected file.
 * @returns Full-height selected-file viewer and editor pane.
 */
export function WorkspaceFileEditorPane({
    downloading,
    onDownload,
    onRefreshPreview,
    onReplace,
    onRevealSecrets,
    onSaveText,
    onWriteComplete,
    preview,
    selection,
}: WorkspaceFileEditorPaneProps) {
    const { entry } = selection;
    const initialContent = preview.prepared?.content ?? "";
    const prefixOnly =
        entry.truncated === true || preview.prepared?.ticket.truncated === true;
    const renderable = !prefixOnly && renderableKind(entry) !== undefined;
    const language = workspaceFileLanguage(entry);
    const [baseline, setBaseline] = useState(initialContent);
    const [draft, setDraft] = useState(initialContent);
    const [mode, setMode] = useState<TextMode>(renderable ? "rendered" : "raw");
    const [saveError, setSaveError] = useState<string>();
    const [saving, setSaving] = useState(false);
    const renderableType = prefixOnly ? undefined : renderableKind(entry);
    const json =
        renderableType === "json" || renderableType === "json5"
            ? jsonPresentation(draft, renderableType)
            : undefined;
    const changed = draft !== baseline;
    const canEdit =
        entry.kind === "file" &&
        !prefixOnly &&
        entry.previewKind === "text" &&
        entry.writable &&
        (entry.requiresSecretReveal !== true ||
            preview.prepared?.secretsRevealed === true) &&
        preview.prepared?.content !== undefined;
    const canReplace =
        !prefixOnly &&
        entry.writable &&
        (entry.requiresSecretReveal !== true ||
            preview.prepared?.secretsRevealed === true);
    const showSecretNotice =
        entry.requiresSecretReveal === true && preview.prepared?.secretsRevealed !== true;

    async function save() {
        if (!canEdit || !changed || json?.valid === false || saving) return;
        setSaveError(undefined);
        setSaving(true);
        try {
            const status = await onSaveText(draft);
            setBaseline(draft);
            setMode(renderable ? "rendered" : "raw");
            onWriteComplete(status);
        } catch (error) {
            setSaveError(workspaceFileFailureMessage(error));
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="flex min-h-128 min-w-0 flex-1 flex-col lg:min-h-0">
            <header className="border-primary-700 flex flex-col gap-3 border-b p-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0 xl:flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                        <Icon icon={FilePenLine} size="sm" tone="accent" />
                        <h2 className="text-primary-50 min-w-0 truncate font-semibold">
                            {entry.name}
                        </h2>
                        {changed && <Badge variant="warning">Unsaved</Badge>}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                        <Badge>{workspaceFileKindLabel(entry)}</Badge>
                        {entry.sizeBytes !== undefined && (
                            <Badge>{formatByteCount(entry.sizeBytes)}</Badge>
                        )}
                        {prefixOnly && <Badge variant="warning">Prefix only</Badge>}
                        <Badge variant={entry.writable ? "success" : "default"}>
                            {entry.writable ? "Writable" : "Read only"}
                        </Badge>
                        {entry.requiresSecretReveal === true && (
                            <Badge
                                variant={
                                    preview.prepared?.secretsRevealed === true
                                        ? "warning"
                                        : "default"
                                }
                            >
                                {preview.prepared?.secretsRevealed === true
                                    ? "Secrets revealed"
                                    : "Secrets masked"}
                            </Badge>
                        )}
                        {entry.mimeType !== undefined && <Badge>{entry.mimeType}</Badge>}
                    </div>
                    {entry.modifiedAtMs !== undefined && (
                        <Text className="mt-2" size="sm" tone="muted">
                            Modified {formatDashboardDateTime(entry.modifiedAtMs)}
                        </Text>
                    )}
                </div>
                <div className="flex shrink-0 flex-col items-start gap-2 xl:items-end">
                    <div className="flex flex-wrap gap-2 xl:flex-nowrap xl:justify-end">
                        {preview.prepared?.ticket.previewKind === "text" && (
                            <>
                                {renderable && (
                                    <Button
                                        aria-pressed={mode === "rendered"}
                                        onClick={() => setMode("rendered")}
                                        size="sm"
                                        variant={
                                            mode === "rendered" ? "primary" : "secondary"
                                        }
                                    >
                                        <Icon icon={Eye} size="sm" tone="inherit" />
                                        Preview
                                    </Button>
                                )}
                                <Button
                                    aria-pressed={mode === "raw"}
                                    onClick={() => setMode("raw")}
                                    size="sm"
                                    variant={mode === "raw" ? "primary" : "secondary"}
                                >
                                    Raw
                                </Button>
                                {canEdit && (
                                    <Button
                                        aria-pressed={mode === "edit"}
                                        onClick={() => setMode("edit")}
                                        size="sm"
                                        variant={
                                            mode === "edit" ? "primary" : "secondary"
                                        }
                                    >
                                        <Icon
                                            icon={FilePenLine}
                                            size="sm"
                                            tone="inherit"
                                        />
                                        Edit
                                    </Button>
                                )}
                            </>
                        )}
                        {entry.requiresSecretReveal === true &&
                            preview.prepared?.secretsRevealed !== true && (
                                <Button
                                    busy={preview.revealLoading === true}
                                    busyLabel="Revealing secrets…"
                                    onClick={() => void onRevealSecrets()}
                                    size="sm"
                                    variant="secondary"
                                >
                                    <Icon icon={Eye} size="sm" tone="inherit" />
                                    Reveal secrets
                                </Button>
                            )}
                        {!(prefixOnly && entry.requiresSecretReveal === true) && (
                            <Button
                                busy={downloading}
                                busyLabel="Preparing download…"
                                onClick={() => void onDownload()}
                                size="sm"
                                variant="secondary"
                            >
                                <Icon icon={Download} size="sm" tone="inherit" />
                                {prefixOnly ? "Download prefix" : "Download"}
                            </Button>
                        )}
                        {canReplace && (
                            <Button onClick={onReplace} size="sm" variant="secondary">
                                <Icon icon={Upload} size="sm" tone="inherit" />
                                Replace file
                            </Button>
                        )}
                    </div>
                    <Button
                        busy={preview.loading}
                        busyLabel="Refreshing preview…"
                        onClick={() => void onRefreshPreview()}
                        size="sm"
                        variant="ghost"
                    >
                        <Icon icon={RefreshCw} size="sm" tone="inherit" />
                        Refresh preview
                    </Button>
                </div>
            </header>

            {showSecretNotice && (
                <Alert
                    className={paneAlertClassName}
                    focusOnError={false}
                    message="If needed, enroll and confirm MFA in Account security before revealing. Reveal exposes raw secrets only in this pane. Inspect and repair invalid JSON without copying secrets into logs or messages."
                    variant="info"
                />
            )}
            {prefixOnly && (
                <Alert
                    className={paneAlertClassName}
                    focusOnError={false}
                    message="This source exceeds the reviewed full-file limit. Only its bounded first 1 MiB prefix is available here, and replacement is disabled."
                    variant="info"
                />
            )}
            <Alert className={paneAlertClassName} message={preview.error} />
            <Alert className={paneAlertClassName} message={preview.revealError} />
            <Alert
                className={paneAlertClassName}
                message={saveError}
                onDismiss={() => setSaveError(undefined)}
            />
            <div className="bg-primary-950/70 min-h-0 flex-1 overflow-auto">
                {preview.loading && (
                    <div className="flex h-full min-h-80 items-center justify-center">
                        <Text aria-live="polite" tone="muted">
                            Preparing preview…
                        </Text>
                    </div>
                )}
                {!preview.loading && preview.prepared !== undefined && (
                    <>
                        {preview.prepared.ticket.previewKind === "text" &&
                            mode === "edit" && (
                                <Form
                                    className="flex h-full min-h-0 flex-col p-4"
                                    onSubmit={save}
                                >
                                    <FormField
                                        className="flex min-h-0 flex-1 flex-col"
                                        description="Saving replaces the version you opened. If the file changed first, you will be asked to refresh."
                                        error={
                                            json?.valid === false ? json.error : undefined
                                        }
                                        label="File contents"
                                    >
                                        <Textarea
                                            className="mt-2 min-h-0! flex-1 resize-none font-mono text-sm leading-6"
                                            onChange={(event) =>
                                                setDraft(event.currentTarget.value)
                                            }
                                            spellCheck={false}
                                            value={draft}
                                        />
                                    </FormField>
                                    <div className="mt-3 flex shrink-0 flex-wrap items-center justify-end gap-2">
                                        {changed && (
                                            <Text size="sm" tone="warning">
                                                Unsaved changes
                                            </Text>
                                        )}
                                        <Button
                                            busy={saving}
                                            busyLabel="Saving…"
                                            disabled={!changed || json?.valid === false}
                                            type="submit"
                                        >
                                            <Icon icon={Save} size="sm" tone="inherit" />
                                            Save
                                        </Button>
                                    </div>
                                </Form>
                            )}
                        {preview.prepared.ticket.previewKind === "text" &&
                            mode === "rendered" && (
                                <TextPresentation content={draft} entry={entry} />
                            )}
                        {preview.prepared.ticket.previewKind === "text" &&
                            mode === "raw" && (
                                <SourceViewer
                                    ariaLabel={`${entry.name} source`}
                                    content={draft}
                                    copyLabel={`Copy ${entry.name}`}
                                    language={language.id}
                                    languageLabel={language.label}
                                />
                            )}
                        {preview.prepared.ticket.previewKind !== "text" && (
                            <MediaPresentation
                                entry={entry}
                                prepared={preview.prepared}
                            />
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
