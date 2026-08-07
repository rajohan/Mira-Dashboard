import { Link, Outlet } from "@tanstack/react-router";

/**
 * Renders the persistent Dashboard navigation and route outlet.
 * @returns The accessible application shell.
 */
export function DashboardShell() {
    return (
        <div className="min-h-screen bg-slate-950 text-slate-100">
            <a
                className="sr-only rounded-md bg-blue-500 px-3 py-2 font-semibold text-white focus:not-sr-only"
                href="#dashboard-content"
            >
                Skip to content
            </a>
            <header className="border-b border-slate-800 bg-slate-950/95">
                <div className="mx-auto flex max-w-7xl items-center justify-between p-4 sm:px-6 lg:px-8">
                    <Link
                        activeOptions={{ exact: true }}
                        className="rounded-md text-base font-semibold tracking-tight text-white outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
                        to="/"
                    >
                        Mira Dashboard
                    </Link>
                    <p className="text-sm text-slate-400">Secure operations workspace</p>
                </div>
            </header>
            <main
                className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-8"
                id="dashboard-content"
            >
                <Outlet />
            </main>
        </div>
    );
}

/**
 * Renders the Phase 1 browser entry route.
 * @returns The initial Dashboard overview.
 */
export function OverviewRoute() {
    return (
        <section aria-labelledby="overview-heading" className="max-w-3xl">
            <p className="text-sm font-medium text-blue-300">Dashboard foundation</p>
            <h1
                className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl"
                id="overview-heading"
            >
                Mira Dashboard
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300">
                The secure browser workspace is ready for the rewritten Dashboard
                features.
            </p>
            <output
                aria-label="Application status"
                className="mt-8 block rounded-xl border border-slate-800 bg-slate-900/60 p-5"
            >
                <p className="font-medium text-slate-100">Application shell ready</p>
                <p className="mt-1 text-sm leading-6 text-slate-400">
                    Feature routes will appear here as their contracts and services are
                    completed.
                </p>
            </output>
        </section>
    );
}
