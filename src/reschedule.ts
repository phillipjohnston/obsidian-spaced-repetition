import { App, Modal, Setting } from "obsidian";
import { ReviewDeck, NoteTypes, SchedNote } from "src/review-deck";
import { log_debug } from "src/logger";

// TODO: reschedule future weekend due dates
// TODO: reschdule what's due today (workaround: just wait until past due)
// TODO: balance due in the future

function incrementDay(date: Date): Date {
    return new Date(date.getTime() + 24 * 3600 * 1000);
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 24 * 3600 * 1000);
}

// TODO: Surely this could be smarter, but it works for now
function rescheduleDate(date: Date, days: number, includeWeekends: boolean): Date {
    if (includeWeekends) {
        return addDays(date, days);
    } else {
        let days_rem = days;
        while (days_rem) {
            date = incrementDay(date);
            let day = date.getDay();
            if (day != 0 && day != 6) {
                days_rem--;
            }
        }

        return date;
    }
}

function findPastDueCount(deck: ReviewDeck, todayUnixTimestamp: number): number {
    // This uses a binary search strategy to find the first
    // "today" timestamp.
    let pastDue = 0;
    let todayOrFuture = deck.scheduledNotes.length - 1;

    while (pastDue <= todayOrFuture) {
        const mid = Math.floor((pastDue + todayOrFuture) / 2);

        if (deck.scheduledNotes[mid].dueUnix < todayUnixTimestamp) {
            pastDue = mid + 1;
        } else {
            todayOrFuture = mid - 1;
        }
    }

    return pastDue;
}

function formatDate(date: Date): string {
    let year = date.getFullYear();
    // Months are 0-based, so we add 1
    let month = (1 + date.getMonth()).toString().padStart(2, "0");
    let day = date.getDate().toString().padStart(2, "0");

    return year + "-" + month + "-" + day;
}

async function rewrite_due_date(app: App, note: SchedNote, newDate: Date) {
    note.dueUnix = newDate.getTime();
    const dueString: string = formatDate(newDate);

    // Update frontmatter using Obsidian's API
    await app.fileManager.processFrontMatter(note.note, (frontmatter) => {
        frontmatter["sr-due"] = dueString;
    });

    log_debug("Rescheduled note " + note.note.path + " to " + newDate);
}

async function rescheduleNotes(
    app: App,
    deckList: { [deckKey: string]: ReviewDeck },
    deck: string,
    noteType: NoteTypes,
    days: number,
    includeWeekends: boolean,
    minInterval: number | null,
    maxInterval: number | null,
) {
    log_debug(
        "[Reschedule] Request submitted with deck: " +
            deck +
            " rescheduleDays: " +
            days +
            " rescheduleNoteType: " +
            noteType +
            " Reschedule on weekends: " +
            includeWeekends +
            " minInterval: " +
            minInterval +
            " maxInterval: " +
            maxInterval,
    );

    if (days == 0) {
        console.error("Cannot reschedule 0 days");
        // TODO: fire a notice
        return;
    }

    let keys;
    if (deck == "all") {
        keys = Object.keys(deckList);
    } else {
        // Needs to be an array so the for loop works below.
        keys = [deck];
    }

    log_debug("[Reschedule] Selected deck keys: " + keys);

    let today = new Date();
    today.setHours(0, 0, 0, 0);
    let todayUnix = today.getTime();

    log_debug("[Reschedule] Today unix timestamp: " + todayUnix);

    for (let key of keys) {
        // This algorithm assumes a sorted deck list. We will iterate
        // through each scheduled note and reschedule it, but as soon as we
        // hit a note that matches today, we will stop the process.
        log_debug("[Review] Processing deck: " + key);
        let deck = deckList[key];
        let pastDueCount = findPastDueCount(deck, todayUnix);
        log_debug("[Review] Deck " + key + " has " + pastDueCount + " past due notes.");

        let validIndices = [];

        // Helper to check if note passes interval filter
        const passesIntervalFilter = (note: SchedNote): boolean => {
            if (minInterval !== null && note.interval < minInterval) {
                return false;
            }
            if (maxInterval !== null && note.interval > maxInterval) {
                return false;
            }
            return true;
        };

        if (noteType == NoteTypes.ALL) {
            // TODO: can probably be simplified, but this lets the rest of the
            // logic be consistent for now
            // Populate validIndices with a count from 0 to pastDueCount - 1
            for (let i = 0; i < pastDueCount; i++) {
                let note = deck.scheduledNotes[i];
                if (note.rebalance && passesIntervalFilter(note)) {
                    validIndices.push(i);
                }
            }
        } else {
            log_debug("[Review] Filtering past due for note type: " + noteType);
            for (let i = 0; i < pastDueCount; i++) {
                let note = deck.scheduledNotes[i];
                if (note.noteType == noteType && note.rebalance && passesIntervalFilter(note)) {
                    validIndices.push(i);
                }
            }
        }

        log_debug("[Review] Past due count after filtering: " + validIndices.length);

        let reschedulePerDayTarget = Math.floor(validIndices.length / days);
        let dateDelta = 1;
        let addedPerDay = 0;

        let promises = validIndices.map((i) => {
            let newDate = rescheduleDate(today, dateDelta, includeWeekends);

            // This saves us needing to update in another way
            deck.dueNotesCount--;

            // Now we do the other math for tracking increments
            addedPerDay++;
            if (addedPerDay == reschedulePerDayTarget) {
                dateDelta++;
                addedPerDay = 0;
                if (dateDelta > days) {
                    // This will happen because of rounding being cut off.
                    // So we'll increment one per day
                    reschedulePerDayTarget = 1;
                    dateDelta = 1; // wrap back around
                }
            }

            return rewrite_due_date(app, deck.scheduledNotes[i], newDate);
        });

        Promise.all(promises).then(() => {
            // Now that things are rescheduled, we need to update our
            // deck information - no sync needed now.
            deckList[key].sortScheduledNotes();
            deckList[key].currentIndex = 0;
            log_debug("Rescheduling deck " + key + " complete.");
            //log_debug(`SR: Decks post reschedule`, deckList);
        });
    }
}

