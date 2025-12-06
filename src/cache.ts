import { NoteTypes } from "src/review-deck";

export const CACHE_VERSION = 1;

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
    outgoingLinks: string[];
    mtime: number;
}

export interface ReviewCache {
    version: number;
    vaultPath: string;
    noteCount: number;
    notes: Record<string, CachedNote>;
    pageranks: {
        scores: Record<string, number>;
        isStale: boolean;
    };
    settings: {
        tagsToReview: string[];
        noteFoldersToIgnore: string[];
    };
    lastUpdate: number;
}
