import { App, Modal, TFile, Setting } from "obsidian";
import { ReviewDeck, NoteTypes, SchedNote } from "src/review-deck";
import { SR_DUE_REGEX } from "src/constants";
import { log_debug } from "src/logger";

// TODO: reschedule future weekend due dates
// TODO: reschdule what's due today (workaround: just wait until past due)
// TODO: balance due in the future

function incrementDay(date: Date): Date
{
    return new Date(date.getTime() + (24 * 3600 * 1000));
}

function addDays(date: Date, days: number): Date
{
    return new Date(date.getTime() + (days * 24 * 3600 * 1000));
}

// TODO: Surely this could be smarter, but it works for now
function rescheduleDate(date: Date, days: number, includeWeekends: boolean): Date
{
if (includeWeekends)
    {
        return addDays(date, days);
    }
    else
    {
        let days_rem = days;
        while(days_rem)
        {
            date = incrementDay(date);
            let day = date.getDay();
            if(day != 0 && day != 6)
            {
                days_rem--;
            }
        }

        return date;
    }
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

function formatDate(date : Date) : string
{
  let year = date.getFullYear();
  // Months are 0-based, so we add 1
  let month = (1 + date.getMonth()).toString().padStart(2, '0');
  let day = date.getDate().toString().padStart(2, '0');

  return year + '-' + month + '-' + day;
}

async function rewrite_due_date(note: SchedNote, newDate: Date)
{
    note.dueUnix = newDate.getTime();
    const dueString: string = formatDate(newDate);

    let fileText: string = await this.app.vault.read(note.note);

    // TODO: optimization - make this into a function (can do for all variants)
    const yaml_info = SR_DUE_REGEX.exec(fileText);
    fileText = fileText.replace(
        SR_DUE_REGEX,
        `---\n${yaml_info[1]}sr-due: ${dueString}\n${yaml_info[3]}---`,
    );

    await this.app.vault.modify(note.note, fileText);

    log_debug("Rescheduled note " + note.note.path + " to " + newDate);
}

async function rescheduleNotes(deckList: ReviewDeck[],
    deck: ReviewDeck,
    noteType: int,
    days: int,
    includeWeekends: boolean)
{
    log_debug("[Reschedule] Request submitted with deck: " + deck  +
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
        // Needs to be an array so the for loop works below.
        keys = [deck];
    }

    log_debug("[Reschedule] Selected deck keys: " + keys);

    let today = new Date();
    today.setHours(0, 0, 0, 0);
    let todayUnix = today.getTime();

    log_debug("[Reschedule] Today unix timestamp: " + todayUnix);

    for(let key of keys)
    {
        // This algorithm assumes a sorted deck list. We will iterate
        // through each scheduled note and reschedule it, but as soon as we
        // hit a note that matches today, we will stop the process.
        log_debug("[Review] Processing deck: " + key);
        let deck = deckList[key];
        let pastDueCount = findPastDueCount(deck, todayUnix);
        log_debug("[Review] Deck " + key + " has " + pastDueCount + " past due notes.");

        let validIndices = [];

        if(noteType == NoteTypes.ALL)
        {
            // TODO: can probably be simplified, but this lets the rest of the
            // logic be consistent for now
            // Populate validIndices with a count from 0 to pastDueCount - 1
            for(let i = 0; i < pastDueCount; i++)
            {
                if(deck.scheduledNotes[i].rebalance)
                {
                    validIndices.push(i);
                }
            }
        }
        else
        {
            log_debug("[Review] Filtering past due for note type: " + noteType);
            for(let i = 0; i < pastDueCount; i++)
            {
                let note = deck.scheduledNotes[i];
                if(note.noteType == noteType && note.rebalance)
                {
                    validIndices.push(i);
                }
            }
        }

        log_debug("[Review] Past due count after filtering by note type: " + validIndices.length);

        let reschedulePerDayTarget = Math.floor(validIndices.length / days);
        let dateDelta = 1;
        let addedPerDay = 0;

        let promises = validIndices.map(i => {
            let newDate = rescheduleDate(today, dateDelta, includeWeekends);

            // This saves us needing to update in another way
            deck.dueNotesCount--;

            // Now we do the other math for tracking increments
            addedPerDay++;
            if(addedPerDay == reschedulePerDayTarget)
            {
                dateDelta++;
                addedPerDay = 0;
                if(dateDelta > days)
                {
                    // This will happen because of rounding being cut off.
                    // So we'll increment one per day
                    reschedulePerDayTarget = 1
                    dateDelta = 1; // wrap back around
                }
            }

            return rewrite_due_date(deck.scheduledNotes[i], newDate);
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
  rescheduleDays: int;
  rescheduleNoteType: NoteTypes;
  rescheduleIncludesWeekends: boolean;
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
                // This is converting to a string, even though I'm using
                // a bool type. So we convert back to a bool.
                this.rescheduleIncludesWeekends = value === "true";
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
