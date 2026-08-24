import {
    Menu as HeadlessMenu,
    MenuButton as HeadlessMenuButton,
    MenuItem as HeadlessMenuItem,
    MenuItems as HeadlessMenuItems,
} from "@headlessui/react";
import { EllipsisVertical, type LucideIcon } from "lucide-react";

import { cn } from "../lib/classNames.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";

export type DropdownMenuActionTone = "danger" | "default";

export interface DropdownMenuAction {
    readonly description?: string;
    readonly disabled?: boolean;
    readonly icon?: LucideIcon;
    readonly id: string;
    readonly label: string;
    readonly onSelect: () => void;
    readonly tone?: DropdownMenuActionTone;
}

interface DropdownMenuProps {
    readonly actions: readonly DropdownMenuAction[];
    readonly align?: "end" | "start";
    readonly className?: string;
    readonly disabled?: boolean;
    readonly triggerIcon?: LucideIcon;
    readonly triggerLabel: string;
}

/**
 * Renders a labelled action menu backed by Headless UI keyboard semantics.
 * @returns An icon trigger and a viewport-contained panel of button actions.
 */
export function DropdownMenu({
    actions,
    align = "end",
    className,
    disabled = false,
    triggerIcon = EllipsisVertical,
    triggerLabel,
}: DropdownMenuProps) {
    return (
        <HeadlessMenu as="div" className={cn("relative inline-flex", className)}>
            <HeadlessMenuButton
                aria-label={triggerLabel}
                as={Button}
                disabled={disabled}
                size="sm"
                title={triggerLabel}
                variant="ghost"
            >
                <Icon icon={triggerIcon} size="sm" tone="inherit" />
            </HeadlessMenuButton>
            <HeadlessMenuItems
                anchor={{ gap: 4, padding: 8, to: `bottom ${align}` }}
                className={cn(
                    "border-primary-600 bg-primary-900 z-60 max-h-80 w-72 max-w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg border p-1 shadow-xl shadow-black/35",
                    "transition duration-100 outline-none data-closed:scale-95 data-closed:opacity-0 motion-reduce:transition-none",
                    align === "end" ? "origin-top-right" : "origin-top-left"
                )}
                transition
            >
                {actions.map((action) => {
                    const danger = action.tone === "danger";

                    return (
                        <HeadlessMenuItem disabled={action.disabled} key={action.id}>
                            <button
                                className={cn(
                                    "group flex w-full min-w-0 items-start gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors outline-none select-none",
                                    "disabled:cursor-not-allowed disabled:opacity-50",
                                    danger
                                        ? "text-red-300 data-focus:bg-red-950/50 data-focus:text-red-100"
                                        : "text-primary-200 data-focus:bg-primary-700 data-focus:text-primary-50"
                                )}
                                disabled={action.disabled}
                                onClick={action.onSelect}
                                type="button"
                            >
                                {action.icon !== undefined && (
                                    <Icon
                                        className="mt-0.5 shrink-0"
                                        icon={action.icon}
                                        size="sm"
                                        tone="inherit"
                                    />
                                )}
                                <span className="min-w-0 flex-1">
                                    <span className="block font-medium wrap-break-word">
                                        {action.label}
                                    </span>
                                    {action.description !== undefined && (
                                        <span
                                            className={cn(
                                                "mt-0.5 block text-xs leading-5 wrap-break-word",
                                                danger
                                                    ? "text-red-300/80 group-data-focus:text-red-200"
                                                    : "text-primary-400 group-data-focus:text-primary-200"
                                            )}
                                        >
                                            {action.description}
                                        </span>
                                    )}
                                </span>
                            </button>
                        </HeadlessMenuItem>
                    );
                })}
            </HeadlessMenuItems>
        </HeadlessMenu>
    );
}
