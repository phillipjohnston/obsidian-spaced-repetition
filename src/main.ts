// TODO:
// - remove flashcard references
// - remove pageranks
// - gut/simplify Locale support

import {
    Notice,
    Plugin,
    TAbstractFile,
    TFile,
    HeadingCache,
    getAllTags,
    FrontMatterCache,
} from "obsidian";
import * as graph from "pagerank.js";

import { log_debug, setLogDebugMode } from 'src/logger';

import { SRSettingTab, SRSettings, DEFAULT_SETTINGS } from "src/settings";
import { ReviewQueueListView, REVIEW_QUEUE_VIEW_TYPE } from "src/sidebar";
import { Card, CardType, ReviewResponse, schedule } from "src/scheduling";
import {
    YAML_FRONT_MATTER_REGEX,
    SR_INTERVAL_REGEX,
    SR_DUE_REGEX,
    SR_EASE_REGEX
} from "src/constants";
import { escapeRegexString } from "src/utils";
import { ReviewDeck, ReviewDeckSelectionModal, SchedNote, NoteTypes } from "src/review-deck";
import { RescheduleBacklogModal } from "src/reschedule";
import { t } from "src/lang/helpers";
import { parse } from "src/parser";
import { appIcon } from "src/icons/appicon";

interface PluginData {
    settings: SRSettings;
    historyDeck: string | null;
}

const DEFAULT_DATA: PluginData = {
    settings: DEFAULT_SETTINGS,
    historyDeck: null,
};

export interface LinkStat {
    sourcePath: string;
    linkCount: number;
}

export default class SRPlugin extends Plugin {
    private statusBar: HTMLElement;
    private reviewQueueView: ReviewQueueListView;
    public data: PluginData;

    public reviewDecks: { [deckKey: string]: ReviewDeck } = {};
    public lastSelectedReviewDeck: string;

