import { App, FuzzySuggestModal, TFile } from "obsidian";

import { t } from "src/lang/helpers";

export enum NoteTypes {
    ALL,
    STANDARD,
    PERIODIC,
    GEOMETRIC
}

export interface SchedNote {
    note: TFile;
    dueUnix: number;
    ease: number;
    type: NoteTypes;
    interval: number;
}

export class ReviewDeck {
    public deckName: string;
    public newNotes: TFile[] = [];
    public scheduledNotes: SchedNote[] = [];
    public activeFolders: Set<string>;
    public dueNotesCount = 0;
    public currentIndex = 0;

    constructor(name: string) {
        this.deckName = name;
        this.activeFolders = new Set([this.deckName, t("TODAY")]);
    }

    public sortNotes(pageranks: Record<string, number>): void {
        // sort new notes by importance
        this.newNotes = this.newNotes.sort(
            (a: TFile, b: TFile) => (pageranks[b.path] || 0) - (pageranks[a.path] || 0),
        );

        // sort scheduled notes by date & within those days, sort them by TYPE and age (older first)
        this.scheduledNotes = this.scheduledNotes.sort((a: SchedNote, b: SchedNote) => {
            // First by due date
            const result = a.dueUnix - b.dueUnix;
            if (result != 0) {
                return result;
            }

            // First by ease
            if(a.ease != b.ease)
            {
                return a.ease - b.ease;
            }

            // Then by interval
            if(a.interval != b.interval)
            {
                return b.interval - a.interval;
            }

            // Then by pagerank
            return (pageranks[b.note.path] || 0) - (pageranks[a.note.path] || 0);
        });
    }
}

export class ReviewDeckSelectionModal extends FuzzySuggestModal<string> {
    public deckKeys: string[] = [];
    public submitCallback: (deckKey: string) => void;

    constructor(app: App, deckKeys: string[]) {
        super(app);
        this.deckKeys = deckKeys;
    }

    getItems(): string[] {
        return this.deckKeys;
    }

    getItemText(item: string): string {
        return item;
    }

    onChooseItem(deckKey: string, _: MouseEvent | KeyboardEvent): void {
        this.close();
        this.submitCallback(deckKey);
    }
}
