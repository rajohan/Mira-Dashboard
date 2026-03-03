import { Code, Eye } from "lucide-react";

interface PreviewToggleProps {
    preview: boolean;
    onToggle: (preview: boolean) => void;
    previewLabel?: string;
    editLabel?: string;
}

export function PreviewToggle({
    preview,
    onToggle,
    previewLabel = "Preview",
    editLabel = "Raw",
}: PreviewToggleProps) {
    return (
        <div className="flex items-center gap-1 rounded bg-slate-700 p-0.5">
            <button
                className={
                    "rounded px-2 py-1 text-xs " +
                    (preview
                        ? "bg-accent-500 text-white"
                        : "text-slate-300 hover:text-white")
                }
                onClick={() => onToggle(true)}
            >
                <Eye size={14} className="mr-1 inline" />
                {previewLabel}
            </button>
            <button
                className={
                    "rounded px-2 py-1 text-xs " +
                    (preview
                        ? "text-slate-300 hover:text-white"
                        : "bg-accent-500 text-white")
                }
                onClick={() => onToggle(false)}
            >
                <Code size={14} className="mr-1 inline" />
                {editLabel}
            </button>
        </div>
    );
}