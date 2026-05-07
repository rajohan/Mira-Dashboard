import { Disclosure, DisclosureButton, DisclosurePanel } from "@headlessui/react";
import { ChevronDown } from "lucide-react";

import { Card, CardTitle } from "../ui/Card";

interface ExpandableCardProps {
    title: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
    children: React.ReactNode;
    defaultExpanded?: boolean;
}

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
                        <Icon size={18} className="shrink-0 text-accent-400" />
                        <CardTitle className="min-w-0 truncate text-base sm:text-lg">
                            {title}
                        </CardTitle>
                    </div>
                    <ChevronDown className="h-[18px] w-[18px] shrink-0 transition-transform data-[open]:rotate-180" />
                </DisclosureButton>
                <DisclosurePanel className="mt-3 border-t border-primary-700 pt-3 sm:mt-4 sm:pt-4">
                    {children}
                </DisclosurePanel>
            </Disclosure>
        </Card>
    );
}

export function ReadOnlyField({
    label,
    value,
}: {
    label: string;
    value?: string | number | boolean;
}) {
    return (
        <div className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <span className="text-sm text-primary-400">{label}</span>
            <span className="break-all font-mono text-sm text-primary-100 sm:text-right">
                {value === undefined || value === null ? "—" : String(value)}
            </span>
        </div>
    );
}
