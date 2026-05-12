import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { X } from "lucide-react";
import { type ReactNode } from "react";

import { cn } from "../../utils/cn";
import { Button } from "./Button";

/** Describes modal props. */
interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title?: string;
    children: ReactNode;
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

/** Renders the modal UI. */
export function Modal({ isOpen, onClose, title, children, size = "md" }: ModalProps) {
    return (
        <Dialog open={isOpen} onClose={onClose} className="relative z-50">
            <DialogBackdrop
                className="fixed inset-0 bg-black/50 transition-opacity data-closed:opacity-0 data-enter:opacity-100"
                transition
            />
            <div className="fixed inset-0 flex items-center justify-center p-4">
                <DialogPanel
                    transition
                    className={cn(
                        "border-primary-700 bg-primary-800 w-full rounded-lg border shadow-xl",
                        "flex flex-col",
                        "max-h-[90vh]",
                        "data-closed:scale-95 data-closed:opacity-0 data-enter:scale-100 data-enter:opacity-100",
                        "transition duration-200 ease-out",
                        SIZE_CLASSES[size]
                    )}
                >
                    {title && (
                        <div className="border-primary-700 flex flex-shrink-0 items-center justify-between border-b px-4 py-3">
                            <DialogTitle className="text-primary-100 text-lg font-semibold">
                                {title}
                            </DialogTitle>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={onClose}
                                className="text-primary-400 hover:text-primary-200"
                            >
                                <X size={20} />
                            </Button>
                        </div>
                    )}
                    <div className="flex-1 overflow-y-auto p-4">{children}</div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
