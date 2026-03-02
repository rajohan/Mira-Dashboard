import { X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { useModalRoot } from "../../hooks/useModalRoot";
import { cn } from "../../utils/cn";

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title?: string;
    children: ReactNode;
    size?: "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";
    closeOnOverlayClick?: boolean;
    closeOnEscape?: boolean;
}

const FOCUSABLE_SELECTOR =
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

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
    closeOnOverlayClick = true,
    closeOnEscape = true,
}: ModalProps) {
    const modalRef = useRef<HTMLDivElement>(null);
    const previousActiveElement = useRef<HTMLElement | null>(null);
    const modalRoot = useModalRoot(isOpen);

    // Focus trap
    const handleTabKey = useCallback((e: KeyboardEvent) => {
        if (!modalRef.current || e.key !== "Tab") return;

        const focusableElements =
            modalRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        const firstFocusable = focusableElements[0];
        const lastFocusable = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
            // Shift + Tab (backwards)
            if (document.activeElement === firstFocusable) {
                e.preventDefault();
                lastFocusable.focus();
            }
        } else {
            // Tab (forwards)
            if (document.activeElement === lastFocusable) {
                e.preventDefault();
                firstFocusable.focus();
            }
        }
    }, []);

    // Escape key handler
    const handleEscape = useCallback(
        (e: KeyboardEvent) => {
            if (e.key === "Escape" && closeOnEscape) {
                onClose();
            }
        },
        [closeOnEscape, onClose]
    );

    // Focus management and scroll lock
    useEffect(() => {
        if (isOpen) {
            // Store previously focused element
            previousActiveElement.current = document.activeElement as HTMLElement;

            // Lock body scroll
            document.body.style.overflow = "hidden";

            // Add keyboard listeners
            document.addEventListener("keydown", handleEscape);
            document.addEventListener("keydown", handleTabKey);

            // Focus first focusable element
            requestAnimationFrame(() => {
                if (modalRef.current) {
                    const firstFocusable =
                        modalRef.current.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
                    if (firstFocusable) {
                        firstFocusable.focus();
                    } else {
                        modalRef.current.focus();
                    }
                }
            });
        }

        return () => {
            document.removeEventListener("keydown", handleEscape);
            document.removeEventListener("keydown", handleTabKey);
            document.body.style.overflow = "";

            // Restore focus
            if (previousActiveElement.current) {
                previousActiveElement.current.focus();
            }
        };
    }, [isOpen, handleEscape, handleTabKey]);

    if (!isOpen || !modalRoot) return null;

    return createPortal(
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? "modal-title" : undefined}
        >
            {/* Backdrop - clickable overlay */}
            <div
                className="absolute inset-0 bg-black/50"
                onClick={closeOnOverlayClick ? onClose : undefined}
                aria-hidden="true"
            />

            {/* Modal content */}
            <div
                ref={modalRef}
                className={cn(
                    "relative w-full rounded-lg border border-primary-700 bg-primary-800 shadow-xl",
                    "focus:outline-none",
                    SIZE_CLASSES[size]
                )}
                tabIndex={-1}
            >
                {title && (
                    <div className="flex items-center justify-between border-b border-primary-700 px-4 py-3">
                        <h2
                            id="modal-title"
                            className="text-lg font-semibold text-primary-50"
                        >
                            {title}
                        </h2>
                        <button
                            onClick={onClose}
                            className="text-primary-400 transition-colors hover:text-primary-200"
                            aria-label="Close modal"
                        >
                            <X size={20} />
                        </button>
                    </div>
                )}
                <div className="p-4">{children}</div>
            </div>
        </div>,
        modalRoot
    );
}
