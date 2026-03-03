import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../utils/cn";

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
        <Menu>
            <MenuButton
                className={cn(
                    "inline-flex w-full items-center justify-center gap-1 rounded-lg border border-slate-600 bg-slate-700 px-3 py-1.5 text-sm font-medium text-slate-100",
                    "data-hover:bg-slate-600 data-focus:outline-none data-focus:ring-2 data-focus:ring-accent-500",
                    className
                )}
            >
                {typeof trigger === "string" ? (
                    <>
                        {trigger}
                        <ChevronDown className="h-4 w-4 ui-open:rotate-180 transition-transform" />
                    </>
                ) : (
                    trigger
                )}
            </MenuButton>

            <MenuItems
                anchor={align === "right" ? "bottom end" : "bottom start"}
                className="z-50 mt-1 min-w-[160px] origin-top-right rounded-lg border border-slate-600 bg-slate-800 p-1 shadow-lg outline-none focus:outline-none"
            >
                {items.map((item, index) => (
                    <MenuItem key={index} disabled={item.disabled}>
                        {({ active }) => (
                            <button
                                type="button"
                                onClick={item.onClick}
                                className={cn(
                                    "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm",
                                    item.variant === "danger"
                                        ? active
                                            ? "bg-red-500/20 text-red-400"
                                            : "text-red-400"
                                        : active
                                          ? "bg-slate-700 text-slate-100"
                                          : "text-slate-300",
                                    item.disabled && "cursor-not-allowed opacity-50"
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