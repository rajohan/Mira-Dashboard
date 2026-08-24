import { lazy, Suspense, useState } from "react";

const LazyPanel = lazy(() => import("./LazyPanel"));

export default function FixtureApp() {
    const [count, setCount] = useState(0);

    return (
        <main className="min-h-screen bg-slate-950 p-6 text-slate-100">
            <button
                className="rounded bg-indigo-600 px-4 py-2 font-semibold"
                onClick={() => setCount((current) => current + 1)}
                type="button"
            >
                Compiler count: {count}
            </button>
            <Suspense fallback={<p className="mt-3">Loading…</p>}>
                <LazyPanel />
            </Suspense>
        </main>
    );
}
