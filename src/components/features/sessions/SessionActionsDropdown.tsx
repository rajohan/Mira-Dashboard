import { Database, MoreVertical, RotateCcw, Square, Trash2 } from "lucide-react";

import { Dropdown, type DropdownItem } from "../../ui/Dropdown";

interface SessionActionsDropdownProps {
    onStop: () => void;
    onCompact: () => void;
    onReset: () => void;
    onDelete?: () => void;
    showDelete?: boolean;
}

export function SessionActionsDropdown({
    onStop,
    onCompact,
    onReset,
    onDelete,
    showDelete = true,
}: SessionActionsDropdownProps) {
    const items: DropdownItem[] = [
        {
            label: "Stop",
            icon: <Square className="h-4 w-4 text-slate-400" />,
            onClick: onStop,
        },
        {
            label: "Compact",
            icon: <Database className="h-4 w-4 text-slate-400" />,
            onClick: onCompact,
        },
        {
            label: "Reset",
            icon: <RotateCcw className="h-4 w-4 text-slate-400" />,
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
            icon={<MoreVertical className="h-4 w-4" />}
            variant="ghost"
            items={items}
        />
    );
}
