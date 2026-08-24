import { TriangleAlert, X } from "lucide-react";
import type { ReactNode, Ref } from "react";

import { Alert } from "./Alert.tsx";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { Modal } from "./Modal.tsx";

interface ConfirmModalProps {
    readonly busy?: boolean;
    readonly confirmLabel?: string;
    readonly confirmButtonRef?: Ref<HTMLButtonElement>;
    readonly confirmDisabled?: boolean;
    readonly danger?: boolean;
    readonly description: ReactNode;
    readonly error?: string;
    readonly onCancel: () => void;
    readonly onConfirm: () => void;
    readonly onRetry?: () => void;
    readonly open: boolean;
    readonly retryBusy?: boolean;
    readonly retryLabel?: string;
    readonly title: ReactNode;
}

/**
 * Renders an explicit confirmation boundary for consequential actions.
 * @returns A managed dialog with safe cancel and confirm actions.
 */
export function ConfirmModal({
    busy = false,
    confirmButtonRef,
    confirmDisabled = false,
    confirmLabel = "Confirm",
    danger = false,
    description,
    error,
    onCancel,
    onConfirm,
    onRetry,
    open,
    retryBusy = false,
    retryLabel = "Retry",
    title,
}: ConfirmModalProps) {
    return (
        <Modal
            dismissible={!busy && !retryBusy}
            onClose={onCancel}
            open={open}
            size="sm"
            title={title}
        >
            <div className="flex items-start gap-3">
                {danger && (
                    <Icon
                        className="mt-0.5 shrink-0"
                        icon={TriangleAlert}
                        tone="danger"
                    />
                )}
                <p className="text-primary-300 min-w-0 flex-1 text-sm leading-6 wrap-anywhere">
                    {description}
                </p>
            </div>
            <Alert className="mt-4" message={error} />
            <div className="mt-5 flex justify-end gap-2">
                <Button
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
                        onClick={onRetry}
                        variant="secondary"
                    >
                        {retryLabel}
                    </Button>
                )}
                <Button
                    busy={busy}
                    busyLabel={`${confirmLabel}…`}
                    disabled={confirmDisabled || retryBusy}
                    onClick={onConfirm}
                    ref={confirmButtonRef}
                    variant={danger ? "danger" : "primary"}
                >
                    {confirmLabel}
                </Button>
            </div>
        </Modal>
    );
}
