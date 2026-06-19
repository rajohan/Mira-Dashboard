import { Database, MoreVertical, RotateCcw, Trash2 } from "lucide-react";

import { Dropdown, type DropdownItem } from "../../ui/Dropdown";

/** Provides props for session actions dropdown. */
interface SessionActionsDropdownProperties {
    ariaLabel?: string;
    onCompact: () => void;
    onReset: () => void;
    onDelete?: () => void;
    showDelete?: boolean;
}

/** Renders the session actions dropdown UI. */
export function SessionActionsDropdown({
    ariaLabel = "Session actions",
    onCompact,
    onReset,
    onDelete,
    showDelete = true,
}: SessionActionsDropdownProperties) {
    const items: DropdownItem[] = [
        {
            label: "Compact",
            icon: <Database className="text-primary-400 h-4 w-4" />,
            onClick: onCompact,
        },
        {
            label: "Reset",
            icon: <RotateCcw className="text-primary-400 h-4 w-4" />,
            onClick: onReset,
        },
    ];

    if (showDelete && onDelete) {
        items.push({
            label: "Delete",
            icon: <Trash2 className="h-4 w-4" />,
            variant: "danger",
            onClick: onDelete,
        });
    }

    return (
        <Dropdown
            ariaLabel={ariaLabel}
            icon={<MoreVertical className="h-4 w-4" />}
            variant="ghost"
            items={items}
        />
    );
}
