import { type ReactNode, useEffect, useCallback } from "react";
import { X } from "lucide-react";
import { cn } from "../../utils/cn";

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title?: string;
    children: ReactNode;
    size?: "sm" | "md" | "lg";
}

export function Modal({ isOpen, onClose, title, children, size = "md" }: ModalProps) {
    const handleEscape = useCallback((e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
    }, [onClose]);

    useEffect(() => {
        if (isOpen) {
            document.addEventListener("keydown", handleEscape);
            document.body.style.overflow = "hidden";
        }
        return () => {
            document.removeEventListener("keydown", handleEscape);
            document.body.style.overflow = "";
        };
    }, [isOpen, handleEscape]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/50" onClick={onClose} />
            <div
                className={cn(
                    "relative bg-primary-800 rounded-lg shadow-xl border border-primary-700",
                    {
                        "w-full max-w-sm": size === "sm",
                        "w-full max-w-md": size === "md",
                        "w-full max-w-lg": size === "lg",
                    }
                )}
            >
                {title && (
                    <div className="flex items-center justify-between px-4 py-3 border-b border-primary-700">
                        <h3 className="text-lg font-semibold text-primary-50">{title}</h3>
                        <button
                            onClick={onClose}
                            className="text-primary-400 hover:text-primary-200 transition-colors"
                        >
                            <X size={20} />
                        </button>
                    </div>
                )}
                <div className="p-4">{children}</div>
            </div>
        </div>
    );
}
