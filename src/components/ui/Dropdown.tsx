import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { ChevronDown } from "lucide-react";

import { cn } from "../../utils/cn";

/** Describes dropdown item. */
export interface DropdownItem {
    label: string;
    onClick?: () => void;
    icon?: React.ReactNode;
    variant?: "default" | "danger";
    disabled?: boolean;
}

/** Describes dropdown props. */
interface DropdownProps {
    label?: string;
    icon?: React.ReactNode;
    items?: DropdownItem[];
    content?: React.ReactNode;
    align?: "left" | "right";
    variant?: "primary" | "secondary" | "ghost";
    size?: "sm" | "md";
}

/** Renders the dropdown UI. */
export function Dropdown({
    label,
    icon,
    items = [],
    content,
    align = "right",
    variant = "secondary",
    size = "sm",
}: DropdownProps) {
    const variantStyles = {
        primary: "bg-accent-500 text-white hover:bg-accent-600",
        secondary:
            "border border-primary-600 bg-primary-700 text-primary-100 hover:bg-primary-600",
        ghost: "text-primary-300 hover:bg-primary-700",
    };

    const sizeStyles = {
        sm: "px-2 py-1 text-sm",
        md: "px-4 py-2 text-sm",
    };

    return (
        <Menu as="div">
            <MenuButton
                className={cn(
                    "inline-flex items-center justify-center gap-1 rounded-lg font-medium outline-none",
                    "focus:outline-none data-[focus]:outline-none",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    variantStyles[variant],
                    sizeStyles[size]
                )}
            >
                {icon}
                {label}
                {label && (
                    <ChevronDown className="h-4 w-4 transition-transform data-[open]:rotate-180" />
                )}
            </MenuButton>

            <MenuItems
                anchor={align === "right" ? "bottom end" : "bottom start"}
                className="border-primary-600 bg-primary-800 z-50 mt-1 min-w-[160px] origin-top-right rounded-lg border p-1 shadow-lg outline-none focus:outline-none data-[focus]:outline-none"
            >
                {content ||
                    items.map((item, index) => (
                        <MenuItem key={index} disabled={item.disabled}>
                            <button
                                type="button"
                                onClick={item.onClick}
                                className={cn(
                                    "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                                    "hover:bg-primary-700 hover:text-primary-100 data-[focus]:bg-primary-700 data-[focus]:text-primary-100 outline-none focus:outline-none data-[focus]:outline-none",
                                    "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
                                    item.variant === "danger"
                                        ? "text-red-400 hover:bg-red-500/20 data-[focus]:bg-red-500/20"
                                        : "text-primary-300"
                                )}
                            >
                                {item.icon}
                                {item.label}
                            </button>
                        </MenuItem>
                    ))}
            </MenuItems>
        </Menu>
    );
}
