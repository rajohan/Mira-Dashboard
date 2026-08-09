import { Upload } from "lucide-react";
import { useState } from "react";

import type {
    WorkspaceFileEntry,
    WorkspaceFileWriteStatus,
} from "../../contracts/files.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
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
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [file, setFile] = useState<File>();
    const [selectionError, setSelectionError] = useState<string>();

    if (intent === undefined) return null;
    const replacing = intent.kind === "replace";
    const replacedEntry = intent.kind === "replace" ? intent.entry : undefined;
    const title =
        replacedEntry === undefined ? "Upload file" : `Replace ${replacedEntry.name}`;

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
            title={title}
        >
            <Form className="space-y-4" onSubmit={submit}>
                <Alert focusOnError message={error} />
                <FormField
                    description="Maximum file size: 16 MiB."
                    error={selectionError}
                    label={replacing ? "Replacement content" : "File"}
                >
                    <Input
                        className="mt-2 file:mr-3 file:rounded file:border-0 file:px-2 file:py-1"
                        disabled={busy}
                        onChange={(event) => {
                            const nextFile = event.currentTarget.files?.[0];
                            setFile(nextFile);
                            setSelectionError(undefined);
                            setError(undefined);
                        }}
                        required
                        type="file"
                    />
                </FormField>
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button disabled={busy} onClick={onClose} variant="secondary">
                        Cancel
                    </Button>
                    <Button
                        busy={busy}
                        busyLabel={replacing ? "Replacing…" : "Uploading…"}
                        disabled={file === undefined}
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
