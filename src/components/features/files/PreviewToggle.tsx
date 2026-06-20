import { Code, Eye } from "lucide-react";

import { Button } from "../../../components/ui/Button";

/** Provides props for preview toggle. */
interface PreviewToggleProperties {
    isPreview: boolean;
    onToggle: (isPreview: boolean) => void;
    previewLabel?: string;
    editLabel?: string;
}

/** Renders the preview toggle UI. */
export function PreviewToggle({
    isPreview,
    onToggle,
    previewLabel = "Preview",
    editLabel = "Raw",
}: PreviewToggleProperties) {
    return (
        <div className="bg-primary-700 flex min-w-0 items-center gap-1 rounded p-0.5">
            <Button
                variant={isPreview ? "primary" : "ghost"}
                size="sm"
                onClick={() => onToggle(true)}
                className="rounded px-2 py-1 text-xs"
            >
                <Eye size={14} />
                <span>{previewLabel}</span>
            </Button>
            <Button
                variant={isPreview ? "ghost" : "primary"}
                size="sm"
                onClick={() => onToggle(false)}
                className="rounded px-2 py-1 text-xs"
            >
                <Code size={14} />
                <span>{editLabel}</span>
            </Button>
        </div>
    );
}
