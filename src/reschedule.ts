import { App, Modal, TFile, Setting } from "obsidian";

import ReviewDeck from "src/review-deck";
import { ReviewDeck, NoteTypes, SchedNote } from "src/review-deck";

/* Notes
        const now = window.moment(Date.now());
        const todayDate: string = now.format("YYYY-MM-DD");

            const dueUnix: number = window
                .moment(frontmatter["sr-due"], ["YYYY-MM-DD", "DD-MM-YYYY", "ddd MMM DD YYYY"])
                .valueOf();

        const dueString: string = due.format("YYYY-MM-DD");

        var due = window.moment(now + intervalWithJitter * 24 * 3600 * 1000);

            if (dueUnix <= now.valueOf()) {
                this.dueNotesCount++;
            }
*/

// TODO: this needs to be somewhere else and imported
// because we could use this elsewhere


function addDaysToUnixTimestamp(unixTimestamp: number, days: number): number
{
    return unixTimestamp + days * 24 * 3600 * 1000;
}

function findPastDueCount(deck: ReviewDeck, todayUnixTimestamp: number): number
{
    // This uses a binary search strategy to find the first
    // "today" timestamp.
    let pastDue = 0;
    let todayOrFuture = deck.scheduledNotes.length - 1;

    while (pastDue <= todayOrFuture)
    {
        const mid = Math.floor((pastDue + todayOrFuture) / 2);

        if(deck.scheduledNotes[mid].dueUnix < todayUnixTimestamp)
        {
            pastDue = mid + 1;
        }
        else
        {
            todayOrFuture = mid - 1;
        }
    }

    return pastDue;
}

function rescheduleNotes(deckList: ReviewDeck[],
    deck: ReviewDeck,
    noteType: int,
    days: int,
    includeWeekends: bool)
{
    console.log("[Reschedule] Request submitted with deck: " + deck  +
                " rescheduleDays: " + days +
                " rescheduleNoteType: " + noteType +
                " Reschedule on weekends: " + includeWeekends);

    if(days == 0)
    {
        console.error("Cannot reschedule 0 days");
        // TODO: fire a notice
        return;
    }

    let keys;
    if(deck == "all")
    {
        keys = Object.keys(deckList);
    }
    else
    {
        keys = deck;
    }

    console.log("[Reschedule] Selected deck keys: " + keys);

    let today = new Date();
    today.setHours(0, 0, 0, 0);
    let todayUnix = today.getTime();

    console.log("Today unix timestamp: " + todayUnix);

    for(let key of keys)
    {
        // This algorithm assumes a sorted deck list. We will iterate
        // through each scheduled note and reschedule it, but as soon as we
        // hit a note that matches today, we will stop the process.

        let deck = deckList[key];
        let pastDueCount = findPastDueCount(deck, todayUnix);
        console.log("Deck " + key + " has " + pastDueCount + " past due notes.");

        let validIndices = [];

        if(noteType == NoteTypes.ALL)
        {
            // TODO: can probably be simplified, but this lets the rest of the
            // logic be consistent for now
            // Populate validIndices with a count from 0 to pastDueCount - 1
            for(let i = 0; i < pastDueCount; i++)
            {
                validIndices.push(i);
            }
        }
        else
        {
            console.log("Filtering past due for note type: " + noteType);
            for(let i = 0; i < pastDueCount; i++)
            {
                let note = deck.scheduledNotes[i];
                if(note.noteType == noteType)
                {
                    validIndices.push(i);
                }
            }
        }

        console.log("Past due count after filtering by note type: " + validIndices.length);


        // TODO: uncomment
        // Now that things are rescheduled, we need to update our
        // deck information
        //deckList[key].sortNotes();
        //deckList[key].currentIndex = 0;
        // TODO: What about dueNotesCount? Probably needs a supporting function
        // pulled out of sync().
    }

    console.log("Rescheduling complete.");
}

export class RescheduleBacklogModal extends Modal {
  rescheduleDays: int;
  rescheduleNoteType: NoteTypes;
  rescheduleIncludesWeekends: bool;
  rescheduleDeck: string;
  deckKeys: string[];
  deckList: ReviewDeck[];

  constructor(app: App, deckList: ReviewDeck[]) {
    super(app);
    this.rescheduleDays = 7;
    this.rescheduleNoteType = NoteTypes.ALL;
    this.rescheduleIncludesWeekends = true;
    this.rescheduleDeck = "all";
    this.deckKeys = Object.keys(deckList);

    // TODO: double confirm that this does not make a copy
    this.deckList = deckList;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl("h1", { text: "Backlog Rescheduling" });

    new Setting(contentEl)
        .setName("Deck")
        .setDesc("Select which deck(s) to reschedule.")
        .addDropdown( dropDown => {
            dropDown.addOption("all", "All");
            for (let deck of this.deckKeys) {
                dropDown.addOption(deck, deck);
            }
            dropDown.onChange((value) => {
                this.rescheduleDeck = value;
            })
        });

    new Setting(contentEl)
        .setName("Note Type")
        .setDesc("Select the note types to reschedule.")
        .addDropdown( dropDown => {
            dropDown.addOption(NoteTypes.ALL, "All");
            dropDown.addOption(NoteTypes.STANDARD, "Standard");
            dropDown.addOption(NoteTypes.PERIODIC, "Periodic");
            dropDown.addOption(NoteTypes.GEOMETRIC, "Geometric");
            dropDown.onChange((value) => {
                this.rescheduleNoteType = value;
            })
        });

    new Setting(contentEl)
      .setName("Days to spread over")
      .addText((text) =>
        text.setValue("7").onChange((value) => {
          this.rescheduleDays = value;
        }));

    new Setting(contentEl)
        .setName("Include weekends?")
        .setDesc("Determine whether notes will be rescheduled for weekends.")
        .addDropdown( dropDown => {
            dropDown.addOption(true, "Yes");
            dropDown.addOption(false, "No");
            dropDown.onChange((value) => {
                this.rescheduleIncludesWeekends = value;
            })
        });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Reschedule")
          .setCta()
          .onClick(() => {
            // TODO: should this be async?
            rescheduleNotes(this.deckList, this.rescheduleDeck, this.rescheduleNoteType,
                this.rescheduleDays, this.rescheduleIncludesWeekends);
            this.close();
            // TODO: pass to the rescheduler
          }));
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}
