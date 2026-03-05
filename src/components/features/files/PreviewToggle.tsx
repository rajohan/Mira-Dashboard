import { Code, Eye } from "lucide-react";

import { Button } from "../../../components/ui/Button";

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
        <div className="flex items-center gap-1 rounded bg-primary-700 p-0.5">
            <Button
                variant={preview ? "primary" : "ghost"}
                size="sm"
                onClick={() => onToggle(true)}
                className="rounded px-2 py-1 text-xs"
            >
                <Eye size={14} className="mr-1 inline" />
                {previewLabel}
            </Button>
            <Button
                variant={preview ? "ghost" : "primary"}
                size="sm"
                onClick={() => onToggle(false)}
                className="rounded px-2 py-1 text-xs"
            >
                <Code size={14} className="mr-1 inline" />
                {editLabel}
            </Button>
        </div>
    );
}
