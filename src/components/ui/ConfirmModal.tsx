import { Button } from "./Button";
import { Modal } from "./Modal";

/** Describes confirm modal props. */
interface ConfirmModalProps {
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
}: ConfirmModalProps) {
    return (
        <Modal isOpen={isOpen} onClose={onCancel} title={title} size="md">
            <div className="space-y-4">
                <p className="text-primary-300 text-sm break-words whitespace-pre-wrap">
                    {message}
                </p>
                <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={onCancel} disabled={loading}>
                        Cancel
                    </Button>
                    <Button
                        variant={danger ? "danger" : "primary"}
                        onClick={onConfirm}
                        disabled={loading}
                    >
                        {loading
                            ? confirmLoadingLabel || `${confirmLabel}...`
                            : confirmLabel}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
