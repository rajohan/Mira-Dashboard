import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { X } from "lucide-react";
import { type ReactNode } from "react";

import { Button } from "./Button";
import { cn } from "../../utils/cn";

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

export function Modal({
    isOpen,
    onClose,
    title,
    children,
    size = "md",
}: ModalProps) {
    return (
        <Dialog open={isOpen} onClose={onClose} className="relative z-50">
            {/* Backdrop */}
            <div className="fixed inset-0 bg-black/50" aria-hidden="true" />

            {/* Modal container */}
            <div className="fixed inset-0 flex items-center justify-center p-4">
                <DialogPanel
                    className={cn(
                        "w-full rounded-lg border border-slate-700 bg-slate-800 shadow-xl",
                        "flex flex-col",
                        "max-h-[90vh]",
                        SIZE_CLASSES[size]
                    )}
                >
                    {title && (
                        <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-700 px-4 py-3">
                            <DialogTitle className="text-lg font-semibold text-slate-100">
                                {title}
                            </DialogTitle>
                            <Button variant="ghost" size="sm" onClick={onClose} className="text-slate-400 hover:text-slate-200">
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