import { Card } from "./Card";

/** Provides props for empty state. */
interface EmptyStateProperties {
    message?: string;
    children?: React.ReactNode;
}

/** Renders the empty state UI. */
export function EmptyState({
    message = "No items found.",
    children,
}: EmptyStateProperties) {
    return (
        <Card className="p-6 text-center text-primary-400">
            <p>{message}</p>
            {children}
        </Card>
    );
}
