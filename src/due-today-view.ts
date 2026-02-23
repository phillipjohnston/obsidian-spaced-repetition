import { ItemView, WorkspaceLeaf, Menu, TFile } from "obsidian";

import type SRPlugin from "src/main";
import { COLLAPSE_ICON } from "src/constants";
import { ReviewDeck, SchedNote } from "src/review-deck";
import { t } from "src/lang/helpers";

export const DUE_TODAY_VIEW_TYPE = "due-today-view";

export class DueTodayView extends ItemView {
    private plugin: SRPlugin;

    constructor(leaf: WorkspaceLeaf, plugin: SRPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.registerEvent(this.app.workspace.on("file-open", () => this.redraw()));
        this.registerEvent(this.app.vault.on("rename", () => this.redraw()));
    }

    public getViewType(): string {
        return DUE_TODAY_VIEW_TYPE;
    }

    public getDisplayText(): string {
        return t("DUE_TODAY_VIEW_TITLE");
    }

    public getIcon(): string {
        return "SpacedRepIcon";
    }

    public onHeaderMenu(menu: Menu): void {
        menu.addItem((item) => {
            item.setTitle(t("CLOSE"))
                .setIcon("cross")
                .onClick(() => {
                    this.app.workspace.detachLeavesOfType(DUE_TODAY_VIEW_TYPE);
                });
        });
    }

    public redraw(): void {
        const activeFile: TFile | null = this.app.workspace.getActiveFile();
        const endOfToday = window.moment().endOf("day").valueOf();

        const rootEl: HTMLElement = createDiv("nav-folder mod-root");
        const childrenEl: HTMLElement = rootEl.createDiv("nav-folder-children");

        let totalDue = 0;

        for (const deckKey in this.plugin.reviewDecks) {
            const deck: ReviewDeck = this.plugin.reviewDecks[deckKey];

            // Collect notes due today or overdue (dueUnix <= end of today)
            const dueNotes: SchedNote[] = deck.scheduledNotes.filter(
                (sn) => sn.dueUnix <= endOfToday,
            );

            const showNewNotes = this.plugin.data.settings.dueTodayShowNewNotes;

            // Only render deck if it has scheduled notes due, or new notes when enabled
            const hasDueContent = dueNotes.length > 0 || (showNewNotes && deck.newNotes.length > 0);
            if (!hasDueContent) {
                continue;
            }

            totalDue += dueNotes.length;

            const deckFolderKey = deckKey + ":due-today";
            const deckCollapsed = !deck.activeFolders.has(deckFolderKey);

            const deckFolderEl: HTMLElement = this.createFolder(
                childrenEl,
                `${deckKey} (${dueNotes.length})`,
                deckCollapsed,
                false,
                deck,
                deckFolderKey,
            );
            const deckChildrenEl = deckFolderEl.getElementsByClassName(
                "nav-folder-children",
            )[0] as HTMLElement;

            // New (unscheduled) notes sub-folder
            if (showNewNotes && deck.newNotes.length > 0) {
                const newFolderKey = deckKey + ":due-today:new";
                const newFolderCollapsed = !deck.activeFolders.has(newFolderKey);
                const newFolderEl = this.createFolder(
                    deckChildrenEl,
                    t("DUE_TODAY_NEW"),
                    newFolderCollapsed,
                    deckCollapsed,
                    deck,
                    newFolderKey,
                );
                const newChildrenEl = newFolderEl.getElementsByClassName(
                    "nav-folder-children",
                )[0] as HTMLElement;

                for (const file of deck.newNotes) {
                    const fileIsOpen = activeFile && file.path === activeFile.path;
                    if (fileIsOpen) {
                        deck.activeFolders.add(deckFolderKey);
                        deck.activeFolders.add(newFolderKey);
                        this.expandFolder(newFolderEl);
                        this.expandFolder(deckFolderEl);
                    }
                    this.createFile(newChildrenEl, file, fileIsOpen, newFolderCollapsed, deck);
                }
            }

            // Due / overdue notes — flat list directly in deck folder
            for (const sNote of dueNotes) {
                const fileIsOpen = activeFile && sNote.note.path === activeFile.path;
                if (fileIsOpen) {
                    deck.activeFolders.add(deckFolderKey);
                    this.expandFolder(deckFolderEl);
                }
                this.createFile(deckChildrenEl, sNote.note, fileIsOpen, deckCollapsed, deck);
            }
        }

        // Empty state
        if (totalDue === 0 && Object.keys(this.plugin.reviewDecks).length > 0) {
            const emptyEl = childrenEl.createDiv("nav-file");
            emptyEl.createDiv("nav-file-title").setText(t("DUE_TODAY_EMPTY"));
        }

        const contentEl: Element = this.containerEl.children[1];
        contentEl.empty();
        contentEl.appendChild(rootEl);
    }

