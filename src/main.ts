// TODO:
// - remove flashcard references
// - remove pageranks
// - gut/simplify Locale support

import {
    Notice,
    Plugin,
    TAbstractFile,
    TFile,
    TFolder,
    getAllTags,
    FrontMatterCache,
} from "obsidian";

import { log_debug, setLogDebugMode } from "src/logger";

import { SRSettingTab, SRSettings, DEFAULT_SETTINGS } from "src/settings";
import { DueTodayView, DUE_TODAY_VIEW_TYPE } from "src/due-today-view";
import {
    ReviewResponse,
    calculateDueDate,
    schedule,
    generatePostponeInterval,
} from "src/scheduling";
import { ReviewDeck, ReviewDeckSelectionModal, SchedNote, NoteTypes } from "src/review-deck";
import { RescheduleBacklogModal } from "src/reschedule";
import { t } from "src/lang/helpers";
import { appIcon } from "src/icons/appicon";
import { ReviewCache, CachedNote, CACHE_VERSION } from "src/cache";

interface PluginData {
    settings: SRSettings;
    historyDeck: string | null;
}

const DEFAULT_DATA: PluginData = {
    settings: DEFAULT_SETTINGS,
    historyDeck: null,
};


export default class SRPlugin extends Plugin {
    private statusBar: HTMLElement;
    private dueTodayView: DueTodayView;
    public data: PluginData;

    public reviewDecks: { [deckKey: string]: ReviewDeck } = {};
    public lastSelectedReviewDeck: string;

    public newNotes: TFile[] = [];
    public scheduledNotes: SchedNote[] = [];
    private dueNotesCount = 0;
    public dueDatesNotes: Record<number, number> = {}; // Record<# of days in future, due count>

    // Cache-related properties
    private cache: ReviewCache | null = null;
    private cacheSaveTimer: number = 0;

