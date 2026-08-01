import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { X } from "lucide-react";
import { type ReactNode } from "react";

import { cn } from "../../utils/cn";
import { Button } from "./Button";

/** Provides props for modal. */
interface ModalProperties {
    isOpen: boolean;
    isDismissDisabled?: boolean;
    onClose: () => void;
    title?: string;
    children: ReactNode;
    scrollOwner?: "body" | "content";
    size?: "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";
}

const SIZE_CLASSES = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    xl: "max-w-xl",
    "2xl": "max-w-2xl",
    "3xl": "max-w-3xl",
};

/**
 * Renders the modal UI.
 * @returns Rendered the modal UI.
 */
export function Modal({
    isOpen,
    isDismissDisabled = false,
    onClose,
    scrollOwner = "body",
    title,
    children,
    size = "md",
}: ModalProperties) {
    const handleClose = () => {
        if (!isDismissDisabled) {
            onClose();
        }
    };

    return (
        <Dialog open={isOpen} onClose={handleClose} className="relative z-50">
            <DialogBackdrop
                className="fixed inset-0 bg-black/50 transition-opacity data-closed:opacity-0 data-enter:opacity-100"
                transition
            />
            <div className="fixed inset-0 flex items-center justify-center p-4">
                <DialogPanel
                    transition
                    className={cn(
                        "w-full rounded-lg border border-primary-700 bg-primary-800 shadow-xl",
                        "flex flex-col",
                        "max-h-[90vh]",
                        "data-closed:scale-95 data-closed:opacity-0 data-enter:scale-100 data-enter:opacity-100",
                        "transition duration-200 ease-out",
                        SIZE_CLASSES[size]
                    )}
                >
                    {title && (
                        <div className="flex shrink-0 items-center justify-between border-b border-primary-700 px-4 py-3">
                            <DialogTitle className="text-lg font-semibold text-primary-100">
                                {title}
                            </DialogTitle>
                            <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Close ${title}`}
                                disabled={isDismissDisabled}
                                onClick={handleClose}
                                className="text-primary-400 hover:text-primary-200"
                            >
                                <X size={20} />
                            </Button>
                        </div>
                    )}
                    <div
                        className={cn(
                            "min-h-0 flex-1 p-4",
                            scrollOwner === "body" ? "overflow-y-auto" : "overflow-hidden"
                        )}
                        data-modal-scroll-owner={scrollOwner}
                    >
                        {children}
                    </div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
