import { useQuery } from "@tanstack/react-query";

import { getHome, getFeed, type MoltbookPost, type MoltbookHome } from "../api/moltbook";

import type { MiraProfile, MiraContent } from "../types/moltbook";

// Types
interface ProfileResponse {
    agent?: MiraProfile;
}

interface MyContentResponse {
    posts?: MiraContent;
}

// Query keys
export const moltbookKeys = {
    home: (): ["moltbook", "home"] => ["moltbook", "home"],
    feed: (sort: "hot" | "new"): ["moltbook", "feed", string] => ["moltbook", "feed", sort],
    profile: (): ["moltbook", "profile"] => ["moltbook", "profile"],
    myContent: (): ["moltbook", "myContent"] => ["moltbook", "myContent"],
};

// Fetchers
async function fetchProfile(): Promise<MiraProfile | null> {
    const res = await fetch("/api/moltbook/profile");
    if (!res.ok) throw new Error("Failed to fetch profile");
    const data: ProfileResponse = await res.json();
    return data.agent || null;
}

async function fetchMyContent(): Promise<MiraContent | null> {
    const res = await fetch("/api/moltbook/my-posts");
    if (!res.ok) throw new Error("Failed to fetch content");
    const data: MyContentResponse = await res.json();
    return data.posts || null;
}

// Hooks
export function useMoltbookHome() {
    return useQuery({
        queryKey: moltbookKeys.home(),
        queryFn: getHome,
        staleTime: 60_000, // 1 minute
    });
}

export function useMoltbookFeed(sort: "hot" | "new" = "hot") {
    return useQuery({
        queryKey: moltbookKeys.feed(sort),
        queryFn: () => getFeed(sort),
        staleTime: 30_000, // 30 seconds
    });
}

export function useMoltbookProfile() {
    return useQuery({
        queryKey: moltbookKeys.profile(),
        queryFn: fetchProfile,
        staleTime: 300_000, // 5 minutes
    });
}

export function useMoltbookMyContent() {
    return useQuery({
        queryKey: moltbookKeys.myContent(),
        queryFn: fetchMyContent,
        staleTime: 60_000,
    });
}

// Combined hook for Moltbook page
export function useMoltbookData(sort: "hot" | "new" = "hot") {
    const home = useMoltbookHome();
    const feed = useMoltbookFeed(sort);
    const profile = useMoltbookProfile();
    const myContent = useMoltbookMyContent();

    const isLoading = home.isLoading || feed.isLoading || profile.isLoading || myContent.isLoading;
    const error = home.error || feed.error || profile.error || myContent.error;

    return {
        home: home.data,
        posts: feed.data || [],
        profile: profile.data,
        myContent: myContent.data,
        isLoading,
        error: error?.message || null,
        refetch: () => {
            home.refetch();
            feed.refetch();
            profile.refetch();
            myContent.refetch();
        },
    };
}

export type { MoltbookPost, MoltbookHome };