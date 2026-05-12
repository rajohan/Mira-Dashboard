import { Card } from "./Card";

/** Provides props for empty state. */
interface EmptyStateProps {
    message?: string;
    children?: React.ReactNode;
}

/** Renders the empty state UI. */
export function EmptyState({ message = "No items found.", children }: EmptyStateProps) {
    return (
        <Card className="text-primary-400 p-6 text-center">
            <p>{message}</p>
            {children}
        </Card>
    );
}
