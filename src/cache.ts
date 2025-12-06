import { NoteTypes } from "src/review-deck";

export const CACHE_VERSION = 2; // Bumped version since we removed PageRank

export interface CachedNote {
    path: string;
    tags: string[];
    reviewTags: string[]; // Tags matching tagsToReview setting
    scheduling: {
        srDue: string;
        srInterval: number;
        srEase: number;
        noteType: NoteTypes;
        rebalance: boolean;
    } | null;
    mtime: number;
}

export interface ReviewCache {
    version: number;
    vaultPath: string;
    noteCount: number;
    notes: Record<string, CachedNote>;
    settings: {
        tagsToReview: string[];
        noteFoldersToIgnore: string[];
    };
    lastUpdate: number;
}
