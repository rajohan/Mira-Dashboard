import { type ReactNode } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { Home, CheckSquare, Users, FileText, Activity, FolderOpen, MessageSquare, Settings } from "lucide-react";
import { cn } from "../../utils/cn";

const navItems = [
    { to: "/", icon: Home, label: "Dashboard" },
    { to: "/tasks", icon: CheckSquare, label: "Tasks" },
    { to: "/sessions", icon: Users, label: "Sessions" },
    { to: "/logs", icon: FileText, label: "Logs" },
    { to: "/files", icon: FolderOpen, label: "Files" },
    { to: "/metrics", icon: Activity, label: "Metrics" },
    { to: "/moltbook", icon: MessageSquare, label: "Moltbook" },
    { to: "/settings", icon: Settings, label: "Settings" },
];

interface LayoutProps {
    children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
    const location = useLocation();

    return (
        <div className="min-h-screen bg-primary-900 text-primary-50 flex">
            <aside className="w-64 bg-primary-800 border-r border-primary-700 flex flex-col">
                <div className="p-4 border-b border-primary-700">
                    <h1 className="text-xl font-bold flex items-center gap-2">
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
                                    "flex items-center gap-3 px-3 py-2 rounded-lg mb-1 transition-colors",
                                    isActive
                                        ? "bg-accent-500 text-white"
                                        : "text-primary-300 hover:bg-primary-700 hover:text-primary-50"
                                )}
                            >
                                <item.icon size={20} />
                                <span>{item.label}</span>
                            </Link>
                        );
                    })}
                </nav>

                <div className="p-4 border-t border-primary-700">
                    <div className="text-xs text-primary-400">
                        <div>OpenClaw Dashboard</div>
                        <div className="text-primary-500">v1.0.0</div>
                    </div>
                </div>
            </aside>

            <main className="flex-1 overflow-auto">
                {children}
            </main>
        </div>
    );
}