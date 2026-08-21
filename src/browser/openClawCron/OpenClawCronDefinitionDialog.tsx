import { useState } from "react";

import type {
    OpenClawCronJob,
    UpdateOpenClawCronPatch,
} from "../../contracts/openClawCron.ts";
import { isDashboardOperationOutcomeUnknown } from "../api/trpcError.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import {
    openClawCronPatchJson,
    openClawCronUnknownOutcomeMessage,
    parseOpenClawCronPatchJson,
} from "./presentation.ts";

interface OpenClawCronDefinitionDialogProps {
    readonly job: OpenClawCronJob;
    readonly onClose: () => void;
    readonly onReconcile?: () => Promise<void>;
    readonly onSubmit: (patch: UpdateOpenClawCronPatch) => Promise<void>;
    readonly reconciliationBlocked?: boolean;
    readonly reconciliationBusy?: boolean;
    readonly reconciliationError?: string;
}

/** @returns Strict JSON editor limited to reviewed non-control-plane definition fields. */
export function OpenClawCronDefinitionDialog({
    job,
    onClose,
    onReconcile,
    onSubmit,
    reconciliationBlocked = false,
    reconciliationBusy = false,
    reconciliationError,
}: OpenClawCronDefinitionDialogProps) {
    const [value, setValue] = useState(() => openClawCronPatchJson(job));
    const [mutationError, setMutationError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const parsed = parseOpenClawCronPatchJson(value, job);

    async function submit(): Promise<void> {
        if (!parsed.success || reconciliationBlocked || reconciliationBusy) return;
        setMutationError(undefined);
        setBusy(true);
        try {
            await onSubmit(parsed.patch);
            onClose();
        } catch (error) {
            setMutationError(
                isDashboardOperationOutcomeUnknown(error)
                    ? openClawCronUnknownOutcomeMessage
                    : "The OpenClaw job was not updated. Refresh and try again."
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal
            description="Edit the job settings below. Leave delivery out to keep it unchanged, enter a new value to replace it, or use null to remove it. This editor cannot enable the job or change commands, chat targets, trigger code, or scheduling state."
            dismissible={!busy && !reconciliationBusy}
            onClose={onClose}
            open
            size="lg"
            title={<span className="wrap-anywhere">Edit {job.name}</span>}
        >
            <Form aria-label="Edit OpenClaw scheduled job" onSubmit={submit}>
                <Alert className="mb-4" message={mutationError} />
                <Alert className="mb-4" message={reconciliationError} />
                <FormField
                    description={parsed.success ? "The changes are valid." : undefined}
                    error={parsed.success ? undefined : parsed.message}
                    label="Job settings (JSON)"
                >
                    <Textarea
                        className="min-h-96 max-w-full min-w-0 font-mono text-sm"
                        disabled={busy || reconciliationBlocked || reconciliationBusy}
                        onChange={(event) => {
                            setValue(event.target.value);
                        }}
                        spellCheck={false}
                        value={value}
                    />
                </FormField>
                <div className="mt-5 flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
                    <Button
                        className="w-full sm:w-auto"
                        disabled={busy || reconciliationBusy}
                        onClick={onClose}
                        type="button"
                        variant="secondary"
                    >
                        Cancel
                    </Button>
                    {reconciliationBlocked && onReconcile !== undefined && (
                        <Button
                            busy={reconciliationBusy}
                            busyLabel="Refreshing…"
                            className="w-full sm:w-auto"
                            onClick={() => void onReconcile()}
                            type="button"
                            variant="secondary"
                        >
                            Refresh current status
                        </Button>
                    )}
                    <Button
                        busy={busy}
                        busyLabel="Saving…"
                        className="w-full sm:w-auto"
                        disabled={
                            busy ||
                            reconciliationBlocked ||
                            reconciliationBusy ||
                            !parsed.success
                        }
                        type="submit"
                    >
                        Save changes
                    </Button>
                </div>
            </Form>
        </Modal>
    );
}