    private createFolder(
        parentEl: HTMLElement,
        folderTitle: string,
        collapsed: boolean,
        hidden: boolean,
        deck: ReviewDeck,
        folderKey: string,
    ): HTMLElement {
        const folderEl = parentEl.createDiv("nav-folder");
        const folderTitleEl = folderEl.createDiv("nav-folder-title");
        const childrenEl = folderEl.createDiv("nav-folder-children");
        const collapseIconEl = folderTitleEl.createDiv(
            "nav-folder-collapse-indicator collapse-icon",
        );

        collapseIconEl.innerHTML = COLLAPSE_ICON;
        if (collapsed) {
            (collapseIconEl.childNodes[0] as HTMLElement).style.transform = "rotate(-90deg)";
        }

        folderTitleEl.createDiv("nav-folder-title-content").setText(folderTitle);

        if (hidden) {
            folderEl.style.display = "none";
        }

        folderTitleEl.onClickEvent(() => {
            for (const child of childrenEl.childNodes as NodeListOf<HTMLElement>) {
                if (child.style.display === "block" || child.style.display === "") {
                    child.style.display = "none";
                    (collapseIconEl.childNodes[0] as HTMLElement).style.transform =
                        "rotate(-90deg)";
                    deck.activeFolders.delete(folderKey);
                } else {
                    child.style.display = "block";
                    (collapseIconEl.childNodes[0] as HTMLElement).style.transform = "";
                    deck.activeFolders.add(folderKey);
                }
            }
        });

        return folderEl;
    }

    private createFile(
        folderChildrenEl: HTMLElement,
        file: TFile,
        fileElActive: boolean,
        hidden: boolean,
        deck: ReviewDeck,
    ): void {
        const navFileEl: HTMLElement = folderChildrenEl.createDiv("nav-file");
        if (hidden) {
            navFileEl.style.display = "none";
        }

        const navFileTitle = navFileEl.createDiv("nav-file-title");
        if (fileElActive) {
            navFileTitle.addClass("is-active");
        }

        navFileTitle.createDiv("nav-file-title-content").setText(file.basename);

        navFileTitle.addEventListener(
            "click",
            async (event: MouseEvent) => {
                event.preventDefault();
                this.plugin.lastSelectedReviewDeck = deck.deckName;
                await this.app.workspace.getLeaf().openFile(file);
                return false;
            },
            false,
        );

        navFileTitle.addEventListener(
            "contextmenu",
            (event: MouseEvent) => {
                event.preventDefault();
                const fileMenu: Menu = new Menu();
                this.app.workspace.trigger("file-menu", fileMenu, file, "my-context-menu", null);
                fileMenu.showAtPosition({ x: event.pageX, y: event.pageY });
                return false;
            },
            false,
        );
    }

    private expandFolder(folderEl: HTMLElement): void {
        const collapseIconEl = folderEl.find("div.nav-folder-collapse-indicator");
        if (collapseIconEl) {
            (collapseIconEl.childNodes[0] as HTMLElement).style.transform = "";
        }
        const childrenEl = folderEl.find("div.nav-folder-children");
        if (childrenEl) {
            childrenEl.style.display = "";
        }
    }
}
