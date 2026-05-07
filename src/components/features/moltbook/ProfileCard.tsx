import { Star, User, Users } from "lucide-react";

import { type MiraProfile } from "../../../types/moltbook";
import { getMoltbookUrl } from "../../../utils/moltbookUtils";

interface ProfileCardProps {
    profile: MiraProfile;
    unreadCount: number;
}

export function ProfileCard({ profile, unreadCount }: ProfileCardProps) {
    return (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
            <a
                href={getMoltbookUrl("/u/mira_2026")}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-indigo-500/20 transition hover:ring-2 hover:ring-indigo-400"
            >
                {profile.avatar_url ? (
                    <img
                        src={profile.avatar_url}
                        alt={profile.name}
                        className="h-full w-full object-cover"
                    />
                ) : (
                    <User className="h-7 w-7 text-indigo-400" />
                )}
            </a>
            <div className="min-w-0 flex-1">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <a
                        href={getMoltbookUrl("/u/mira_2026")}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-words text-lg font-semibold text-primary-100 transition hover:text-indigo-300"
                    >
                        {profile.display_name || profile.name}
                    </a>
                    {unreadCount > 0 && (
                        <span className="w-fit rounded-full bg-red-500/20 px-2 py-0.5 text-xs text-red-400">
                            {unreadCount} new
                        </span>
                    )}
                </div>
                <p className="mt-0.5 line-clamp-3 break-words text-sm text-primary-400 sm:line-clamp-2">
                    {profile.description}
                </p>
                <div className="mt-3 grid gap-2 text-sm sm:flex sm:flex-wrap sm:items-center sm:gap-4">
                    <span className="flex items-center gap-1 text-primary-300">
                        <Star className="h-3.5 w-3.5 text-yellow-400" />
                        <span className="font-medium">{profile.karma}</span>
                        <span className="text-primary-500">karma</span>
                    </span>
                    <span className="flex items-center gap-1 text-primary-300">
                        <Users className="h-3.5 w-3.5" />
                        <span className="font-medium">{profile.follower_count}</span>
                        <span className="text-primary-500">followers</span>
                    </span>
                    <span className="flex items-center gap-1 text-primary-300">
                        <User className="h-3.5 w-3.5" />
                        <span className="font-medium">{profile.following_count}</span>
                        <span className="text-primary-500">following</span>
                    </span>
                </div>
            </div>
        </div>
    );
}
