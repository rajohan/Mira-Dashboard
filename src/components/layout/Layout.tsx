import { Link, useLocation } from "@tanstack/react-router";
import {
    Boxes,
    CheckSquare,
    Clock3,
    Database,
    FileText,
    FolderOpen,
    GitPullRequest,
    Home,
    MessageSquare,
    Settings,
    Terminal,
    Users,
    X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";

import { useCacheEntry, usePullRequests } from "../../hooks";
import { cn } from "../../utils/cn";
import { AppHeader } from "./AppHeader";

const navItems = [
    { to: "/", icon: Home, label: "Dashboard" },
    { to: "/tasks", icon: CheckSquare, label: "Tasks" },
    { to: "/agents", icon: Users, label: "Agents" },
    { to: "/sessions", icon: MessageSquare, label: "Sessions" },
    { to: "/chat", icon: MessageSquare, label: "Chat" },
    { to: "/logs", icon: FileText, label: "Logs" },
    { to: "/cron", icon: Clock3, label: "Cron" },
    { to: "/pull-requests", icon: GitPullRequest, label: "PRs" },
    { to: "/files", icon: FolderOpen, label: "Files" },
    { to: "/docker", icon: Boxes, label: "Docker" },
    { to: "/database", icon: Database, label: "Database" },
    { to: "/moltbook", icon: MessageSquare, label: "Moltbook" },
    { to: "/terminal", icon: Terminal, label: "Terminal" },
    { to: "/settings", icon: Settings, label: "Settings" },
];

/** Describes layout props. */
interface LayoutProps {
    children: ReactNode;
}

/** Describes system host cache. */
interface SystemHostCache {
    version?: {
        current?: string;
    };
}

/** Renders the layout UI. */
export function Layout({ children }: LayoutProps) {
    const location = useLocation();
    const sidebarId = useId();
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const { data: systemHost } = useCacheEntry<SystemHostCache>("system.host", 60_000);
    const { data: pullRequests = [] } = usePullRequests();
    const openClawVersion = systemHost?.data.version?.current;
    const openPullRequestCount = pullRequests.length;

    useEffect(() => {
        setIsSidebarOpen(false);
    }, [location.pathname]);

    const sidebar = (
        <aside
            id={sidebarId}
            className={cn(
                "border-primary-700 bg-primary-950 fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r shadow-2xl shadow-black/40 transition-transform duration-200 ease-out md:static md:z-auto md:w-64 md:max-w-none md:translate-x-0 md:shadow-none",
                isSidebarOpen ? "translate-x-0" : "-translate-x-full"
            )}
        >
            <div className="border-primary-700 flex items-center justify-between gap-3 border-b p-4">
                <h1 className="flex items-center gap-2 text-lg font-bold sm:text-xl">
                    <span className="text-2xl">👩‍💻</span>
                    <span>Mira Dashboard</span>
                </h1>
                <button
                    type="button"
                    className="text-primary-300 hover:bg-primary-800 hover:text-primary-50 rounded-lg p-2 transition-colors md:hidden"
                    aria-label="Close navigation menu"
                    onClick={() => setIsSidebarOpen(false)}
                >
                    <X size={20} />
                </button>
            </div>

            <nav className="flex-1 p-2" aria-label="Main navigation">
                {navItems.map((item) => {
                    const isActive = location.pathname === item.to;
                    return (
                        <Link
                            key={item.to}
                            to={item.to}
                            className={cn(
                                "mb-1 flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 transition-colors",
                                isActive
                                    ? "bg-accent-500/90 text-white"
                                    : "text-primary-300 hover:bg-primary-800 hover:text-primary-50"
                            )}
                        >
                            <item.icon size={20} aria-hidden="true" />
                            <span>{item.label}</span>
                            {item.to === "/pull-requests" && openPullRequestCount > 0 ? (
                                <span
                                    className={cn(
                                        "ml-auto min-w-5 rounded-full px-1.5 py-0.5 text-center text-xs font-semibold",
                                        isActive
                                            ? "bg-white/20 text-white"
                                            : "bg-accent-500/20 text-accent-200"
                                    )}
                                    aria-label={`${openPullRequestCount} open pull requests`}
                                >
                                    {openPullRequestCount}
                                </span>
                            ) : null}
                        </Link>
                    );
                })}
            </nav>

            <div className="border-primary-700 border-t p-4">
                <div className="text-primary-400 text-xs">
                    <div>OpenClaw</div>
                    <div className="text-primary-500">
                        {openClawVersion ? `v${openClawVersion}` : "Version unknown"}
                    </div>
                </div>
            </div>
        </aside>
    );

    return (
        <div className="bg-primary-900 text-primary-50 flex h-screen overflow-hidden">
            {sidebar}
            {isSidebarOpen && (
                <button
                    type="button"
                    className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm md:hidden"
                    aria-label="Close navigation menu"
                    onClick={() => setIsSidebarOpen(false)}
                />
            )}

            <main className="bg-primary-900 flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppHeader
                    title={
                        navItems.find((item) => item.to === location.pathname)?.label ||
                        "Mira Dashboard"
                    }
                    isSidebarOpen={isSidebarOpen}
                    sidebarId={sidebarId}
                    onOpenSidebar={() => setIsSidebarOpen(true)}
                />
                <div className="min-h-0 flex-1 overflow-auto">{children}</div>
            </main>
        </div>
    );
}
