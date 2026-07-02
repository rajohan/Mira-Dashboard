import { Check, Loader2, X } from "lucide-react";

import { Button } from "./Button";
import { Modal } from "./Modal";

/** Provides props for confirm modal. */
interface ConfirmModalProperties {
    isOpen: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    confirmLoadingLabel?: string;
    loading?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    danger?: boolean;
}

/** Renders the confirm modal UI. */
export function ConfirmModal({
    isOpen,
    title,
    message,
    confirmLabel = "Confirm",
    confirmLoadingLabel,
    loading = false,
    onConfirm,
    onCancel,
    danger = false,
}: ConfirmModalProperties) {
    return (
        <Modal isOpen={isOpen} onClose={onCancel} title={title} size="md">
            <div className="space-y-4">
                <p className="text-sm wrap-break-word whitespace-pre-wrap text-primary-300">
                    {message}
                </p>
                <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={onCancel} disabled={loading}>
                        <X className="size-4" />
                        Cancel
                    </Button>
                    <Button
                        variant={danger ? "danger" : "primary"}
                        onClick={onConfirm}
                        disabled={loading}
                    >
                        {loading ? (
                            <>
                                <Loader2 className="size-4 animate-spin" />
                                {confirmLoadingLabel || `${confirmLabel}...`}
                            </>
                        ) : (
                            <>
                                <Check className="size-4" />
                                {confirmLabel}
                            </>
                        )}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
