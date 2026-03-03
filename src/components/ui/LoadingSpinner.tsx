import { Loader2 } from "lucide-react";

export function LoadingSpinner({ size = 8 }: { size?: number }) {
    return (
        <div className="flex h-[calc(100vh-4rem)] items-center justify-center">
            <Loader2
                className={`h-${size} w-${size} animate-spin text-accent-400`}
                style={{ width: size * 4, height: size * 4 }}
            />
        </div>
    );
}