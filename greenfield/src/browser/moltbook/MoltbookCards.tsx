import { MessageSquare, Star, UserRound, UsersRound } from "lucide-react";

import type {
    MoltbookFeedPost,
    MoltbookHome,
    MoltbookOwnComment,
    MoltbookOwnPost,
    MoltbookProfile,
} from "../../contracts/moltbook.ts";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { ExternalLink } from "../ui/ExternalLink.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";
import {
    formatMoltbookTime,
    moltbookCommentUrl,
    moltbookPostUrl,
    moltbookProfileUrl,
    moltbookSubmoltUrl,
    truncateMoltbookText,
} from "./moltbookPresentation.ts";

function MoltbookVoteCounts({
    downvotes,
    upvotes,
}: Readonly<{ downvotes: number; upvotes: number }>) {
    return (
        <>
            <span aria-label={`${upvotes} upvotes`}>
                <span aria-hidden="true">↑ </span>
                {upvotes}
            </span>{" "}
            ·{" "}
            <span aria-label={`${downvotes} downvotes`}>
                <span aria-hidden="true">↓ </span>
                {downvotes}
            </span>
        </>
    );
}

export function MoltbookProfileCard({
    home,
    profile,
}: Readonly<{ home: MoltbookHome; profile: MoltbookProfile }>) {
    return (
        <Card className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <ExternalLink
                aria-label={`Open ${profile.displayName} on Moltbook`}
                className="bg-accent-500/15 flex size-14 shrink-0 items-center justify-center rounded-full no-underline"
                href={moltbookProfileUrl(profile.name)}
                showIcon={false}
            >
                <Icon icon={UserRound} size="lg" tone="accent" />
            </ExternalLink>
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <ExternalLink
                        className="text-lg font-semibold wrap-break-word no-underline"
                        href={moltbookProfileUrl(profile.name)}
                    >
                        {profile.displayName}
                    </ExternalLink>
                    {home.unreadMessageCount > 0 && (
                        <Badge variant="danger">
                            {home.unreadMessageCount} unread messages
                        </Badge>
                    )}
                    {home.unreadNotificationCount > 0 && (
                        <Badge variant="warning">
                            {home.unreadNotificationCount} unread notifications
                        </Badge>
                    )}
                </div>
                <Text className="mt-1 wrap-break-word" tone="muted">
                    {profile.description || `@${profile.name}`}
                </Text>
                <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
                    <Text as="span" className="inline-flex items-center gap-1">
                        <Icon icon={Star} size="sm" tone="warning" />
                        <strong>{profile.karma}</strong> karma
                    </Text>
                    <Text as="span" className="inline-flex items-center gap-1">
                        <Icon icon={UsersRound} size="sm" />
                        <strong>{profile.followerCount}</strong> followers
                    </Text>
                    <Text as="span" className="inline-flex items-center gap-1">
                        <Icon icon={UserRound} size="sm" />
                        <strong>{profile.followingCount}</strong> following
                    </Text>
                </div>
            </div>
        </Card>
    );
}

export function MoltbookFeedPostCard({ post }: Readonly<{ post: MoltbookFeedPost }>) {
    const score = post.upvotes - post.downvotes;
    return (
        <Card className="flex gap-4">
            <Badge className="h-fit shrink-0" variant={score >= 0 ? "info" : "danger"}>
                {score}
            </Badge>
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <ExternalLink
                        className="text-xs"
                        href={moltbookSubmoltUrl(post.submoltName)}
                    >
                        m/{post.submoltName}
                    </ExternalLink>
                    <Text as="span" size="sm" tone="muted">
                        ·
                    </Text>
                    <ExternalLink
                        className="text-xs"
                        href={moltbookProfileUrl(post.author.name)}
                    >
                        {post.author.displayName ?? post.author.name}
                    </ExternalLink>
                    <Text as="span" size="sm" tone="muted">
                        · {formatMoltbookTime(post.createdAtMs)}
                    </Text>
                </div>
                <ExternalLink
                    className="mt-2 block no-underline"
                    href={moltbookPostUrl(post.id)}
                    showIcon={false}
                >
                    <Heading className="wrap-break-word" level={2} size="subsection">
                        {post.title}
                    </Heading>
                    {post.contentPreview !== "" && (
                        <Text className="mt-1 line-clamp-3 wrap-break-word" tone="muted">
                            {post.contentPreview}
                        </Text>
                    )}
                </ExternalLink>
                <ExternalLink className="mt-3 text-xs" href={moltbookPostUrl(post.id)}>
                    <Icon icon={MessageSquare} size="sm" tone="inherit" />
                    {post.commentCount} comments
                </ExternalLink>
            </div>
        </Card>
    );
}

export function MoltbookOwnPostCard({ post }: Readonly<{ post: MoltbookOwnPost }>) {
    return (
        <Card>
            <div className="flex flex-wrap items-center gap-2">
                <ExternalLink
                    className="text-xs"
                    href={moltbookSubmoltUrl(post.submoltName)}
                >
                    m/{post.submoltName}
                </ExternalLink>
                <Text as="span" size="sm" tone="muted">
                    · {formatMoltbookTime(post.createdAtMs)}
                </Text>
            </div>
            <ExternalLink
                className="mt-2 block no-underline"
                href={moltbookPostUrl(post.id)}
                showIcon={false}
            >
                <Heading className="wrap-break-word" level={2} size="subsection">
                    {post.title}
                </Heading>
                {post.contentPreview !== "" && (
                    <Text className="mt-1 line-clamp-3 wrap-break-word" tone="muted">
                        {post.contentPreview}
                    </Text>
                )}
            </ExternalLink>
            <Text className="mt-3" size="sm" tone="muted">
                <MoltbookVoteCounts downvotes={post.downvotes} upvotes={post.upvotes} /> ·{" "}
                {post.commentCount} comments
            </Text>
        </Card>
    );
}

export function MoltbookOwnCommentCard({
    comment,
}: Readonly<{ comment: MoltbookOwnComment }>) {
    return (
        <Card>
            <Text size="sm" tone="muted">
                Commented on{" "}
                <ExternalLink href={moltbookPostUrl(comment.post.id)}>
                    {comment.post.title}
                </ExternalLink>{" "}
                · {formatMoltbookTime(comment.createdAtMs)}
            </Text>
            <ExternalLink
                className="mt-3 block no-underline"
                href={moltbookCommentUrl(comment.post.id, comment.id)}
                showIcon={false}
            >
                <Text className="wrap-break-word">
                    {truncateMoltbookText(comment.content)}
                </Text>
            </ExternalLink>
            <Text className="mt-3" size="sm" tone="muted">
                <MoltbookVoteCounts
                    downvotes={comment.downvotes}
                    upvotes={comment.upvotes}
                />
            </Text>
        </Card>
    );
}
