import { Link, useLocation } from "@tanstack/react-router";
import {
    Boxes,
    CheckSquare,
    Clock3,
    Database,
    FileText,
    FolderOpen,
    Home,
    MessageSquare,
    Settings,
    Terminal,
    Users,
    X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";

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
    { to: "/files", icon: FolderOpen, label: "Files" },
    { to: "/docker", icon: Boxes, label: "Docker" },
    { to: "/database", icon: Database, label: "Database" },
    { to: "/moltbook", icon: MessageSquare, label: "Moltbook" },
    { to: "/terminal", icon: Terminal, label: "Terminal" },
    { to: "/settings", icon: Settings, label: "Settings" },
];

interface LayoutProps {
    children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
    const location = useLocation();
    const sidebarId = useId();
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);

    useEffect(() => {
        setIsSidebarOpen(false);
    }, [location.pathname]);

    const sidebar = (
        <aside
            id={sidebarId}
            className={cn(
                "fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-primary-700 bg-primary-950 shadow-2xl shadow-black/40 transition-transform duration-200 ease-out md:static md:z-auto md:w-64 md:max-w-none md:translate-x-0 md:shadow-none",
                isSidebarOpen ? "translate-x-0" : "-translate-x-full"
            )}
        >
            <div className="flex items-center justify-between gap-3 border-b border-primary-700 p-4">
                <h1 className="flex items-center gap-2 text-lg font-bold sm:text-xl">
                    <span className="text-2xl">👩‍💻</span>
                    <span>Mira Dashboard</span>
                </h1>
                <button
                    type="button"
                    className="rounded-lg p-2 text-primary-300 transition-colors hover:bg-primary-800 hover:text-primary-50 md:hidden"
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
                        </Link>
                    );
                })}
            </nav>

            <div className="border-t border-primary-700 p-4">
                <div className="text-xs text-primary-400">
                    <div>OpenClaw Dashboard</div>
                    <div className="text-primary-500">v1.0.0</div>
                </div>
            </div>
        </aside>
    );

    return (
        <div className="flex h-screen overflow-hidden bg-primary-900 text-primary-50">
            {sidebar}
            {isSidebarOpen && (
                <button
                    type="button"
                    className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm md:hidden"
                    aria-label="Close navigation menu"
                    onClick={() => setIsSidebarOpen(false)}
                />
            )}

            <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-primary-900">
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
