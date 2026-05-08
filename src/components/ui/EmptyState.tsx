import { Card } from "./Card";

interface EmptyStateProps {
    message?: string;
    children?: React.ReactNode;
}

export function EmptyState({ message = "No items found.", children }: EmptyStateProps) {
    return (
        <Card className="text-primary-400 p-6 text-center">
            <p>{message}</p>
            {children}
        </Card>
    );
}
