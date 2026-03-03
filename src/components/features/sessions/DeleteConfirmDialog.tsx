import { AlertTriangle } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";

import type { Session } from "../../../hooks/useOpenClaw";

interface DeleteConfirmDialogProps {
    session: Session | null;
    onConfirm: () => void;
    onCancel: () => void;
    isLoading: boolean;
}

export function DeleteConfirmDialog({
    session,
    onConfirm,
    onCancel,
    isLoading,
}: DeleteConfirmDialogProps) {
    const displayName =
        session?.displayLabel || session?.label || session?.displayName || session?.id;
    const isMain = (session?.type || "").toUpperCase() === "MAIN";

    return (
        <Modal
            isOpen={!!session}
            onClose={onCancel}
            title="Delete Session?"
            size="md"
            closeOnOverlayClick={false}
        >
            <div className="flex items-start gap-3">
                <div className="rounded-lg bg-red-500/20 p-2">
                    <AlertTriangle className="h-6 w-6 text-red-400" />
                </div>
                <div className="flex-1">
                    <p className="mb-2 text-sm text-slate-300">
                        Are you sure you want to delete this session?
                        <span className="mt-1 block text-xs text-slate-400">
                            {displayName}
                        </span>
                    </p>
                    {isMain && (
                        <p className="mb-4 text-xs text-yellow-400">
                            This is a MAIN session. Deleting it will terminate the primary
                            conversation.
                        </p>
                    )}
                    <div className="flex justify-end gap-2">
                        <Button
                            variant="secondary"
                            onClick={onCancel}
                            disabled={isLoading}
                        >
                            Cancel
                        </Button>
                        <Button variant="danger" onClick={onConfirm} disabled={isLoading}>
                            {isLoading ? "Deleting..." : "Delete Session"}
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}