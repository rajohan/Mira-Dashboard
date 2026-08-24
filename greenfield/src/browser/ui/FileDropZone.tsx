import { Upload, type LucideIcon } from "lucide-react";
import { type DragEvent, type ReactNode, useRef, useState } from "react";

import { cn } from "../lib/classNames.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";

interface FileDropZoneProps {
    readonly ariaDescribedBy?: string;
    readonly className?: string;
    readonly description?: ReactNode;
    readonly disabled?: boolean;
    readonly icon?: LucideIcon;
    readonly invalid?: boolean;
    readonly label: ReactNode;
    readonly onChooseFiles: () => void;
    readonly onFilesSelected: (files: FileList) => void;
}

/**
 * Renders a keyboard-operable file chooser target with drag-and-drop feedback.
 * Selection policy and file validation remain owned by the consuming feature.
 * @returns Shared file drop zone used by bounded upload workflows.
 */
export function FileDropZone({
    ariaDescribedBy,
    className,
    description,
    disabled = false,
    icon = Upload,
    invalid = false,
    label,
    onChooseFiles,
    onFilesSelected,
}: FileDropZoneProps) {
    const [dragging, setDragging] = useState(false);
    const dragDepth = useRef(0);

    function clearDragState(): void {
        dragDepth.current = 0;
        setDragging(false);
    }

    function handleDrop(event: DragEvent<HTMLButtonElement>): void {
        event.preventDefault();
        clearDragState();
        if (disabled || event.dataTransfer.files.length === 0) return;
        onFilesSelected(event.dataTransfer.files);
    }

    return (
        <Button
            aria-describedby={ariaDescribedBy}
            aria-invalid={invalid || undefined}
            className={cn(
                "border-primary-500 bg-primary-950 hover:border-accent-400 flex min-h-32 w-full min-w-0 flex-col items-center justify-center rounded-xl border border-dashed p-4 text-center transition-colors disabled:opacity-60",
                dragging && !disabled && "border-accent-400 bg-primary-900",
                invalid && "border-red-500",
                className
            )}
            data-dragging={dragging && !disabled ? "true" : undefined}
            disabled={disabled}
            onClick={onChooseFiles}
            onDragEnd={clearDragState}
            onDragEnter={(event) => {
                event.preventDefault();
                if (disabled) return;
                dragDepth.current += 1;
                setDragging(true);
            }}
            onDragLeave={(event) => {
                event.preventDefault();
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (dragDepth.current === 0) setDragging(false);
            }}
            onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
            }}
            onDrop={handleDrop}
            type="button"
            variant="unstyled"
        >
            <span className="bg-primary-700 rounded-full p-2.5">
                <Icon icon={icon} size="lg" tone="accent" />
            </span>
            <span className="text-primary-100 mt-3 max-w-full font-medium wrap-anywhere">
                {label}
            </span>
            {description !== undefined && (
                <span className="text-primary-400 mt-1 max-w-full text-sm wrap-anywhere">
                    {description}
                </span>
            )}
        </Button>
    );
}