    async onload(): Promise<void> {
        await this.loadPluginData();

        appIcon();

        this.statusBar = this.addStatusBarItem();
        this.statusBar.classList.add("mod-clickable");
        this.statusBar.setAttribute("aria-label", t("OPEN_NOTE_FOR_REVIEW"));
        this.statusBar.setAttribute("aria-label-position", "top");
        this.statusBar.addEventListener("click", async () => {
            this.reviewNextNoteModal();
        });
        // Configure debug logging based on current setting
        setLogDebugMode(this.data.settings.showDebugMessages);

        if (!this.data.settings.disableFileMenuReviewOptions) {
            this.registerEvent(
                this.app.workspace.on("file-menu", (menu, fileish: TAbstractFile) => {
                    if (fileish instanceof TFile && fileish.extension === "md") {
                        menu.addItem((item) => {
                            item.setTitle(t("REVIEW_EASY_FILE_MENU"))
                                .setIcon("SpacedRepIcon")
                                .onClick(() => {
                                    this.saveReviewResponse(fileish, ReviewResponse.Easy);
                                });
                        });

                        menu.addItem((item) => {
                            item.setTitle(t("REVIEW_GOOD_FILE_MENU"))
                                .setIcon("SpacedRepIcon")
                                .onClick(() => {
                                    this.saveReviewResponse(fileish, ReviewResponse.Good);
                                });
                        });

                        menu.addItem((item) => {
                            item.setTitle(t("REVIEW_HARD_FILE_MENU"))
                                .setIcon("SpacedRepIcon")
                                .onClick(() => {
                                    this.saveReviewResponse(fileish, ReviewResponse.Hard);
                                });
                        });
                    } else if (fileish instanceof TFolder) {
                        menu.addItem((item) => {
                            item.setTitle("Review All Cards in Folder")
                                .setIcon("SpacedRepIcon")
                                .onClick(async () => {
                                    await this.reviewFolderCards(fileish);
                                });
                        });
                    }
                }),
            );
        }

        // Register cache event handlers for incremental updates
        this.registerEvent(
            this.app.metadataCache.on("changed", (file) => {
                if (file instanceof TFile) {
                    this.onFileMetadataChanged(file);
                }
            }),
        );

        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                if (file instanceof TFile) {
                    this.onFileDeleted(file);
                }
            }),
        );

        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                if (file instanceof TFile) {
                    this.onFileRenamed(file, oldPath);
                }
            }),
        );

        this.registerEvent(
            this.app.vault.on("create", (file) => {
                if (file instanceof TFile) {
                    this.onFileCreated(file);
                }
            }),
        );

        this.addCommand({
            id: "srs-note-review-open-note",
            name: t("OPEN_NOTE_FOR_REVIEW"),
            callback: async () => {
                this.reviewNextNoteModal();
            },
        });

        this.addCommand({
            id: "reschedule-backlog",
            name: "Reschedule Backlog",
            callback: () => {
                this.openRescheduleBacklogModal();
            },
        });

        this.addCommand({
            id: "srs-note-review-postpone",
            name: t("POSTPONE_NOTE_CMD"),
            callback: () => {
                const openFile: TFile | null = this.app.workspace.getActiveFile();
                if (openFile && openFile.extension === "md") {
                    this.saveReviewResponse(openFile, ReviewResponse.Postpone);
                }
            },
        });

        this.addCommand({
            id: "srs-note-review-postpone-long",
            name: t("POSTPONE_LONG_NOTE_CMD"),
            callback: () => {
                const openFile: TFile | null = this.app.workspace.getActiveFile();
                if (openFile && openFile.extension === "md") {
                    this.saveReviewResponse(openFile, ReviewResponse.PostponeLong);
                }
            },
        });

        this.addCommand({
            id: "srs-note-review-skip",
            name: t("SKIP_NOTE_CMD"),
            callback: () => {
                if (this.lastSelectedReviewDeck) {
                    this.reviewDecks[this.lastSelectedReviewDeck].currentIndex++;
                    this.reviewDecks[this.lastSelectedReviewDeck].dueNotesCount--;
                    this.reviewNextNote(this.lastSelectedReviewDeck);
                }
            },
        });

        this.addCommand({
            id: "srs-note-review-sync",
            name: "Rebuild deck index",
            callback: async () => {
                await this.sync(false, false); // Use cache if available
            },
        });

        this.addCommand({
            id: "srs-note-review-force-rebuild-cache",
            name: "Force Rebuild Cache",
            callback: async () => {
                await this.invalidateCache();
                await this.sync(false, true);
                new Notice("Cache rebuilt successfully");
            },
        });

        this.addCommand({
            id: "srs-note-review-easy",
            name: t("REVIEW_NOTE_EASY_CMD"),
            callback: () => {
                const openFile: TFile | null = this.app.workspace.getActiveFile();
                if (openFile && openFile.extension === "md") {
                    this.saveReviewResponse(openFile, ReviewResponse.Easy);
                }
            },
        });

        this.addCommand({
            id: "srs-note-review-good",
            name: t("REVIEW_NOTE_GOOD_CMD"),
            callback: () => {
                const openFile: TFile | null = this.app.workspace.getActiveFile();
                if (openFile && openFile.extension === "md") {
                    this.saveReviewResponse(openFile, ReviewResponse.Good);
                }
            },
        });

        this.addCommand({
            id: "srs-note-review-hard",
            name: t("REVIEW_NOTE_HARD_CMD"),
            callback: () => {
                const openFile: TFile | null = this.app.workspace.getActiveFile();
                if (openFile && openFile.extension === "md") {
                    this.saveReviewResponse(openFile, ReviewResponse.Hard);
                }
            },
        });

        this.addCommand({
            id: "srs-note-review-reset",
            name: t("RESET_NOTE_CMD"),
            callback: () => {
                const openFile: TFile | null = this.app.workspace.getActiveFile();
                if (openFile && openFile.extension === "md") {
                    this.resetNoteReview(openFile);
                }
            },
        });

        this.addCommand({
            id: "srs-note-review-high-interval",
            name: "Review High-Interval Notes",
            callback: async () => {
                await this.reviewHighIntervalNotes();
            },
        });

        this.addCommand({
            id: "srs-note-review-most-overdue",
            name: "Review Most Overdue Notes",
            callback: async () => {
                await this.reviewMostOverdueNotes();
            },
        });

        this.addCommand({
            id: "srs-open-due-today-view",
            name: t("DUE_TODAY_OPEN_CMD"),
            callback: () => {
                this.openDueTodayView();
            },
        });

        this.addSettingTab(new SRSettingTab(this.app, this));

        this.app.workspace.onLayoutReady(() => {
            this.initView();
            setTimeout(async () => {
                await this.sync();
            }, 2000);
        });
    }

    onunload(): void {
        this.app.workspace.getLeavesOfType(DUE_TODAY_VIEW_TYPE).forEach((leaf) => leaf.detach());
    }

    async sync(ignoreStats = false, forceFullRebuild = false): Promise<void> {
        const startTime = Date.now();

        // Try to load cache if not already loaded
        if (!this.cache && !forceFullRebuild) {
            this.cache = await this.loadCache();
        }

        if (this.cache && !forceFullRebuild) {
            // FAST PATH: Use cache
            log_debug("[Sync] Using cached data");
            await this.syncFromCache();
        } else {
            // SLOW PATH: Full rebuild
            log_debug("[Sync] Full rebuild (no cache or forced)");
            await this.syncFullRebuild();
            await this.saveCache();
        }

        log_debug(`[Sync] Completed in ${Date.now() - startTime}ms`);

        // Update UI
        this.updateStatusBar();
        const dueTodayLeaves = this.app.workspace.getLeavesOfType(DUE_TODAY_VIEW_TYPE);
        if (dueTodayLeaves.length > 0 && this.dueTodayView) {
            this.dueTodayView.redraw();
        }
    }

    private updateStatusBar(): void {
        // Check if lastSelectedReviewDeck still exists (it might be a temporary folder deck)
        if (
            this.lastSelectedReviewDeck &&
            Object.prototype.hasOwnProperty.call(this.reviewDecks, this.lastSelectedReviewDeck)
        ) {
            this.statusBar.setText(
                `${this.lastSelectedReviewDeck}: ${this.reviewDecks[this.lastSelectedReviewDeck].dueNotesCount} due`,
            );
        } else {
            // Clear lastSelectedReviewDeck if it no longer exists (e.g., temporary folder deck)
            this.lastSelectedReviewDeck = null;
            // Note that this.dueNotesCount is the total due
            this.statusBar.setText(`All: ${this.dueNotesCount} due`);
        }
    }

    private async syncFromCache(): Promise<void> {
        const now = window.moment(Date.now());

        // Reset review decks
        this.reviewDecks = {};
        this.dueNotesCount = 0;
        this.dueDatesNotes = {};

        // Rebuild decks from cache
        for (const [path, cachedNote] of Object.entries(this.cache.notes)) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                // File no longer exists, will be cleaned up by next full sync
                continue;
            }

            // Add to appropriate review decks
            if (cachedNote.reviewTags.length === 0) {
                continue; // Not a review note
            }

            for (const reviewTag of cachedNote.reviewTags) {
                if (!this.reviewDecks[reviewTag]) {
                    this.reviewDecks[reviewTag] = new ReviewDeck(reviewTag);
                }

                const deck = this.reviewDecks[reviewTag];

                if (!cachedNote.scheduling) {
                    // New note
                    deck.newNotes.push(file);
                } else {
                    // Scheduled note
                    const dueUnix = window.moment(cachedNote.scheduling.srDue).valueOf();
                    deck.scheduledNotes.push({
                        note: file,
                        dueUnix,
                        ease: cachedNote.scheduling.srEase,
                        noteType: cachedNote.scheduling.noteType,
                        interval: cachedNote.scheduling.srInterval,
                        rebalance: cachedNote.scheduling.rebalance,
                    });

                    if (dueUnix <= now.valueOf()) {
                        deck.dueNotesCount++;
                        this.dueNotesCount++;
                    }

                    // Update due dates histogram
                    const nDays = Math.ceil((dueUnix - now.valueOf()) / (24 * 3600 * 1000));
                    if (!this.dueDatesNotes[nDays]) {
                        this.dueDatesNotes[nDays] = 0;
                    }
                    this.dueDatesNotes[nDays]++;
                }
            }
        }

        // Sort decks
        for (const deckKey in this.reviewDecks) {
            this.reviewDecks[deckKey].sortNewNotes();
            this.reviewDecks[deckKey].sortScheduledNotes();
        }
    }

    private async syncFullRebuild(): Promise<void> {
        // Initialize fresh cache
        this.cache = {
            version: CACHE_VERSION,
            vaultPath: this.app.vault.getRoot().path,
            noteCount: 0,
            notes: {},
            settings: {
                tagsToReview: [...this.data.settings.tagsToReview],
                noteFoldersToIgnore: [...this.data.settings.noteFoldersToIgnore],
            },
            lastUpdate: Date.now(),
        };

        // Reset everything
        this.reviewDecks = {};
        this.dueNotesCount = 0;
        this.dueDatesNotes = {};

        const now = window.moment(Date.now());
        // Phase 1: Build cache
        const notes: TFile[] = this.app.vault.getMarkdownFiles();
        for (const note of notes) {
            if (this.isFileIgnored(note.path)) {
                continue;
            }

            // Build cached note
            const cachedNote = await this.buildCachedNote(note);
            this.cache.notes[note.path] = cachedNote;
        }

        // Phase 2: Build review decks from cache
        for (const cachedNote of Object.values(this.cache.notes)) {
            if (cachedNote.reviewTags.length === 0) {
                continue;
            }

            const file = this.app.vault.getAbstractFileByPath(cachedNote.path);
            if (!(file instanceof TFile)) {
                continue;
            }

            for (const reviewTag of cachedNote.reviewTags) {
                if (!this.reviewDecks[reviewTag]) {
                    log_debug(`[Sync] Creating new deck for tag: ${reviewTag}`);
                    this.reviewDecks[reviewTag] = new ReviewDeck(reviewTag);
                }

                const deck = this.reviewDecks[reviewTag];

                if (!cachedNote.scheduling) {
                    // New note
                    deck.newNotes.push(file);
                } else {
                    // Scheduled note
                    const dueUnix = window.moment(cachedNote.scheduling.srDue).valueOf();
                    deck.scheduledNotes.push({
                        note: file,
                        dueUnix,
                        ease: cachedNote.scheduling.srEase,
                        noteType: cachedNote.scheduling.noteType,
                        interval: cachedNote.scheduling.srInterval,
                        rebalance: cachedNote.scheduling.rebalance,
                    });

                    if (dueUnix <= now.valueOf()) {
                        deck.dueNotesCount++;
                        this.dueNotesCount++;
                    }

                    const nDays = Math.ceil((dueUnix - now.valueOf()) / (24 * 3600 * 1000));
                    if (!this.dueDatesNotes[nDays]) {
                        this.dueDatesNotes[nDays] = 0;
                    }
                    this.dueDatesNotes[nDays]++;
                }
            }
        }

        // Phase 3: Sort decks
        log_debug(`[Sync] Sorting ${Object.keys(this.reviewDecks).length} decks...`);
        for (const deckKey in this.reviewDecks) {
            this.reviewDecks[deckKey].sortNewNotes();
            this.reviewDecks[deckKey].sortScheduledNotes();
        }

        this.cache.noteCount = Object.keys(this.cache.notes).length;
    }

    async saveReviewResponse(note: TFile, response: ReviewResponse): Promise<void> {
        const fileCachedData = this.app.metadataCache.getFileCache(note) || {};
        const frontmatter: FrontMatterCache | Record<string, unknown> =
            fileCachedData.frontmatter || {};

        const tags = getAllTags(fileCachedData) || [];
        if (this.data.settings.noteFoldersToIgnore.some((folder) => note.path.startsWith(folder))) {
            new Notice(t("NOTE_IN_IGNORED_FOLDER"));
            return;
        }

        let shouldIgnore = true;
        for (const tag of tags) {
            if (
                this.data.settings.tagsToReview.some(
                    (tagToReview) => tag === tagToReview || tag.startsWith(tagToReview + "/"),
                )
            ) {
                shouldIgnore = false;
                break;
            }
        }

        if (shouldIgnore) {
            new Notice(t("PLEASE_TAG_NOTE"));
            return;
        }

        let noteIsNew = false;

        let ease: number, interval: number, delayBeforeReview: number;
        const now: number = Date.now();
        // new note
        if (
            !(
                Object.prototype.hasOwnProperty.call(frontmatter, "sr-due") &&
                Object.prototype.hasOwnProperty.call(frontmatter, "sr-interval") &&
                Object.prototype.hasOwnProperty.call(frontmatter, "sr-ease")
            )
        ) {
            noteIsNew = true;
            if (Object.prototype.hasOwnProperty.call(frontmatter, "sr-type")) {
                let sr_type: string = frontmatter["sr-type"];
                if (sr_type === "geometric") {
                    interval = 1;
                    ease = -this.data.settings.geometricNoteFactor;
                    delayBeforeReview = 0;
                } else if (sr_type == "periodic") {
                    if (Object.prototype.hasOwnProperty.call(frontmatter, "sr-interval")) {
                        interval = frontmatter["sr-interval"];
                    } else {
                        interval = this.data.settings.periodicNoteDefaultInterval;
                    }
                    ease = 0;
                    delayBeforeReview = 0;
                } else {
                    new Notice("sr-type attribute can only be geometric or periodic");
                    return;
                }
            } else {
                let linkTotal = 0,
                    linkPGTotal = 0,
                    totalLinkCount = 0;

                const linkContribution: number =
                    this.data.settings.maxLinkFactor *
                    Math.min(1.0, Math.log(totalLinkCount + 0.5) / Math.log(64));
                ease =
                    (1.0 - linkContribution) * this.data.settings.baseEase +
                    (totalLinkCount > 0
                        ? (linkContribution * linkTotal) / linkPGTotal
                        : linkContribution * this.data.settings.baseEase);

                ease = Math.round(ease);
                interval = 1.0;
                delayBeforeReview = 0;
            }
        } else {
            interval = frontmatter["sr-interval"];
            ease = frontmatter["sr-ease"];
            delayBeforeReview =
                now -
                window
                    .moment(frontmatter["sr-due"], ["YYYY-MM-DD", "DD-MM-YYYY", "ddd MMM DD YYYY"])
                    .valueOf();
        }

        if (response == ReviewResponse.Postpone) {
            // This injects jitter into the rescheduling process, so that you
            // don't postpone every card onto the same day

            // Note that if you set interval here, you override interval in the
            // note, which is not what we want
            // 10 days base with a random offset of [-5, 5]
            const postpone_interval = generatePostponeInterval(interval, 10, 5);
            var due = calculateDueDate(postpone_interval, this.data.settings.scheduleWeekends);
            log_debug("Postponing for " + postpone_interval + " days");
        } else if (response == ReviewResponse.PostponeLong) {
            // This injects jitter into the rescheduling process, so that you
            // don't postpone every card onto the same day
            // Note that if you set interval here, you override interval in the
            // note, which is not what we want
            // 25 days base with an offset of [-7, 7]
            const postpone_interval = generatePostponeInterval(interval, 25, 7);
            var due = calculateDueDate(postpone_interval, this.data.settings.scheduleWeekends);
            log_debug("Postponing for " + postpone_interval + " days");
        } else {
            const schedObj: Record<string, number> = schedule(
                response,
                interval,
                ease,
                delayBeforeReview,
                this.data.settings,
                this.dueDatesNotes,
            );
            interval = schedObj.interval;
            ease = schedObj.ease;

            let intervalWithJitter = interval;

            // Add some jitter for initially scheduled notes and always for geometric
            // notes so that we don't get them all stacked up at once. E.g.,
            // geometric notes in particular are particularly prone to being stacked up
            // as they will progress on the same sequence.
            if (noteIsNew || ease < 0) {
                let variationWindow = 5; // [0,5] variation around the actual
                // due date.
                if (ease < 0) {
                    // for now, doubling the variation window for geometric notes
                    variationWindow *= 2;
                }

                let jitter = Math.round(Math.random() * variationWindow);

                log_debug("Adding jitter to note schedule: " + jitter);

                intervalWithJitter = interval + jitter;
            }

            // Note that we're scheduling due date with the potentially jittered
            // interval, without impacting the actual interval itself.
            var due = calculateDueDate(intervalWithJitter, this.data.settings.scheduleWeekends);
        }

        const dueString: string = due.format("YYYY-MM-DD");

        // Auto-mark reviewed logic
        const isPostpone =
            response === ReviewResponse.Postpone || response === ReviewResponse.PostponeLong;
        const newNoteType =
            ease < 0 ? NoteTypes.GEOMETRIC : ease === 0 ? NoteTypes.PERIODIC : NoteTypes.STANDARD;
        const typeSettingEnabled =
            (newNoteType === NoteTypes.STANDARD && this.data.settings.autoMarkReviewedStandard) ||
            (newNoteType === NoteTypes.PERIODIC && this.data.settings.autoMarkReviewedPeriodic) ||
            (newNoteType === NoteTypes.GEOMETRIC && this.data.settings.autoMarkReviewedGeometric);
        const withinIntervalThreshold = interval <= this.data.settings.autoMarkReviewedThresholdDays;
        const dueDateThreshold = this.data.settings.autoMarkReviewedDueDateThresholdDays;
        const withinDueDateThreshold = due.diff(window.moment().startOf("day"), "days") <= dueDateThreshold;
        const perNoteOptOut: boolean = frontmatter["sr-no-auto-review"] === true;
        const shouldAutoMarkReviewed =
            !isPostpone && typeSettingEnabled && withinIntervalThreshold && withinDueDateThreshold && !perNoteOptOut;
        const todayString: string = window.moment().format("YYYY-MM-DD");

        // Update frontmatter using Obsidian's API
        await this.app.fileManager.processFrontMatter(note, (frontmatter) => {
            frontmatter["sr-interval"] = interval;
            frontmatter["sr-due"] = dueString;
            frontmatter["sr-ease"] = ease;
            if (shouldAutoMarkReviewed) {
                frontmatter["reviewed"] = todayString;
            }
        });

        new Notice(t("RESPONSE_RECEIVED"));

        // Check if we should advance to next note BEFORE updating deck data
        // (since sorting will change the order)
        let shouldAdvance = false;
        if (this.lastSelectedReviewDeck) {
            const currentDeck = this.reviewDecks[this.lastSelectedReviewDeck];
            // We only want to advance if we're currently looking at a note in sequence.
            if (
                currentDeck.scheduledNotes[currentDeck.currentIndex] &&
                note.name === currentDeck.scheduledNotes[currentDeck.currentIndex].note.name
            ) {
                shouldAdvance = true;
                currentDeck.currentIndex++;
                currentDeck.dueNotesCount--;
            }
        }

        // Update in-memory deck data to avoid needing a full sync on deck change
        const newDueUnix = due.valueOf();

        // Update the note in all decks that contain it
        for (const deckKey in this.reviewDecks) {
            const deck = this.reviewDecks[deckKey];
            const noteIndex = deck.scheduledNotes.findIndex((sn) => sn.note.path === note.path);

            if (noteIndex !== -1) {
                const oldDueUnix = deck.scheduledNotes[noteIndex].dueUnix;
                const wasOverdue = oldDueUnix <= now;
                const isNowOverdue = newDueUnix <= now;

                // Update the note's data
                deck.scheduledNotes[noteIndex].dueUnix = newDueUnix;
                deck.scheduledNotes[noteIndex].ease = ease;
                deck.scheduledNotes[noteIndex].interval = interval;
                deck.scheduledNotes[noteIndex].noteType = newNoteType;

                // Update due counts if status changed
                if (wasOverdue && !isNowOverdue) {
                    // Note is no longer overdue
                    if (deckKey === this.lastSelectedReviewDeck) {
                        // dueNotesCount already decremented above
                    } else {
                        deck.dueNotesCount--;
                    }
                    this.dueNotesCount--;
                } else if (!wasOverdue && isNowOverdue) {
                    // Note became overdue (shouldn't normally happen)
                    deck.dueNotesCount++;
                    this.dueNotesCount++;
                }

                // Re-sort the deck to maintain proper order
                deck.sortScheduledNotes();
            }
        }

        // Update status bar to reflect new count
        this.updateStatusBar();

        // Advance to next note if auto-advance is enabled
        if (shouldAdvance && this.data.settings.autoNextNote) {
            await this.reviewNextNote(this.lastSelectedReviewDeck);
        }
    }

    async resetNoteReview(note: TFile): Promise<void> {
        // Remove all sr-* properties from frontmatter using Obsidian's API
        await this.app.fileManager.processFrontMatter(note, (frontmatter) => {
            // Delete all keys that start with "sr-"
            for (const key of Object.keys(frontmatter)) {
                if (key.startsWith("sr-")) {
                    delete frontmatter[key];
                }
            }
        });

        new Notice(t("NOTE_RESET"));
    }

    async reviewNextNoteModal(): Promise<void> {
        const reviewDeckNames: string[] = Object.keys(this.reviewDecks);
        if (reviewDeckNames.length === 1) {
            this.reviewNextNote(reviewDeckNames[0]);
        } else {
            const deckSelectionModal = new ReviewDeckSelectionModal(this.app, reviewDeckNames);
            deckSelectionModal.submitCallback = (deckKey: string) => this.reviewNextNote(deckKey);
            deckSelectionModal.open();
        }
    }

    openRescheduleBacklogModal() {
        new RescheduleBacklogModal(this.app, this.reviewDecks).open();
    }

    async reviewNextNote(deckKey: string): Promise<void> {
        if (!Object.prototype.hasOwnProperty.call(this.reviewDecks, deckKey)) {
            new Notice(t("NO_DECK_EXISTS", { deckName: deckKey }));
            return;
        }

        if (this.lastSelectedReviewDeck != deckKey) {
            this.lastSelectedReviewDeck = deckKey;

            // Update status bar for the new deck
            const newDeck = this.reviewDecks[deckKey];
            this.statusBar.setText(`${deckKey}: ${newDeck.dueNotesCount} due`);

            // Reset current index when switching decks
            newDeck.currentIndex = 0;
        }

        const deck = this.reviewDecks[deckKey];

        log_debug("[Review] Deck due notes count: " + deck.dueNotesCount);
        log_debug("[Review] Current index into sync'd list: " + deck.currentIndex);

        if (deck.dueNotesCount > 0) {
            const index = this.data.settings.openRandomNote
                ? Math.floor(Math.random() * deck.dueNotesCount)
                : Math.min(deck.currentIndex, deck.dueNotesCount - 1);
            log_debug(
                "[Review] Attempting next note open: due notes, index: " +
                    index +
                    ", note: " +
                    deck.scheduledNotes[index].note.basename,
            );
            await this.app.workspace.getLeaf().openFile(deck.scheduledNotes[index].note);
            return;
        }

        if (deck.newNotes.length > 0) {
            const index = this.data.settings.openRandomNote
                ? Math.floor(Math.random() * deck.newNotes.length)
                : deck.currentIndex;
            await this.app.workspace.getLeaf().openFile(deck.newNotes[index]);
            return;
        }

        new Notice(t("ALL_CAUGHT_UP"));
    }

    private collectFolderNotes(folder: TFolder, recursive = true): TFile[] {
        const folderNotes: TFile[] = [];

        const collectFiles = (currentFolder: TFolder) => {
            for (const file of currentFolder.children) {
                if (file instanceof TFile && file.extension === "md") {
                    // Check if this file is in an ignored folder
                    if (
                        this.data.settings.noteFoldersToIgnore.some((ignoredFolder) =>
                            file.path.startsWith(ignoredFolder),
                        )
                    ) {
                        continue;
                    }

                    // Check if file is a review card
                    const fileCached = this.app.metadataCache.getFileCache(file) || {};
                    const tags = getAllTags(fileCached) || [];

                    const isReviewCard = tags.some((tag) =>
                        this.data.settings.tagsToReview.some(
                            (tagToReview) =>
                                tag === tagToReview || tag.startsWith(tagToReview + "/"),
                        ),
                    );

                    if (isReviewCard) {
                        folderNotes.push(file);
                    }
                } else if (recursive && file instanceof TFolder) {
                    collectFiles(file); // Recursion for subfolders
                }
            }
        };

        collectFiles(folder);
        return folderNotes;
    }

    private async reviewFolderCards(folder: TFolder): Promise<void> {
        const folderNotes = this.collectFolderNotes(folder);

        if (folderNotes.length === 0) {
            new Notice("No review cards found in this folder");
            return;
        }

        // Create temporary deck key
        const tempDeckKey = `__folder:${folder.path}`;

        // Create review deck
        const tempDeck = new ReviewDeck(tempDeckKey);

        // Populate with folder notes
        const now = window.moment(Date.now());
        for (const note of folderNotes) {
            const fileCachedData = this.app.metadataCache.getFileCache(note) || {};
            const frontmatter: FrontMatterCache | Record<string, unknown> =
                fileCachedData.frontmatter || {};

            if (
                Object.prototype.hasOwnProperty.call(frontmatter, "sr-due") &&
                Object.prototype.hasOwnProperty.call(frontmatter, "sr-interval") &&
                Object.prototype.hasOwnProperty.call(frontmatter, "sr-ease")
            ) {
                // Scheduled note
                const dueUnix = window
                    .moment(frontmatter["sr-due"], ["YYYY-MM-DD", "DD-MM-YYYY", "ddd MMM DD YYYY"])
                    .valueOf();

                const ease: number = frontmatter["sr-ease"];
                const interval: number = frontmatter["sr-interval"];

                let noteType = NoteTypes.STANDARD;
                if (ease < 0) {
                    noteType = NoteTypes.GEOMETRIC;
                } else if (ease === 0) {
                    noteType = NoteTypes.PERIODIC;
                }

                const tags = getAllTags(fileCachedData) || [];
                let rebalance = true;
                if (tags.some((tag) => tag === "#no-rebalance")) {
                    rebalance = false;
                }

                tempDeck.scheduledNotes.push({
                    note,
                    dueUnix,
                    ease,
                    noteType,
                    interval,
                    rebalance,
                });

                if (dueUnix <= now.valueOf()) {
                    tempDeck.dueNotesCount++;
                }
            } else {
                // New note
                tempDeck.newNotes.push(note);
            }
        }

        // Sort the deck
        tempDeck.sortNewNotes();
        tempDeck.sortScheduledNotes();

        // Temporarily add to decks and review
        this.reviewDecks[tempDeckKey] = tempDeck;

        new Notice(
            `Starting review: ${tempDeck.dueNotesCount} due, ${tempDeck.newNotes.length} new (${folderNotes.length} total)`,
        );

        await this.reviewNextNote(tempDeckKey);
    }

    private async reviewHighIntervalNotes(): Promise<void> {
        const threshold = this.data.settings.highIntervalThreshold;
        const now = window.moment(Date.now());
        const nowUnix = now.valueOf();

        // Create temporary deck key
        const tempDeckKey = `__highInterval:${threshold}+`;

        // Create review deck
        const tempDeck = new ReviewDeck(tempDeckKey);

        // Collect high-interval due notes from all decks
        const seenPaths = new Set<string>();

        for (const deckKey in this.reviewDecks) {
            const deck = this.reviewDecks[deckKey];

            for (const sNote of deck.scheduledNotes) {
                // Skip if we've already added this note (could be in multiple decks)
                if (seenPaths.has(sNote.note.path)) {
                    continue;
                }

                // Only include notes that are due and have interval >= threshold
                if (sNote.dueUnix <= nowUnix && sNote.interval >= threshold) {
                    seenPaths.add(sNote.note.path);
                    tempDeck.scheduledNotes.push({
                        note: sNote.note,
                        dueUnix: sNote.dueUnix,
                        ease: sNote.ease,
                        noteType: sNote.noteType,
                        interval: sNote.interval,
                        rebalance: sNote.rebalance,
                    });
                    tempDeck.dueNotesCount++;
                }
            }
        }

        if (tempDeck.scheduledNotes.length === 0) {
            new Notice(`No due notes with interval >= ${threshold} days`);
            return;
        }

        // Sort the deck
        tempDeck.sortScheduledNotes();

        // Temporarily add to decks and review
        this.reviewDecks[tempDeckKey] = tempDeck;

        new Notice(
            `Starting high-interval review: ${tempDeck.dueNotesCount} notes with interval >= ${threshold} days`,
        );

        await this.reviewNextNote(tempDeckKey);
    }


    private async reviewMostOverdueNotes(): Promise<void> {
        const threshold = this.data.settings.mostOverdueThreshold;
        const now = window.moment(Date.now());
        const nowUnix = now.valueOf();
        const thresholdMs = threshold * 24 * 3600 * 1000;

        // Create temporary deck key
        const tempDeckKey = `__mostOverdue:${threshold}+`;

        // Create review deck
        const tempDeck = new ReviewDeck(tempDeckKey);

        // Collect overdue notes from all decks
        const seenPaths = new Set<string>();

        for (const deckKey in this.reviewDecks) {
            const deck = this.reviewDecks[deckKey];

            for (const sNote of deck.scheduledNotes) {
                // Skip if we've already added this note (could be in multiple decks)
                if (seenPaths.has(sNote.note.path)) {
                    continue;
                }

                // Only include notes that are overdue by at least threshold days
                if (nowUnix - sNote.dueUnix >= thresholdMs) {
                    seenPaths.add(sNote.note.path);
                    tempDeck.scheduledNotes.push({
                        note: sNote.note,
                        dueUnix: sNote.dueUnix,
                        ease: sNote.ease,
                        noteType: sNote.noteType,
                        interval: sNote.interval,
                        rebalance: sNote.rebalance,
                    });
                    tempDeck.dueNotesCount++;
                }
            }
        }

        if (tempDeck.scheduledNotes.length === 0) {
            new Notice(`No notes overdue by ${threshold}+ days`);
            return;
        }

        // Sort oldest-due first (most overdue at the front)
        tempDeck.sortScheduledNotes();

        // Temporarily add to decks and review
        this.reviewDecks[tempDeckKey] = tempDeck;

        new Notice(
            `Starting most-overdue review: ${tempDeck.dueNotesCount} notes overdue by ${threshold}+ days`,
        );

        await this.reviewNextNote(tempDeckKey);
    }

    // Cache Management Methods

    private getCacheFilePath(): string {
        return `${this.manifest.dir}/cache.json`;
    }

    async loadCache(): Promise<ReviewCache | null> {
        try {
            const cacheFile = this.getCacheFilePath();
            const data = await this.app.vault.adapter.read(cacheFile);
            const cache: ReviewCache = JSON.parse(data);

            // Validate structure
            if (!cache.version || !cache.notes) {
                log_debug("[Cache] Corrupted cache structure, invalidating");
                return null;
            }

            // Validate cache
            if (!this.isCacheValid(cache)) {
                return null;
            }

            log_debug(`[Cache] Loaded cache with ${Object.keys(cache.notes).length} notes`);
            return cache;
        } catch (error) {
            log_debug("[Cache] Error loading cache, will rebuild: " + error.message);
            return null;
        }
    }

    async saveCache(): Promise<void> {
        if (!this.cache) return;

        clearTimeout(this.cacheSaveTimer);
        this.cacheSaveTimer = window.setTimeout(async () => {
            try {
                const cacheFile = this.getCacheFilePath();
                this.cache.lastUpdate = Date.now();
                await this.app.vault.adapter.write(cacheFile, JSON.stringify(this.cache));
                log_debug("[Cache] Saved successfully");
            } catch (error) {
                log_debug("[Cache] Error saving cache: " + error.message);
            }
        }, 2000);
    }

    async invalidateCache(): Promise<void> {
        this.cache = null;
        try {
            const cacheFile = this.getCacheFilePath();
            await this.app.vault.adapter.remove(cacheFile);
            log_debug("[Cache] Invalidated and deleted");
        } catch (error) {
            log_debug("[Cache] No cache file to delete");
        }
    }

    isCacheValid(cache: ReviewCache): boolean {
        // Version check
        if (cache.version !== CACHE_VERSION) {
            log_debug("[Cache] Version mismatch, invalidating");
            return false;
        }

        // Vault path check
        if (cache.vaultPath !== this.app.vault.getRoot().path) {
            log_debug("[Cache] Vault path changed, invalidating");
            return false;
        }

        // Settings check
        if (
            !this.arraysEqual(cache.settings.tagsToReview, this.data.settings.tagsToReview) ||
            !this.arraysEqual(
                cache.settings.noteFoldersToIgnore,
                this.data.settings.noteFoldersToIgnore,
            )
        ) {
            log_debug("[Cache] Settings changed, invalidating");
            return false;
        }

        // Note count sanity check
        const currentNoteCount = this.app.vault.getMarkdownFiles().length;
        const cachedNoteCount = Object.keys(cache.notes).length;
        const countDelta = Math.abs(currentNoteCount - cachedNoteCount);

        if (countDelta > 100 || countDelta > currentNoteCount * 0.1) {
            log_debug(
                `[Cache] Note count mismatch (current: ${currentNoteCount}, cached: ${cachedNoteCount}), invalidating`,
            );
            return false;
        }

        return true;
    }

    private arraysEqual(a: string[], b: string[]): boolean {
        if (a.length !== b.length) return false;
        const sortedA = [...a].sort();
        const sortedB = [...b].sort();
        return sortedA.every((val, index) => val === sortedB[index]);
    }

    async buildCachedNote(file: TFile): Promise<CachedNote> {
        const fileCachedData = this.app.metadataCache.getFileCache(file) || {};
        const frontmatter: FrontMatterCache | Record<string, unknown> =
            fileCachedData.frontmatter || {};
        const tags = getAllTags(fileCachedData) || [];

        // Determine review tags
        const reviewTags = this.data.settings.tagsToReview.filter((tagToReview) =>
            tags.some((tag) => tag === tagToReview || tag.startsWith(tagToReview + "/")),
        );

        // Extract scheduling info
        let scheduling = null;
        if (
            Object.prototype.hasOwnProperty.call(frontmatter, "sr-due") &&
            Object.prototype.hasOwnProperty.call(frontmatter, "sr-interval") &&
            Object.prototype.hasOwnProperty.call(frontmatter, "sr-ease")
        ) {
            const ease = frontmatter["sr-ease"] as number;
            let noteType = NoteTypes.STANDARD;
            if (ease < 0) {
                noteType = NoteTypes.GEOMETRIC;
            } else if (ease === 0) {
                noteType = NoteTypes.PERIODIC;
            }

            const rebalance = !tags.some((tag) => tag === "#no-rebalance");

            scheduling = {
                srDue: frontmatter["sr-due"] as string,
                srInterval: frontmatter["sr-interval"] as number,
                srEase: ease,
                noteType,
                rebalance,
            };
        }

        return {
            path: file.path,
            tags,
            reviewTags,
            scheduling,
            mtime: file.stat.mtime,
        };
    }

    private isFileIgnored(path: string): boolean {
        return this.data.settings.noteFoldersToIgnore.some((folder) => path.startsWith(folder));
    }

    // Event Handlers for Incremental Cache Updates

    private async onFileMetadataChanged(file: TFile): Promise<void> {
        if (!this.cache || file.extension !== "md") return;

        // Check if in ignored folder
        if (this.isFileIgnored(file.path)) {
            // Was it previously cached? Remove it
            if (this.cache.notes[file.path]) {
                delete this.cache.notes[file.path];
                await this.saveCache();
            }
            return;
        }

        // Update cached note
        const cachedNote = await this.buildCachedNote(file);
        this.cache.notes[file.path] = cachedNote;

        // Schedule cache save
        await this.saveCache();
    }

    private async onFileDeleted(file: TFile): Promise<void> {
        if (!this.cache || file.extension !== "md") return;

        const path = file.path;
        if (!this.cache.notes[path]) return;

        // Remove from cache
        delete this.cache.notes[path];

        // Remove from review decks
        for (const deckKey in this.reviewDecks) {
            const deck = this.reviewDecks[deckKey];

            // Remove from newNotes
            deck.newNotes = deck.newNotes.filter((f) => f.path !== path);

            // Remove from scheduledNotes
            const removedScheduled = deck.scheduledNotes.filter((sn) => sn.note.path === path);
            deck.scheduledNotes = deck.scheduledNotes.filter((sn) => sn.note.path !== path);

            // Update due count if was scheduled and due
            const now = Date.now();
            for (const sn of removedScheduled) {
                if (sn.dueUnix <= now) {
                    deck.dueNotesCount--;
                    this.dueNotesCount--;
                }
            }
        }

        // Update status bar
        this.updateStatusBar();

        // Schedule cache save
        await this.saveCache();
    }

    private async onFileRenamed(file: TFile, oldPath: string): Promise<void> {
        if (!this.cache || file.extension !== "md") return;

        const newPath = file.path;
        const oldCachedNote = this.cache.notes[oldPath];

        if (!oldCachedNote) {
            // Wasn't cached, treat as new file
            await this.onFileCreated(file);
            return;
        }

        // Update cache key
        delete this.cache.notes[oldPath];
        this.cache.notes[newPath] = {
            ...oldCachedNote,
            path: newPath,
        };

        // Update review decks in memory
        for (const deckKey in this.reviewDecks) {
            const deck = this.reviewDecks[deckKey];

            // Update in newNotes
            const newIndex = deck.newNotes.findIndex((f) => f.path === oldPath);
            if (newIndex !== -1) {
                deck.newNotes[newIndex] = file;
            }

            // Update in scheduledNotes
            const schedIndex = deck.scheduledNotes.findIndex((sn) => sn.note.path === oldPath);
            if (schedIndex !== -1) {
                deck.scheduledNotes[schedIndex].note = file;
            }
        }

        // Schedule cache save
        await this.saveCache();
    }

    private async onFileCreated(file: TFile): Promise<void> {
        if (!this.cache || file.extension !== "md") return;

        // Wait a bit for metadata to be available
        setTimeout(async () => {
            await this.onFileMetadataChanged(file);
        }, 500);
    }

    async loadPluginData(): Promise<void> {
        this.data = Object.assign({}, DEFAULT_DATA, await this.loadData());
        this.data.settings = Object.assign({}, DEFAULT_SETTINGS, this.data.settings);
    }

    async savePluginData(): Promise<void> {
        await this.saveData(this.data);
    }

    initView(): void {
        this.registerView(
            DUE_TODAY_VIEW_TYPE,
            (leaf) => (this.dueTodayView = new DueTodayView(leaf, this)),
        );
    }

    private openDueTodayView(): void {
        if (this.app.workspace.getLeavesOfType(DUE_TODAY_VIEW_TYPE).length === 0) {
            this.app.workspace.getRightLeaf(false).setViewState({
                type: DUE_TODAY_VIEW_TYPE,
                active: true,
            });
        } else {
            this.app.workspace.revealLeaf(
                this.app.workspace.getLeavesOfType(DUE_TODAY_VIEW_TYPE)[0],
            );
        }
    }
}
