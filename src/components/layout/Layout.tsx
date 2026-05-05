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
} from "lucide-react";
import { type ReactNode } from "react";

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

    return (
        <div className="flex h-screen overflow-hidden bg-primary-900 text-primary-50">
            <aside className="flex w-64 flex-col overflow-y-auto border-r border-primary-700 bg-primary-950">
                <div className="border-b border-primary-700 p-4">
                    <h1 className="flex items-center gap-2 text-xl font-bold">
                        <span className="text-2xl">👩‍💻</span>
                        <span>Mira Dashboard</span>
                    </h1>
                </div>

                <nav className="flex-1 p-2">
                    {navItems.map((item) => {
                        const isActive = location.pathname === item.to;
                        return (
                            <Link
                                key={item.to}
                                to={item.to}
                                className={cn(
                                    "mb-1 flex items-center gap-3 rounded-lg px-3 py-2 transition-colors",
                                    isActive
                                        ? "bg-accent-500/90 text-white"
                                        : "text-primary-300 hover:bg-primary-800 hover:text-primary-50"
                                )}
                            >
                                <item.icon size={20} />
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

            <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-primary-900">
                <AppHeader
                    title={
                        navItems.find((item) => item.to === location.pathname)?.label ||
                        "Mira Dashboard"
                    }
                />
                <div className="min-h-0 flex-1 overflow-auto">{children}</div>
            </main>
        </div>
    );
}
