import type { ReactNode } from "react";

interface PageStateProps {
    isLoading?: boolean;
    loading?: ReactNode;
    error?: string | null;
    errorView?: ReactNode;
    isEmpty?: boolean;
    empty?: ReactNode;
    children: ReactNode;
}

export function PageState({
    isLoading = false,
    loading,
    error,
    errorView,
    isEmpty = false,
    empty,
    children,
}: PageStateProps) {
    if (isLoading) {
        return <>{loading ?? null}</>;
    }

    if (error) {
        return <>{errorView ?? null}</>;
    }

    if (isEmpty) {
        return <>{empty ?? null}</>;
    }

    return <>{children}</>;
}
