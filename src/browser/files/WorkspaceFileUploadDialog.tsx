import { Upload } from "lucide-react";
import { useId, useRef, useState } from "react";

import type {
    WorkspaceFileEntry,
    WorkspaceFileWriteStatus,
} from "../../contracts/files.ts";
import { formatByteCount } from "../lib/formatMeasurements.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { FileDropZone } from "../ui/FileDropZone.tsx";
import { Form } from "../ui/Form.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Modal } from "../ui/Modal.tsx";
import { workspaceFileFailureMessage } from "./workspaceFilePresentation.ts";
import { validateWorkspaceFileSelection } from "./workspaceFileTransfers.ts";

export type WorkspaceFileUploadIntent =
    | Readonly<{ directoryName: string; kind: "create" }>
    | Readonly<{ entry: WorkspaceFileEntry; kind: "replace" }>;

interface WorkspaceFileUploadDialogProps {
    readonly intent: WorkspaceFileUploadIntent | undefined;
    readonly onClose: () => void;
    readonly onComplete: (status: WorkspaceFileWriteStatus) => void;
    readonly onSubmit: (
        file: File,
        replacedEntry: WorkspaceFileEntry | undefined
    ) => Promise<WorkspaceFileWriteStatus>;
}

/** @returns One bounded create or CAS-replacement file picker. */
export function WorkspaceFileUploadDialog({
    intent,
    onClose,
    onComplete,
    onSubmit,
}: WorkspaceFileUploadDialogProps) {
    const fileInput = useRef<HTMLInputElement>(null);
    const selectionErrorId = useId();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [file, setFile] = useState<File>();
    const [selectionError, setSelectionError] = useState<string>();

    if (intent === undefined) return null;
    const replacing = intent.kind === "replace";
    const replacedEntry = intent.kind === "replace" ? intent.entry : undefined;
    const title =
        replacedEntry === undefined ? "Upload file" : `Replace ${replacedEntry.name}`;

    function selectFiles(files: FileList): void {
        setError(undefined);
        if (files.length !== 1) {
            setFile(undefined);
            setSelectionError("Choose one file at a time.");
            return;
        }
        const nextFile = files.item(0);
        if (nextFile === null) return;
        setFile(nextFile);
        setSelectionError(validateWorkspaceFileSelection(nextFile, !replacing));
    }

    async function submit() {
        if (file === undefined || busy) return;
        const validation = validateWorkspaceFileSelection(file, !replacing);
        setSelectionError(validation);
        if (validation !== undefined) return;
        setBusy(true);
        setError(undefined);
        try {
            const status = await onSubmit(file, replacedEntry);
            onComplete(status);
        } catch (error) {
            setError(workspaceFileFailureMessage(error));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal
            description={
                replacing
                    ? "Choose the new version of this file. If it changed since you opened it, refresh and try again."
                    : `Choose one file to add to ${intent.directoryName}. A file with the same name will not be overwritten.`
            }
            dismissible={!busy}
            onClose={onClose}
            open
            size="lg"
            title={title}
        >
            <Form className="space-y-4" onSubmit={submit}>
                <Alert focusOnError message={error} />
                <input
                    aria-label={replacing ? "Replacement content" : "File"}
                    className="sr-only"
                    disabled={busy}
                    onChange={(event) => {
                        if (event.currentTarget.files !== null) {
                            selectFiles(event.currentTarget.files);
                        }
                        event.currentTarget.value = "";
                    }}
                    ref={fileInput}
                    tabIndex={-1}
                    type="file"
                />
                <FileDropZone
                    ariaDescribedBy={
                        selectionError === undefined ? undefined : selectionErrorId
                    }
                    description={
                        file === undefined
                            ? "One file · 16 MiB maximum"
                            : `${formatByteCount(file.size)} · Drop or choose another file to change selection`
                    }
                    disabled={busy}
                    invalid={selectionError !== undefined}
                    label={
                        file?.name ??
                        (replacing
                            ? "Drop the replacement here or choose a file"
                            : "Drop a file here or choose a file")
                    }
                    onChooseFiles={() => fileInput.current?.click()}
                    onFilesSelected={selectFiles}
                />
                {selectionError !== undefined && (
                    <p
                        className="text-sm text-red-300"
                        id={selectionErrorId}
                        role="alert"
                    >
                        {selectionError}
                    </p>
                )}
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button disabled={busy} onClick={onClose} variant="secondary">
                        Cancel
                    </Button>
                    <Button
                        busy={busy}
                        busyLabel={replacing ? "Replacing…" : "Uploading…"}
                        disabled={file === undefined || selectionError !== undefined}
                        type="submit"
                    >
                        <Icon icon={Upload} size="sm" tone="inherit" />
                        {replacing ? "Replace file" : "Upload file"}
                    </Button>
                </div>
            </Form>
        </Modal>
    );
}
