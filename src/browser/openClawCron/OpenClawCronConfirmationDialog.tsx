import { TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";

import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Modal } from "../ui/Modal.tsx";

interface OpenClawCronConfirmationDialogProps {
    readonly busy: boolean;
    readonly confirmDisabled: boolean;
    readonly confirmLabel: string;
    readonly danger: boolean;
    readonly description: ReactNode;
    readonly error?: string;
    readonly onCancel: () => void;
    readonly onConfirm: () => void;
    readonly onRetry?: () => void;
    readonly retryBusy: boolean;
    readonly retryLabel: string;
    readonly title: ReactNode;
}

/** @returns A narrow-viewport-safe confirmation boundary for OpenClaw cron controls. */
export function OpenClawCronConfirmationDialog({
    busy,
    confirmDisabled,
    confirmLabel,
    danger,
    description,
    error,
    onCancel,
    onConfirm,
    onRetry,
    retryBusy,
    retryLabel,
    title,
}: OpenClawCronConfirmationDialogProps) {
    return (
        <Modal
            dismissible={!busy && !retryBusy}
            onClose={onCancel}
            open
            size="sm"
            title={<span className="wrap-anywhere">{title}</span>}
        >
            <div className="flex max-w-full min-w-0 items-start gap-3">
                {danger && (
                    <Icon
                        className="mt-0.5 shrink-0"
                        icon={TriangleAlert}
                        tone="danger"
                    />
                )}
                <p className="text-primary-300 max-w-full min-w-0 text-sm leading-6 wrap-anywhere">
                    {description}
                </p>
            </div>
            <Alert className="mt-4" message={error} />
            <div className="mt-5 flex max-w-full min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
                <Button
                    className="w-full sm:w-auto"
                    disabled={busy || retryBusy}
                    onClick={onCancel}
                    variant="secondary"
                >
                    <Icon icon={X} size="sm" tone="inherit" />
                    Cancel
                </Button>
                {onRetry !== undefined && (
                    <Button
                        busy={retryBusy}
                        busyLabel="Refreshing…"
                        className="w-full sm:w-auto"
                        onClick={onRetry}
                        variant="secondary"
                    >
                        {retryLabel}
                    </Button>
                )}
                <Button
                    busy={busy}
                    busyLabel={`${confirmLabel}…`}
                    className="w-full sm:w-auto"
                    disabled={confirmDisabled || retryBusy}
                    onClick={onConfirm}
                    variant={danger ? "danger" : "primary"}
                >
                    {confirmLabel}
                </Button>
            </div>
        </Modal>
    );
}
