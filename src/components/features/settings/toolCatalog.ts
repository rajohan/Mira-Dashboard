import type { LucideIcon } from "lucide-react";
import {
    BookOpen,
    Bot,
    Camera,
    Code2,
    Database,
    Download,
    FileText,
    Folder,
    Globe,
    Image,
    Mail,
    MessageSquare,
    Mic,
    Monitor,
    Music,
    Search,
    Shield,
    Terminal,
    Video,
    Wrench,
} from "lucide-react";

/** Defines tool risk. */
export type ToolRisk = "read" | "standard" | "elevated" | "critical";

/** Represents tool catalog item. */
export interface ToolCatalogItem {
    id: string;
    label: string;
    description: string;
    risk: ToolRisk;
    icon: LucideIcon;
}

/** Defines tool catalog. */
export const TOOL_CATALOG: ToolCatalogItem[] = [
    {
        id: "web_search",
        label: "Web Search",
        description: "Search the internet for real-time information and data",
        risk: "read",
        icon: Globe,
    },
    {
        id: "web_fetch",
        label: "Web Fetch",
        description: "Fetch and extract readable content from URLs",
        risk: "read",
        icon: Search,
    },
    {
        id: "memory_search",
        label: "Memory Search",
        description: "Query internal memory, documents, and embeddings",
        risk: "read",
        icon: BookOpen,
    },
    {
        id: "read",
        label: "File Read",
        description: "Read files in the configured workspace",
        risk: "read",
        icon: FileText,
    },
    {
        id: "browser",
        label: "Browser Automation",
        description: "Control browser pages and inspect web UIs",
        risk: "standard",
        icon: Monitor,
    },
    {
        id: "image",
        label: "Image Analysis",
        description: "Analyze screenshots and other images",
        risk: "standard",
        icon: Image,
    },
    {
        id: "pdf",
        label: "PDF Analysis",
        description: "Analyze PDF documents",
        risk: "standard",
        icon: FileText,
    },
    {
        id: "sessions_list",
        label: "Session List",
        description: "Inspect visible OpenClaw sessions",
        risk: "standard",
        icon: Bot,
    },
    {
        id: "sessions_history",
        label: "Session History",
        description: "Read history from visible sessions",
        risk: "standard",
        icon: MessageSquare,
    },
    {
        id: "write",
        label: "File Write",
        description: "Create or overwrite workspace files",
        risk: "elevated",
        icon: Folder,
    },
    {
        id: "edit",
        label: "File Edit",
        description: "Patch existing workspace files",
        risk: "elevated",
        icon: Code2,
    },
    {
        id: "exec",
        label: "Shell Commands",
        description: "Execute terminal commands",
        risk: "elevated",
        icon: Terminal,
    },
    {
        id: "message",
        label: "Messages",
        description: "Send messages through configured providers",
        risk: "elevated",
        icon: Mail,
    },
    {
        id: "image_generate",
        label: "Image Generation",
        description: "Generate and edit images via AI models",
        risk: "standard",
        icon: Image,
    },
    {
        id: "video_generate",
        label: "Video Generation",
        description: "Generate videos via AI models",
        risk: "standard",
        icon: Video,
    },
    {
        id: "music_generate",
        label: "Music Generation",
        description: "Generate music and audio tracks",
        risk: "standard",
        icon: Music,
    },
    {
        id: "tts",
        label: "Text to Speech",
        description: "Generate voice/audio replies",
        risk: "standard",
        icon: Mic,
    },
    {
        id: "cron",
        label: "Scheduled Jobs",
        description: "Create and manage reminders and background jobs",
        risk: "elevated",
        icon: Wrench,
    },
    {
        id: "nodes",
        label: "Paired Nodes",
        description: "Interact with paired devices, screens, and notifications",
        risk: "elevated",
        icon: Camera,
    },
    {
        id: "file_fetch",
        label: "Node File Fetch",
        description: "Retrieve files from paired nodes",
        risk: "elevated",
        icon: Download,
    },
    {
        id: "database",
        label: "Database Queries",
        description: "Inspect or query connected databases",
        risk: "elevated",
        icon: Database,
    },
    {
        id: "gateway",
        label: "Gateway Control",
        description: "Change OpenClaw configuration and restart/update gateway",
        risk: "critical",
        icon: Shield,
    },
];

/** Defines tool risk labels. */
export const TOOL_RISK_LABELS: Record<ToolRisk, string> = {
    read: "Read-only",
    standard: "Standard",
    elevated: "Elevated",
    critical: "Critical",
};
