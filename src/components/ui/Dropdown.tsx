import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { ChevronDown } from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

interface DropdownItem {
    label: string;
    onClick?: () => void;
    icon?: React.ReactNode;
    variant?: "default" | "danger";
    disabled?: boolean;
}

interface DropdownProps {
    trigger: React.ReactNode;
    items: DropdownItem[];
    align?: "left" | "right";
    className?: string;
}

export function Dropdown({ trigger, items, align = "right", className }: DropdownProps) {
    return (
        <Menu as="div" className={twMerge("relative inline-block text-left", className)}>
            <MenuButton className="inline-flex w-full items-center justify-center gap-1 rounded-lg border border-slate-600 bg-slate-700 px-3 py-1.5 text-sm font-medium text-slate-100 hover:bg-slate-600 focus:outline-none">
                {typeof trigger === "string" ? (
                    <>
                        {trigger}
                        <ChevronDown className="h-4 w-4" />
                    </>
                ) : (
                    trigger
                )}
            </MenuButton>

            <MenuItems
                className={clsx(
                    "absolute z-50 mt-2 min-w-[160px] origin-top-right rounded-lg border border-slate-600 bg-slate-800 p-1 shadow-lg focus:outline-none",
                    align === "right" ? "right-0" : "left-0"
                )}
            >
                {items.map((item, index) => (
                    <MenuItem key={index}>
                        {({ active, disabled }) => (
                            <button
                                type="button"
                                onClick={item.onClick}
                                disabled={item.disabled || disabled}
                                className={clsx(
                                    "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm",
                                    item.variant === "danger"
                                        ? active
                                            ? "bg-red-500/20 text-red-400"
                                            : "text-red-400"
                                        : active
                                          ? "bg-slate-700 text-slate-100"
                                          : "text-slate-300",
                                    (item.disabled || disabled) && "cursor-not-allowed opacity-50"
                                )}
                            >
                                {item.icon}
                                {item.label}
                            </button>
                        )}
                    </MenuItem>
                ))}
            </MenuItems>
        </Menu>
    );
}