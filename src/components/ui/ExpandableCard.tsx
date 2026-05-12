import { Disclosure, DisclosureButton, DisclosurePanel } from "@headlessui/react";
import { ChevronDown } from "lucide-react";

import { Card, CardTitle } from "../ui/Card";

/** Describes expandable card props. */
interface ExpandableCardProps {
    title: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
    children: React.ReactNode;
    defaultExpanded?: boolean;
}

/** Renders the expandable card UI. */
export function ExpandableCard({
    title,
    icon: Icon,
    children,
    defaultExpanded = false,
}: ExpandableCardProps) {
    return (
        <Card variant="bordered" className="mb-3 p-3 sm:mb-4 sm:p-4">
            <Disclosure defaultOpen={defaultExpanded} as="div">
                <DisclosureButton className="flex w-full items-center justify-between gap-3 py-1 text-left">
                    <div className="flex min-w-0 items-center gap-2">
                        <Icon size={18} className="text-accent-400 shrink-0" />
                        <CardTitle className="min-w-0 truncate text-base sm:text-lg">
                            {title}
                        </CardTitle>
                    </div>
                    <ChevronDown className="h-[18px] w-[18px] shrink-0 transition-transform data-[open]:rotate-180" />
                </DisclosureButton>
                <DisclosurePanel className="border-primary-700 mt-3 border-t pt-3 sm:mt-4 sm:pt-4">
                    {children}
                </DisclosurePanel>
            </Disclosure>
        </Card>
    );
}

/** Renders the read only field UI. */
export function ReadOnlyField({
    label,
    value,
}: {
    label: string;
    value?: string | number | boolean;
}) {
    return (
        <div className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <span className="text-primary-400 text-sm">{label}</span>
            <span className="text-primary-100 font-mono text-sm break-all sm:text-right">
                {value === undefined || value === null ? "—" : String(value)}
            </span>
        </div>
    );
}
