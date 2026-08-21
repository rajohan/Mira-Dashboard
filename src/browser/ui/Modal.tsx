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
    readonly eyebrow?: ReactNode;
    readonly onClose: () => void;
    readonly open: boolean;
    readonly scrollOwner?: "content" | "page";
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
    eyebrow,
    onClose,
    open,
    scrollOwner = "page",
    size = "md",
    title,
}: ModalProps) {
    return (
        <Dialog
            className="relative z-70"
            onClose={dismissible ? onClose : () => {}}
            open={open}
        >
            <DialogBackdrop
                className="fixed inset-0 bg-black/65 backdrop-blur-sm transition duration-200 data-closed:opacity-0"
                transition
            />
            <div
                aria-label={dismissible ? undefined : "Dialog content"}
                className={cn(
                    "fixed inset-0 w-screen overflow-x-hidden p-4",
                    scrollOwner === "page" ? "overflow-y-auto" : "overflow-y-hidden"
                )}
                role={dismissible ? undefined : "region"}
                tabIndex={dismissible ? undefined : 0}
            >
                <div className="flex min-h-full items-center justify-center">
                    <DialogPanel
                        className={cn(
                            "border-primary-700 bg-primary-800 w-full min-w-0 rounded-xl border shadow-2xl shadow-black/50 transition duration-200",
                            "data-closed:translate-y-2 data-closed:scale-95 data-closed:opacity-0",
                            scrollOwner === "content" &&
                                "flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden",
                            sizeClasses[size]
                        )}
                        data-testid="modal-panel"
                        transition
                    >
                        <div className="border-primary-700 bg-primary-900/40 flex min-w-0 shrink-0 items-start justify-between gap-4 border-b px-5 py-4">
                            <div className="min-w-0 flex-1">
                                {eyebrow !== undefined && (
                                    <div className="mb-2 flex flex-wrap items-center gap-2">
                                        {eyebrow}
                                    </div>
                                )}
                                <DialogTitle className="text-primary-50 line-clamp-3 text-lg font-semibold wrap-anywhere">
                                    {title}
                                </DialogTitle>
                                {description !== undefined && (
                                    <Description className="text-primary-400 mt-1 text-sm leading-6 wrap-anywhere">
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
                        <div
                            className={cn(
                                "min-w-0 p-5",
                                scrollOwner === "content" &&
                                    "min-h-0 flex-1 overflow-y-auto"
                            )}
                        >
                            {children}
                        </div>
                    </DialogPanel>
                </div>
            </div>
        </Dialog>
    );
}
