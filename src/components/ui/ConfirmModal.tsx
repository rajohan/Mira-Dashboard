import { Modal } from "./Modal";
import { Button } from "./Button";

interface ConfirmModalProps {
    isOpen: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
    danger?: boolean;
}

export function ConfirmModal({
    isOpen,
    title,
    message,
    confirmLabel = "Confirm",
    onConfirm,
    onCancel,
    danger = false,
}: ConfirmModalProps) {
    return (
        <Modal isOpen={isOpen} onClose={onCancel} title={title} size="md">
            <div className="space-y-4">
                <p className="text-sm text-slate-300">{message}</p>
                <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button
                        variant={danger ? "danger" : "primary"}
                        onClick={onConfirm}
                    >
                        {confirmLabel}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
