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
                    : "The OpenClaw definition was not updated. Refresh and try again."
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal
            description="Only complete reviewed fields are prefilled. Delivery targets are write-only: omit delivery to keep it unchanged, add a replacement value to replace it, or use null to clear it. Enabled state, command/script payloads, session targets, trigger code, and scheduler state are never accepted by this editor."
            dismissible={!busy && !reconciliationBusy}
            onClose={onClose}
            open
            size="lg"
            title={`Edit ${job.name}`}
        >
            <Form aria-label="Edit OpenClaw cron definition" onSubmit={submit}>
                <Alert className="mb-4" message={mutationError} />
                <Alert className="mb-4" message={reconciliationError} />
                <FormField
                    description={
                        parsed.success
                            ? "Valid changed definition and write-only delivery JSON."
                            : undefined
                    }
                    error={parsed.success ? undefined : parsed.message}
                    label="Reviewed definition and delivery JSON"
                >
                    <Textarea
                        className="min-h-96 font-mono text-sm"
                        disabled={busy || reconciliationBlocked || reconciliationBusy}
                        onChange={(event) => {
                            setValue(event.target.value);
                        }}
                        spellCheck={false}
                        value={value}
                    />
                </FormField>
                <div className="mt-5 flex justify-end gap-2">
                    <Button
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
                            onClick={() => void onReconcile()}
                            type="button"
                            variant="secondary"
                        >
                            Refresh authoritative state
                        </Button>
                    )}
                    <Button
                        busy={busy}
                        busyLabel="Saving…"
                        disabled={
                            busy ||
                            reconciliationBlocked ||
                            reconciliationBusy ||
                            !parsed.success
                        }
                        type="submit"
                    >
                        Save reviewed fields
                    </Button>
                </div>
            </Form>
        </Modal>
    );
}
