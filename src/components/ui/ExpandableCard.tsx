import { Disclosure, DisclosureButton, DisclosurePanel } from "@headlessui/react";
import { ChevronDown } from "lucide-react";

import { Card, CardTitle } from "../ui/Card";

interface ExpandableCardProps {
    title: string;
    icon: React.ElementType;
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
        <Card variant="bordered" className="mb-4">
            <Disclosure defaultOpen={defaultExpanded}>
                <DisclosureButton className="flex w-full items-center justify-between py-1">
                    <div className="flex items-center gap-2">
                        <Icon size={18} className="text-accent-400" />
                        <CardTitle>{title}</CardTitle>
                    </div>
                    <ChevronDown className="data-[open]:rotate-180 h-[18px] w-[18px] transition-transform" />
                </DisclosureButton>
                <DisclosurePanel className="mt-4 border-t border-primary-700 pt-4">
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
        <div className="flex items-center justify-between py-2">
            <span className="text-sm text-slate-400">{label}</span>
            <span className="font-mono text-sm text-primary-100">
                {value === undefined || value === null ? "—" : String(value)}
            </span>
        </div>
    );
}