export class RescheduleBacklogModal extends Modal {
    rescheduleDays: number;
    rescheduleNoteType: NoteTypes;
    rescheduleIncludesWeekends: boolean;
    rescheduleDeck: string;
    deckKeys: string[];
    deckList: { [deckKey: string]: ReviewDeck };
    minInterval: number | null;
    maxInterval: number | null;

    constructor(app: App, deckList: { [deckKey: string]: ReviewDeck }) {
        super(app);
        this.rescheduleDays = 7;
        this.rescheduleNoteType = NoteTypes.ALL;
        this.rescheduleIncludesWeekends = true;
        this.rescheduleDeck = "all";
        this.deckKeys = Object.keys(deckList);
        this.minInterval = null;
        this.maxInterval = null;

        // TODO: double confirm that this does not make a copy
        this.deckList = deckList;
    }

    onOpen() {
        const { contentEl } = this;

        contentEl.createEl("h1", { text: "Backlog Rescheduling" });

        new Setting(contentEl)
            .setName("Deck")
            .setDesc("Select which deck(s) to reschedule.")
            .addDropdown((dropDown) => {
                dropDown.addOption("all", "All");
                for (let deck of this.deckKeys) {
                    dropDown.addOption(deck, deck);
                }
                dropDown.onChange((value) => {
                    this.rescheduleDeck = value;
                });
            });

        new Setting(contentEl)
            .setName("Note Type")
            .setDesc("Select the note types to reschedule.")
            .addDropdown((dropDown) => {
                dropDown.addOption(String(NoteTypes.ALL), "All");
                dropDown.addOption(String(NoteTypes.STANDARD), "Standard");
                dropDown.addOption(String(NoteTypes.PERIODIC), "Periodic");
                dropDown.addOption(String(NoteTypes.GEOMETRIC), "Geometric");
                dropDown.onChange((value) => {
                    this.rescheduleNoteType = parseInt(value) as NoteTypes;
                });
            });

        new Setting(contentEl).setName("Days to spread over").addText((text) =>
            text.setValue("7").onChange((value) => {
                this.rescheduleDays = parseInt(value) || 7;
            }),
        );

        new Setting(contentEl)
            .setName("Include weekends?")
            .setDesc("Determine whether notes will be rescheduled for weekends.")
            .addDropdown((dropDown) => {
                dropDown.addOption("true", "Yes");
                dropDown.addOption("false", "No");
                dropDown.onChange((value) => {
                    this.rescheduleIncludesWeekends = value === "true";
                });
            });

        new Setting(contentEl)
            .setName("Minimum interval (days)")
            .setDesc("Only reschedule notes with interval >= this value. Leave empty for no minimum.")
            .addText((text) =>
                text.setPlaceholder("No minimum").onChange((value) => {
                    const numValue = parseInt(value);
                    this.minInterval = isNaN(numValue) ? null : numValue;
                }),
            );

        new Setting(contentEl)
            .setName("Maximum interval (days)")
            .setDesc("Only reschedule notes with interval <= this value. Leave empty for no maximum.")
            .addText((text) =>
                text.setPlaceholder("No maximum").onChange((value) => {
                    const numValue = parseInt(value);
                    this.maxInterval = isNaN(numValue) ? null : numValue;
                }),
            );

        new Setting(contentEl).addButton((btn) =>
            btn
                .setButtonText("Reschedule")
                .setCta()
                .onClick(() => {
                    // TODO: should this be async?
                    rescheduleNotes(
                        this.app,
                        this.deckList,
                        this.rescheduleDeck,
                        this.rescheduleNoteType,
                        this.rescheduleDays,
                        this.rescheduleIncludesWeekends,
                        this.minInterval,
                        this.maxInterval,
                    );
                    this.close();
                    // TODO: pass to the rescheduler
                }),
        );
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
}
