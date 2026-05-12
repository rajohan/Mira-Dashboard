import { AlertTriangle } from "lucide-react";
import type { FallbackProps } from "react-error-boundary";

import { Button } from "./Button";

export function AppErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
    return (
        <div className="flex min-h-screen items-center justify-center p-6">
            <div className="bg-primary-900 text-primary-100 w-full max-w-xl rounded-xl border border-red-500/40 p-6">
                <div className="mb-3 flex items-center gap-2 text-red-300">
                    <AlertTriangle className="h-5 w-5" />
                    <h1 className="text-lg font-semibold">
                        Something went wrong in the dashboard
                    </h1>
                </div>

                <p className="text-primary-300 mb-4 text-sm">
                    Try reloading this view. If the error persists, check the console.
                </p>

                <pre className="bg-primary-950/70 mb-4 max-h-40 overflow-auto rounded p-3 text-xs text-red-200">
                    {error instanceof Error ? error.message : "Unknown error"}
                </pre>

                <div className="flex gap-2">
                    <Button variant="secondary" onClick={resetErrorBoundary}>
                        Try again
                    </Button>
                    <Button variant="ghost" onClick={() => window.location.reload()}>
                        Full reload
                    </Button>
                </div>
            </div>
        </div>
    );
}
