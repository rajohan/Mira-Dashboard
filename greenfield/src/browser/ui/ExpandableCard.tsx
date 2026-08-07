import { Disclosure, DisclosureButton, DisclosurePanel } from "@headlessui/react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Card } from "./Card.tsx";
import { cn } from "./classNames.ts";
import { Icon } from "./Icon.tsx";

interface ExpandableCardProps {
    readonly children: ReactNode | ((open: boolean) => ReactNode);
    readonly className?: string;
    readonly defaultOpen?: boolean;
    readonly description?: ReactNode;
    readonly icon?: LucideIcon;
    readonly title: ReactNode;
}

/**
 * Renders a Headless UI disclosure inside a shared content card.
 * @returns An accessible expandable card with keyboard-managed disclosure state.
 */
export function ExpandableCard({
    children,
    className,
    defaultOpen = false,
    description,
    icon,
    title,
}: ExpandableCardProps) {
    return (
        <Card className={cn("p-0", className)}>
            <Disclosure defaultOpen={defaultOpen}>
                {({ open }) => (
                    <>
                        <DisclosureButton className="group focus-visible:ring-accent-400 flex w-full items-start justify-between gap-4 p-5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset">
                            <span className="flex min-w-0 items-start gap-3">
                                {icon !== undefined && (
                                    <Icon
                                        className="mt-0.5 shrink-0"
                                        icon={icon}
                                        tone="accent"
                                    />
                                )}
                                <span className="min-w-0">
                                    <span className="text-primary-100 block font-semibold">
                                        {title}
                                    </span>
                                    {description !== undefined && (
                                        <span className="text-primary-400 mt-1 block text-sm leading-6">
                                            {description}
                                        </span>
                                    )}
                                </span>
                            </span>
                            <Icon
                                className="mt-0.5 shrink-0 transition-transform group-data-open:rotate-180"
                                icon={ChevronDown}
                            />
                        </DisclosureButton>
                        <DisclosurePanel
                            className="border-primary-700 border-t p-5 transition duration-150 data-closed:-translate-y-1 data-closed:opacity-0"
                            transition
                        >
                            {typeof children === "function" ? children(open) : children}
                        </DisclosurePanel>
                    </>
                )}
            </Disclosure>
        </Card>
    );
}
