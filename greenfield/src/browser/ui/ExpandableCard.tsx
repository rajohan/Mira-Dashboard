import { Disclosure, DisclosureButton, DisclosurePanel } from "@headlessui/react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef } from "react";

import { cn } from "../lib/classNames.ts";
import { Card } from "./Card.tsx";
import { Icon } from "./Icon.tsx";

interface ExpandableCardBaseProps {
    readonly children: ReactNode | ((open: boolean, close: () => void) => ReactNode);
    readonly className?: string;
    readonly compact?: boolean;
    readonly defaultOpen?: boolean;
    readonly description?: ReactNode;
    readonly icon?: LucideIcon;
    readonly title: ReactNode;
    readonly trailing?: ReactNode;
}

type ExpandableCardProps = ExpandableCardBaseProps &
    (
        | {
              readonly onOpenChange: (open: boolean) => void;
              readonly open: boolean;
          }
        | {
              readonly onOpenChange?: never;
              readonly open?: never;
          }
    );

/**
 * Renders a Headless UI disclosure inside a shared content card.
 * @returns An accessible expandable card with keyboard-managed disclosure state.
 */
export function ExpandableCard({
    children,
    className,
    compact = false,
    defaultOpen = false,
    description,
    icon,
    onOpenChange,
    open,
    title,
    trailing,
}: ExpandableCardProps) {
    const trigger = useRef<HTMLButtonElement>(null);
    const restoreFocusAfterControlledChange = useRef(false);
    const previousControlledOpen = useRef(open);

    useLayoutEffect(() => {
        if (previousControlledOpen.current === open) return;
        previousControlledOpen.current = open;
        if (!restoreFocusAfterControlledChange.current) return;
        restoreFocusAfterControlledChange.current = false;
        trigger.current?.focus();
    }, [open]);

    let disclosureKey = "uncontrolled";
    if (open !== undefined)
        disclosureKey = open ? "controlled-open" : "controlled-closed";

    return (
        <Card
            className={cn(
                "p-0",
                compact && "bg-primary-950/50 overflow-hidden rounded-lg",
                className
            )}
        >
            <Disclosure defaultOpen={open ?? defaultOpen} key={disclosureKey}>
                {({ close, open: disclosureOpen }) => {
                    const closeCard = () => {
                        if (open === undefined) {
                            close();
                            return;
                        }
                        restoreFocusAfterControlledChange.current = true;
                        onOpenChange(false);
                    };
                    return (
                        <>
                            <DisclosureButton
                                className={cn(
                                    "group focus-visible:ring-accent-400 flex w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-inset",
                                    compact
                                        ? "hover:bg-primary-800 data-open:bg-primary-800 min-h-8 items-center gap-2 p-2 text-sm"
                                        : "items-start justify-between gap-4 p-5"
                                )}
                                onClick={(event) => {
                                    if (open === undefined) return;
                                    event.preventDefault();
                                    restoreFocusAfterControlledChange.current = true;
                                    onOpenChange(!open);
                                }}
                                onKeyDown={(event) => {
                                    if (
                                        open === undefined ||
                                        (event.key !== "Enter" && event.key !== " ")
                                    )
                                        return;
                                    event.preventDefault();
                                    restoreFocusAfterControlledChange.current = true;
                                    onOpenChange(!open);
                                }}
                                ref={trigger}
                            >
                                <span
                                    className={cn(
                                        "flex min-w-0",
                                        compact
                                            ? "flex-1 items-center gap-2"
                                            : "items-start gap-3"
                                    )}
                                >
                                    {icon !== undefined && (
                                        <Icon
                                            className={cn(
                                                "shrink-0",
                                                !compact && "mt-0.5"
                                            )}
                                            icon={icon}
                                            size={compact ? "sm" : "md"}
                                            tone="accent"
                                        />
                                    )}
                                    <span className={cn("min-w-0", compact && "flex-1")}>
                                        <span
                                            className={cn(
                                                "text-primary-100 block",
                                                compact
                                                    ? "truncate font-medium"
                                                    : "font-semibold"
                                            )}
                                        >
                                            {title}
                                        </span>
                                        {description !== undefined && (
                                            <span className="text-primary-400 mt-1 block text-sm leading-6">
                                                {description}
                                            </span>
                                        )}
                                    </span>
                                </span>
                                {trailing !== undefined && (
                                    <span className="shrink-0">{trailing}</span>
                                )}
                                <Icon
                                    className={cn(
                                        "shrink-0 transition-transform group-data-open:rotate-180",
                                        !compact && "mt-0.5"
                                    )}
                                    icon={ChevronDown}
                                    size={compact ? "sm" : "md"}
                                />
                            </DisclosureButton>
                            <DisclosurePanel
                                className={cn(
                                    "border-primary-700 border-t transition duration-150 data-closed:-translate-y-1 data-closed:opacity-0",
                                    compact ? "p-3" : "p-5"
                                )}
                                transition
                            >
                                {typeof children === "function"
                                    ? children(disclosureOpen, closeCard)
                                    : children}
                            </DisclosurePanel>
                        </>
                    );
                }}
            </Disclosure>
        </Card>
    );
}
