import { TriangleAlert, X } from "lucide-react";
import type { ReactNode, Ref } from "react";

import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { Modal } from "./Modal.tsx";

interface ConfirmModalProps {
    readonly busy?: boolean;
    readonly confirmLabel?: string;
    readonly confirmButtonRef?: Ref<HTMLButtonElement>;
    readonly danger?: boolean;
    readonly description: ReactNode;
    readonly onCancel: () => void;
    readonly onConfirm: () => void;
    readonly open: boolean;
    readonly title: ReactNode;
}

/**
 * Renders an explicit confirmation boundary for consequential actions.
 * @returns A managed dialog with safe cancel and confirm actions.
 */
export function ConfirmModal({
    busy = false,
    confirmButtonRef,
    confirmLabel = "Confirm",
    danger = false,
    description,
    onCancel,
    onConfirm,
    open,
    title,
}: ConfirmModalProps) {
    return (
        <Modal dismissible={!busy} onClose={onCancel} open={open} size="sm" title={title}>
            <div className="flex items-start gap-3">
                {danger && (
                    <Icon
                        className="mt-0.5 shrink-0"
                        icon={TriangleAlert}
                        tone="danger"
                    />
                )}
                <p className="text-primary-300 text-sm leading-6">{description}</p>
            </div>
            <div className="mt-5 flex justify-end gap-2">
                <Button disabled={busy} onClick={onCancel} variant="secondary">
                    <Icon icon={X} size="sm" tone="inherit" />
                    Cancel
                </Button>
                <Button
                    busy={busy}
                    busyLabel={`${confirmLabel}…`}
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
