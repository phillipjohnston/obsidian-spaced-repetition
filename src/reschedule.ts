import { App, Modal, TFile, Setting } from "obsidian";

export class RescheduleBacklogModal extends Modal {
  rescheduleDays: int;
  rescheduleNoteType: int;
  rescheduleIncludesWeekends: bool;
  rescheduleDeck: string;
  deckKeys: string[];

  constructor(app: App, deckKeys: string[]) {
    super(app);
    this.rescheduleDays = 0;
    this.rescheduleNoteType = 0;
    this.rescheduleIncludesWeekends = true;
    this.rescheduleDeck = "all";
    this.deckKeys = deckKeys;
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
      .setName("Days to spread over")
      .addText((text) =>
        text.onChange((value) => {
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
        .setName("Note Type")
        .setDesc("Select the note types to reschedule.")
        .addDropdown( dropDown => {
            dropDown.addOption(0, "All");
            dropDown.addOption(1, "Standard");
            dropDown.addOption(2, "Periodic");
            dropDown.addOption(3, "Geometric");
            dropDown.onChange((value) => {
                this.rescheduleNoteType = value;
            })
        });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Reschedule")
          .setCta()
          .onClick(() => {
            console.log("Reschedule submitted with deck: " + this.rescheduleDeck  + " rescheduleDays: " + this.rescheduleDays + " and rescheduleNoteType: " + this.rescheduleNoteType + " Reschedule on weekends: " + this.rescheduleIncludesWeekends);
            this.close();
            // TODO: pass to the rescheduler
          }));
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}
