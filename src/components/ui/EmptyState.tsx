import { Card } from "./Card";

interface EmptyStateProps {
    message?: string;
    children?: React.ReactNode;
}

export function EmptyState({ message = "No items found.", children }: EmptyStateProps) {
    return (
        <Card className="p-6 text-center text-slate-400">
            <p>{message}</p>
            {children}
        </Card>
    );
}