    public newNotes: TFile[] = [];
    public scheduledNotes: SchedNote[] = [];
    private incomingLinks: Record<string, LinkStat[]> = {};
    private pageranks: Record<string, number> = {};
    private dueNotesCount = 0;
    public dueDatesNotes: Record<number, number> = {}; // Record<# of days in future, due count>

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

/* Review notes icon?
        this.addRibbonIcon("SpacedRepIcon", t("REVIEW_CARDS"), async () => {
            if (!this.syncLock) {
                await this.sync();
                new FlashcardModal(this.app, this).open();
            }
        });
*/
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
                    }
                }),
            );
        }

        this.addCommand({
            id: "srs-note-review-open-note",
            name: t("OPEN_NOTE_FOR_REVIEW"),
            callback: async () => {
                this.reviewNextNoteModal();
            },
        });

        this.addCommand({
            id: 'reschedule-backlog',
            name: 'Reschedule Backlog',
            callback: () => {this.openRescheduleBacklogModal()}
        });

        this.addCommand({
            id: 'srs-note-review-postpone',
            name: t("POSTPONE_NOTE_CMD"),
            callback: () => {
                const openFile: TFile | null = this.app.workspace.getActiveFile();
                if (openFile && openFile.extension === "md") {
                    this.saveReviewResponse(openFile, ReviewResponse.Postpone);
                }
            },
        })

        this.addCommand({
            id: 'srs-note-review-skip',
            name: t("SKIP_NOTE_CMD"),
            callback: () => {
                if(this.lastSelectedReviewDeck)
                {
                    this.reviewDecks[this.lastSelectedReviewDeck].currentIndex++;
                    this.reviewDecks[this.lastSelectedReviewDeck].dueNotesCount--;
                    this.reviewNextNote(this.lastSelectedReviewDeck);
                }
            },
        })

        this.addCommand({
            id: 'srs-note-review-sync',
            name: t("SYNC_CMD"),
            callback: () => {
                this.sync();
            },
        })

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

        this.addSettingTab(new SRSettingTab(this.app, this));

        this.app.workspace.onLayoutReady(() => {
            this.initView();
            setTimeout(async () => {
                await this.sync();
            }, 2000);
        });
    }

    onunload(): void {
        this.app.workspace.getLeavesOfType(REVIEW_QUEUE_VIEW_TYPE).forEach((leaf) => leaf.detach());
    }

    async sync(ignoreStats = false): Promise<void> {

        // reset notes stuff
        graph.reset();
        this.incomingLinks = {};
        this.pageranks = {};
        this.dueNotesCount = 0;
        this.dueDatesNotes = {};
        this.reviewDecks = {};

        const now = window.moment(Date.now());
        const todayDate: string = now.format("YYYY-MM-DD");

        const notes: TFile[] = this.app.vault.getMarkdownFiles();
        for (const note of notes) {
            if (
                this.data.settings.noteFoldersToIgnore.some((folder) =>
                    note.path.startsWith(folder),
                )
            ) {
                continue;
            }

            if (this.incomingLinks[note.path] === undefined) {
                this.incomingLinks[note.path] = [];
            }

            const links = this.app.metadataCache.resolvedLinks[note.path] || {};
            for (const targetPath in links) {
                if (this.incomingLinks[targetPath] === undefined)
                    this.incomingLinks[targetPath] = [];

                // markdown files only
                if (targetPath.split(".").pop().toLowerCase() === "md") {
                    this.incomingLinks[targetPath].push({
                        sourcePath: note.path,
                        linkCount: links[targetPath],
                    });

                    graph.link(note.path, targetPath, links[targetPath]);
                }
            }

            const fileCachedData = this.app.metadataCache.getFileCache(note) || {};

            const frontmatter: FrontMatterCache | Record<string, unknown> =
                fileCachedData.frontmatter || {};
            const tags = getAllTags(fileCachedData) || [];

            let shouldIgnore = true;
            const matchedNoteTags = [];
            let rebalance = true;

             // TODO: allow no-rebalance tag to be configurable
            if (tags.some((tag) => tag === "#no-rebalance")) {
                rebalance = false;
            }

            for (const tagToReview of this.data.settings.tagsToReview) {
                if (tags.some((tag) => tag === tagToReview || tag.startsWith(tagToReview + "/"))) {
                    if (!Object.prototype.hasOwnProperty.call(this.reviewDecks, tagToReview)) {
                        log_debug("[Sync] Creating new deck for tag: " + tagToReview);
                        this.reviewDecks[tagToReview] = new ReviewDeck(tagToReview);
                    }
                    matchedNoteTags.push(tagToReview);
                    shouldIgnore = false;
                    // This used to break, which works if you only want to register for
                    // the first found deck. But we want to register for multiple decks.
                    // This allows us to review normally, or to review a priority deck variant
                    // that pulls out a subset of high priority notes.
                }
            }

            if (shouldIgnore) {
                continue;
            }

            // file has no scheduling information
            if (
                !(
                    Object.prototype.hasOwnProperty.call(frontmatter, "sr-due") &&
                    Object.prototype.hasOwnProperty.call(frontmatter, "sr-interval") &&
                    Object.prototype.hasOwnProperty.call(frontmatter, "sr-ease")
                )
            ) {
                for (const matchedNoteTag of matchedNoteTags) {
                    this.reviewDecks[matchedNoteTag].newNotes.push(note);
                }
                continue;
            }

            const dueUnix: number = window
                .moment(frontmatter["sr-due"], ["YYYY-MM-DD", "DD-MM-YYYY", "ddd MMM DD YYYY"])
                .valueOf();

            const ease: number = frontmatter["sr-ease"];
            const interval: number = frontmatter["sr-interval"];

            let noteType = NoteTypes.STANDARD;
            if(ease < 0)
            {
                noteType = NoteTypes.GEOMETRIC
            }
            else if (ease == 0)
            {
                noteType = NoteTypes.PERIODIC;
            }

            for (const matchedNoteTag of matchedNoteTags) {
                this.reviewDecks[matchedNoteTag].scheduledNotes.push(
                    { note, dueUnix, ease, noteType, interval, rebalance});
                if (dueUnix <= now.valueOf()) {
                    this.reviewDecks[matchedNoteTag].dueNotesCount++;
                }
            }

            if (dueUnix <= now.valueOf()) {
                this.dueNotesCount++;
            }

            const nDays: number = Math.ceil((dueUnix - now.valueOf()) / (24 * 3600 * 1000));
            if (!Object.prototype.hasOwnProperty.call(this.dueDatesNotes, nDays)) {
                this.dueDatesNotes[nDays] = 0;
            }
            this.dueDatesNotes[nDays]++;
        }

        graph.rank(0.85, 0.000001, (node: string, rank: number) => {
            this.pageranks[node] = rank * 10000;
        });

        log_debug(`[Sync] Decks`, this.reviewDecks);

        for (const deckKey in this.reviewDecks) {
            log_debug("[Sync] Sorting deck: " + deckKey);
            this.reviewDecks[deckKey].sortNewNotes(this.pageranks);
            this.reviewDecks[deckKey].sortScheduledNotes();
        }

        log_debug(
            "[Sync] " +
                t("SYNC_TIME_TAKEN", {
                    t: Date.now() - now.valueOf(),
                }),
        );

        this.statusBar.setText(
            t("STATUS_BAR", {
                dueNotesCount: this.dueNotesCount
            }),
        );

        if (this.data.settings.enableNoteReviewPaneOnStartup) this.reviewQueueView.redraw();
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

        let fileText: string = await this.app.vault.read(note);
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
            if(Object.prototype.hasOwnProperty.call(frontmatter, "sr-type"))
            {
                let sr_type : string = frontmatter["sr-type"]
                if(sr_type === "geometric")
                {
                    interval = 1;
                    ease = -2.91;
                    delayBeforeReview = 0;
                }
                else if(sr_type == "periodic")
                {
                    if(Object.prototype.hasOwnProperty.call(frontmatter, "sr-interval"))
                    {
                        interval = frontmatter["sr-interval"];
                    }
                    else
                    {
                        interval = 30;
                    }
                    ease = 0;
                    delayBeforeReview = 0;
                }
                else
                {
                    new Notice("sr-type attribute can only be geometric or periodic");
                    return;
                }
            }
            else
            {
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

        if(response == ReviewResponse.Postpone)
        {
            // This injects jitter into the rescheduling process, so that you
            // don't postpone every card onto the same day

            // Note that if you set interval here, you override interval in the
            // note, which is not what we want
            const postponeWindow = 5; // [-5,5 variation around postpone date]
            const postpone_interval = 10 + (Math.round(Math.random() * (2 * postponeWindow) - postponeWindow));
            var due = window.moment(now + postpone_interval * 24 * 3600 * 1000);
            log_debug("Postponing for " + postpone_interval + " days");
        }
        else
        {
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
            if(noteIsNew || ease < 0)
            {
                let variationWindow = 5; // [0,5] variation around the actual
                                           // due date.
                if(ease < 0)
                {
                    // for now, doubling the variation window for geometric notes
                    variationWindow *= 2;
                }

                let jitter = Math.round(Math.random() * variationWindow);

                log_debug("Adding jitter to note schedule: " + jitter);

                intervalWithJitter = interval + jitter;
            }

            // Note that we're scheduling due date with the potentially jittered
            // interval, without impacting the actual interval itself.
            var due = window.moment(now + intervalWithJitter * 24 * 3600 * 1000);
        }

        const dueString: string = due.format("YYYY-MM-DD");

        // check if scheduling info exists
        if(SR_INTERVAL_REGEX.test(fileText))
        {
            const yaml_info = SR_INTERVAL_REGEX.exec(fileText);
            fileText = fileText.replace(
                SR_INTERVAL_REGEX,
                `---\n${yaml_info[1]}sr-interval: ${interval}\n${yaml_info[3]}---`,
            );
        }
        else
        {
            const existingYaml = YAML_FRONT_MATTER_REGEX.exec(fileText);
            fileText = fileText.replace(
                YAML_FRONT_MATTER_REGEX,
                `---\n${existingYaml[1]}sr-interval: ${interval}\n---`,
            );
        }

        if(SR_DUE_REGEX.test(fileText))
        {
            const yaml_info = SR_DUE_REGEX.exec(fileText);
            fileText = fileText.replace(
                SR_DUE_REGEX,
                `---\n${yaml_info[1]}sr-due: ${dueString}\n${yaml_info[3]}---`,
            );
        }
        else
        {
            const existingYaml = YAML_FRONT_MATTER_REGEX.exec(fileText);
            fileText = fileText.replace(
                YAML_FRONT_MATTER_REGEX,
                `---\n${existingYaml[1]}sr-due: ${dueString}\n---`,
            );
        }

        if(SR_EASE_REGEX.test(fileText))
        {
            const yaml_info = SR_EASE_REGEX.exec(fileText);
            fileText = fileText.replace(
                SR_EASE_REGEX,
                `---\n${yaml_info[1]}sr-ease: ${ease}\n${yaml_info[3]}---`,
            );
        }
        else
        {
            const existingYaml = YAML_FRONT_MATTER_REGEX.exec(fileText);
            fileText = fileText.replace(
                YAML_FRONT_MATTER_REGEX,
                `---\n${existingYaml[1]}sr-ease: ${ease}\n---`,
            );
        }

        await this.app.vault.modify(note, fileText);

        // If there's no deck selected, we still allow the note to be processed,
        // we just don't need to update deck stats
        if(this.lastSelectedReviewDeck)
        {
            let deck = this.reviewDecks[this.lastSelectedReviewDeck];
            deck.currentIndex++;
            deck.dueNotesCount--;

        }

        new Notice(t("RESPONSE_RECEIVED"));

        if (this.data.settings.autoNextNote) {
            await this.reviewNextNote(this.lastSelectedReviewDeck);
        }
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

        if(this.lastSelectedReviewDeck != deckKey)
        {
            this.lastSelectedReviewDeck = deckKey;
            // When switching decks, we should force a sync.
            await this.sync();
            // Note that sync() will reset the currentIndex for all decks
        }

        const deck = this.reviewDecks[deckKey];

        log_debug("[Review] Deck due notes count: " + deck.dueNotesCount);
        log_debug("[Review] Current index into sync'd list: " + deck.currentIndex);

        if (deck.dueNotesCount > 0) {
            const index = this.data.settings.openRandomNote
                ? Math.floor(Math.random() * deck.dueNotesCount)
                : deck.currentIndex;
            log_debug("[Review] Attempting next note open: due notes, index: " + index + ", note: " + deck.scheduledNotes[index].note.basename);
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

    findDeckPath(note: TFile): string[] {
        let deckPath: string[] = [];
        if (this.data.settings.convertFoldersToDecks) {
            deckPath = note.path.split("/");
            deckPath.pop(); // remove filename
            if (deckPath.length === 0) {
                deckPath = ["/"];
            }
        } else {
            const fileCachedData = this.app.metadataCache.getFileCache(note) || {};
            const tags = getAllTags(fileCachedData) || [];

            outer: for (const tagToReview of this.data.settings.flashcardTags) {
                for (const tag of tags) {
                    if (tag === tagToReview || tag.startsWith(tagToReview + "/")) {
                        deckPath = tag.substring(1).split("/");
                        break outer;
                    }
                }
            }
        }

        return deckPath;
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
            REVIEW_QUEUE_VIEW_TYPE,
            (leaf) => (this.reviewQueueView = new ReviewQueueListView(leaf, this)),
        );

        if (
            this.data.settings.enableNoteReviewPaneOnStartup &&
            app.workspace.getLeavesOfType(REVIEW_QUEUE_VIEW_TYPE).length == 0
        ) {
            this.app.workspace.getRightLeaf(false).setViewState({
                type: REVIEW_QUEUE_VIEW_TYPE,
                active: true,
            });
        }
    }
}
