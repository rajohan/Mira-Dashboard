import {
    Description,
    Dialog,
    DialogBackdrop,
    DialogPanel,
    DialogTitle,
} from "@headlessui/react";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/classNames.ts";
import { IconOnlyButton } from "./IconOnlyButton.tsx";

const sizeClasses = Object.freeze({
    lg: "max-w-2xl",
    md: "max-w-lg",
    sm: "max-w-md",
});

interface ModalProps {
    readonly children: ReactNode;
    readonly description?: ReactNode;
    readonly dismissible?: boolean;
    readonly onClose: () => void;
    readonly open: boolean;
    readonly size?: keyof typeof sizeClasses;
    readonly title: ReactNode;
}

/**
 * Renders a managed Headless UI dialog with project-standard focus and motion.
 * @returns The modal dialog portal.
 */
export function Modal({
    children,
    description,
    dismissible = true,
    onClose,
    open,
    size = "md",
    title,
}: ModalProps) {
    return (
        <Dialog
            className="relative z-50"
            onClose={dismissible ? onClose : () => {}}
            open={open}
        >
            <DialogBackdrop
                className="fixed inset-0 bg-black/65 backdrop-blur-sm transition duration-200 data-closed:opacity-0"
                transition
            />
            <div className="fixed inset-0 w-screen overflow-y-auto p-4">
                <div className="flex min-h-full items-center justify-center">
                    <DialogPanel
                        className={cn(
                            "border-primary-700 bg-primary-800 w-full rounded-xl border shadow-2xl shadow-black/50 transition duration-200",
                            "data-closed:translate-y-2 data-closed:scale-95 data-closed:opacity-0",
                            sizeClasses[size]
                        )}
                        transition
                    >
                        <div className="border-primary-700 flex items-start justify-between gap-4 border-b px-5 py-4">
                            <div>
                                <DialogTitle className="text-primary-50 text-lg font-semibold">
                                    {title}
                                </DialogTitle>
                                {description !== undefined && (
                                    <Description className="text-primary-400 mt-1 text-sm leading-6">
                                        {description}
                                    </Description>
                                )}
                            </div>
                            {dismissible && (
                                <IconOnlyButton
                                    className="-mt-1 -mr-1 shrink-0"
                                    icon={X}
                                    label="Close dialog"
                                    onClick={onClose}
                                    size="sm"
                                    variant="ghost"
                                />
                            )}
                        </div>
                        <div className="p-5">{children}</div>
                    </DialogPanel>
                </div>
            </div>
        </Dialog>
    );
}
