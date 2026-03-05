import { type ReactNode } from "react";

import { cn } from "../../utils/cn";

interface PageHeaderProps {
    title: string;
    actions?: ReactNode;
    status?: ReactNode;
    className?: string;
}

export function PageHeader({ title, actions, className }: PageHeaderProps) {
    return (
        <div className={cn("mb-6 flex items-center justify-between", className)}>
            <h1 className="text-2xl font-bold">{title}</h1>
            <div className="flex items-center gap-4">{actions}</div>
        </div>
    );
}
