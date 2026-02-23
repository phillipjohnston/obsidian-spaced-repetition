# Due Today Sidebar View Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a new Obsidian sidebar leaf that shows only notes due today (and overdue), grouped by deck as collapsible dropdowns.

**Architecture:** Create a new `ItemView` subclass (`DueTodayView`) in `src/due-today-view.ts` following the same pattern as the existing `ReviewQueueListView` in `src/sidebar.ts`. Register it in `main.ts` alongside the existing view, add a command to open it, and add locale strings. The view reads directly from `plugin.reviewDecks` (already populated by `sync()`), filters to notes where `dueUnix <= end-of-today`, and groups them by deck. No new data structures needed.

**Tech Stack:** TypeScript, Obsidian Plugin API (`ItemView`, `WorkspaceLeaf`, `Menu`, `TFile`), existing plugin data model (`ReviewDeck`, `SchedNote`).

---

### Task 1: Add locale strings

**Files:**
- Modify: `src/lang/locale/en.ts`

**Context:**
The locale file exports a single default object. New keys are referenced via `t("KEY")` from `src/lang/helpers.ts`. Every string shown in the UI needs a key here.

**Step 1: Add the new keys**

Open `src/lang/locale/en.ts` and add these entries to the `// sidebar.ts` section (or append after it):

```typescript
    // due-today-view.ts
    DUE_TODAY_VIEW_TITLE: "Due Today",
    DUE_TODAY_OPEN_CMD: "Open Due Today pane",
    DUE_TODAY_OVERDUE: "Overdue",
    DUE_TODAY_NEW: "New",
    DUE_TODAY_EMPTY: "Nothing due today",
    DUE_TODAY_COUNT: "${count} due",
```

**Step 2: Verify the file compiles (no syntax errors)**

Run: `npm run build` (or `npx tsc --noEmit`)
Expected: No TypeScript errors from the locale file.

**Step 3: Commit**

```bash
git add src/lang/locale/en.ts
git commit -m "feat(due-today): add locale strings for Due Today view"
```

---

### Task 2: Create the DueTodayView

**Files:**
- Create: `src/due-today-view.ts`

**Context:**
- The existing `ReviewQueueListView` (`src/sidebar.ts`) is the reference implementation. Study its `redraw()`, `createRightPaneFolder()`, and `createRightPaneFile()` methods — copy that exact DOM structure (Obsidian CSS classes).
- `ReviewDeck` fields relevant here:
  - `deck.deckName: string` — display name
  - `deck.newNotes: TFile[]` — unscheduled notes (no due date)
  - `deck.scheduledNotes: SchedNote[]` — sorted by `dueUnix` ascending
  - `deck.dueNotesCount: number` — count of notes where `dueUnix <= now`
  - `deck.activeFolders: Set<string>` — tracks which sub-folders are expanded (used for collapse state persistence)
- A note is **overdue** when `dueUnix < startOfToday`.
- A note is **due today** when `startOfToday <= dueUnix <= endOfToday`.
- `endOfToday` = `moment().endOf('day').valueOf()` (use `window.moment`).
- The `COLLAPSE_ICON` SVG from `src/constants.ts` is used for the collapse triangle, rotated `-90deg` when collapsed.
- View type constant: `DUE_TODAY_VIEW_TYPE = "due-today-view"`.
- Icon: reuse `"SpacedRepIcon"` (already registered by the plugin).

**Step 1: Write the file**

```typescript
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
        const now = Date.now();
        const endOfToday = window.moment().endOf("day").valueOf();

        const rootEl: HTMLElement = createDiv("nav-folder mod-root");
        const childrenEl: HTMLElement = rootEl.createDiv("nav-folder-children");

        let totalDue = 0;

        for (const deckKey in this.plugin.reviewDecks) {
            const deck: ReviewDeck = this.plugin.reviewDecks[deckKey];

            // Collect overdue notes (dueUnix < start of today)
            const overdueNotes: SchedNote[] = deck.scheduledNotes.filter(
                (sn) => sn.dueUnix <= endOfToday,
            );

            // Only render deck if it has anything due today or new notes
            const hasDueContent = overdueNotes.length > 0 || deck.newNotes.length > 0;
            if (!hasDueContent) {
                continue;
            }

            totalDue += overdueNotes.length;

            const deckCollapsed = !deck.activeFolders.has(deckKey + ":due-today");

            const deckFolderEl: HTMLElement = this.createFolder(
                childrenEl,
                `${deckKey} (${overdueNotes.length})`,
                deckCollapsed,
                false,
                deck,
                deckKey + ":due-today",
            ).getElementsByClassName("nav-folder-children")[0] as HTMLElement;

            // New (unscheduled) notes sub-folder
            if (deck.newNotes.length > 0) {
                const newFolderKey = deckKey + ":due-today:new";
                const newFolderCollapsed = !deck.activeFolders.has(newFolderKey);
                const newFolderEl = this.createFolder(
                    deckFolderEl,
                    t("DUE_TODAY_NEW"),
                    newFolderCollapsed,
                    deckCollapsed,
                    deck,
                    newFolderKey,
                );

                for (const file of deck.newNotes) {
                    const fileIsOpen = activeFile && file.path === activeFile.path;
                    if (fileIsOpen) {
                        deck.activeFolders.add(deckKey + ":due-today");
                        deck.activeFolders.add(newFolderKey);
                        this.expandFolder(newFolderEl);
                        this.expandFolderInParent(deckFolderEl);
                    }
                    this.createFile(
                        newFolderEl,
                        file,
                        fileIsOpen,
                        newFolderCollapsed,
                        deck,
                    );
                }
            }

            // Due / overdue notes — render without sub-grouping (flat list)
            for (const sNote of overdueNotes) {
                const fileIsOpen = activeFile && sNote.note.path === activeFile.path;
                if (fileIsOpen) {
                    deck.activeFolders.add(deckKey + ":due-today");
                    this.expandFolderInParent(deckFolderEl);
                }
                this.createFile(
                    { getElementsByClassName: (cls: string) => deckFolderEl.getElementsByClassName(cls) } as HTMLElement,
                    sNote.note,
                    fileIsOpen,
                    deckCollapsed,
                    deck,
                );
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
        parentEl: HTMLElement,
        file: TFile,
        fileElActive: boolean,
        hidden: boolean,
        deck: ReviewDeck,
    ): void {
        const navFileEl: HTMLElement = parentEl
            .getElementsByClassName("nav-folder-children")[0]
            .createDiv("nav-file");
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
        (collapseIconEl.childNodes[0] as HTMLElement).style.transform = "";
    }

    private expandFolderInParent(parentChildrenEl: HTMLElement): void {
        // parentChildrenEl is the nav-folder-children div inside a deck folder
        // Walk up to the nav-folder, then find the collapse icon in its nav-folder-title
        const folderEl = parentChildrenEl.closest(".nav-folder");
        if (folderEl) {
            const collapseIconEl = folderEl.find("div.nav-folder-collapse-indicator");
            if (collapseIconEl) {
                (collapseIconEl.childNodes[0] as HTMLElement).style.transform = "";
            }
        }
    }
}
```

> **NOTE:** The `createFile` method above has a subtle bug in how due notes are added directly to the deck folder — see Task 3 for the fix. Write this file first, then we'll fix in Task 3 after seeing the TypeScript errors.

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Zero errors (or only errors about the `createFile` call with the cast — fix those in Task 3).

**Step 3: Commit**

```bash
git add src/due-today-view.ts
git commit -m "feat(due-today): add DueTodayView skeleton"
```

---

### Task 3: Fix the due-notes rendering in DueTodayView

**Files:**
- Modify: `src/due-today-view.ts`

**Context:**
The `createFile` method expects an `HTMLElement` with a `nav-folder-children` child inside it. The `deckFolderEl` variable in `redraw()` IS already the `nav-folder-children` element (extracted with `.getElementsByClassName("nav-folder-children")[0]`). So passing it with a cast works, but it's confusing. A cleaner fix: make `createFile` accept the `nav-folder-children` element directly and call `createDiv("nav-file")` on it.

Replace the existing `createFile` signature and its call sites:

**Step 1: Update `createFile` to take the children container directly**

Change the signature from:
```typescript
private createFile(
    parentEl: HTMLElement,
    ...
```
to:
```typescript
private createFile(
    folderChildrenEl: HTMLElement,
    ...
```

And change the first line of the method body from:
```typescript
const navFileEl: HTMLElement = parentEl
    .getElementsByClassName("nav-folder-children")[0]
    .createDiv("nav-file");
```
to:
```typescript
const navFileEl: HTMLElement = folderChildrenEl.createDiv("nav-file");
```

**Step 2: Fix call sites in `redraw()`**

For the new-notes sub-folder call site, change:
```typescript
this.createFile(
    newFolderEl,
    file,
    ...
```
to:
```typescript
this.createFile(
    newFolderEl.getElementsByClassName("nav-folder-children")[0] as HTMLElement,
    file,
    ...
```

For the due/overdue notes call site, remove the awkward cast entirely and pass `deckFolderEl` directly (it's already the `nav-folder-children` element):
```typescript
this.createFile(
    deckFolderEl,
    sNote.note,
    fileIsOpen,
    deckCollapsed,
    deck,
);
```

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Zero errors.

**Step 4: Commit**

```bash
git add src/due-today-view.ts
git commit -m "fix(due-today): clean up createFile to accept folder-children element directly"
```

---

### Task 4: Register the view and add a command in main.ts

**Files:**
- Modify: `src/main.ts`

**Context:**
- `initView()` is called from `onload()` via `this.app.workspace.onLayoutReady(...)`.
- `onunload()` detaches all leaves of the registered view type.
- After `sync()` completes, if the existing review pane is enabled, `this.reviewQueueView.redraw()` is called — we need to also call `this.dueTodayView.redraw()` if it exists.
- The new view is **not** auto-opened on startup (to keep it opt-in); users open it with a command.

**Step 1: Add the import**

At the top of `src/main.ts`, alongside the existing sidebar import:
```typescript
import { DueTodayView, DUE_TODAY_VIEW_TYPE } from "src/due-today-view";
```

**Step 2: Add a private field on the plugin class**

In the `SRPlugin` class body, near `private reviewQueueView: ReviewQueueListView;`:
```typescript
private dueTodayView: DueTodayView;
```

**Step 3: Add a command to open the view**

In `onload()`, after the existing `addCommand` blocks and before `addSettingTab`, add:
```typescript
this.addCommand({
    id: "srs-open-due-today-view",
    name: t("DUE_TODAY_OPEN_CMD"),
    callback: () => {
        this.openDueTodayView();
    },
});
```

**Step 4: Register and open the view in `initView()`**

After the existing `this.registerView(REVIEW_QUEUE_VIEW_TYPE, ...)` block, add:
```typescript
this.registerView(
    DUE_TODAY_VIEW_TYPE,
    (leaf) => (this.dueTodayView = new DueTodayView(leaf, this)),
);
```

**Step 5: Add `openDueTodayView()` helper method**

Add this private method to `SRPlugin`, near `initView()`:
```typescript
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
```

**Step 6: Redraw the Due Today view after sync**

In the `sync()` method, find the block:
```typescript
if (this.data.settings.enableNoteReviewPaneOnStartup) {
    this.reviewQueueView.redraw();
}
```

Add after it:
```typescript
const dueTodayLeaves = this.app.workspace.getLeavesOfType(DUE_TODAY_VIEW_TYPE);
if (dueTodayLeaves.length > 0 && this.dueTodayView) {
    this.dueTodayView.redraw();
}
```

**Step 7: Detach in `onunload()`**

In `onunload()`, after the existing detach line, add:
```typescript
this.app.workspace.getLeavesOfType(DUE_TODAY_VIEW_TYPE).forEach((leaf) => leaf.detach());
```

**Step 8: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Zero errors.

**Step 9: Commit**

```bash
git add src/main.ts
git commit -m "feat(due-today): register DueTodayView and add open command"
```

---

### Task 5: Build and smoke-test

**Step 1: Build the plugin**

Run: `npm run build`
Expected: Build succeeds, `main.js` is emitted with no errors.

**Step 2: Manual smoke test in Obsidian**

1. Reload the plugin (or restart Obsidian).
2. Open the command palette (`Cmd+P`) and run `"Open Due Today pane"`.
3. Expected: A new leaf opens in the right sidebar titled "Due Today".
4. If you have notes with `sr-due` dates set to today or earlier, they should appear grouped by their deck tag (e.g., `#review`).
5. Click a deck header — it should collapse/expand.
6. Click a note — it should open the note.
7. Right-click a note — Obsidian's file menu should appear.
8. Run `sync` command, then check the Due Today view refreshes.

**Step 3: Commit**

```bash
git add main.js  # or whatever the build output file is
git commit -m "build: compile Due Today view"
```

---

## Notes for Implementer

### Key gotchas

1. **`activeFolders` key collisions** — The existing `ReviewQueueListView` uses `deck.deckName` and `t("TODAY")` etc. as keys in `deck.activeFolders`. The `DueTodayView` uses `deckKey + ":due-today"` as its keys to avoid collisions. This means collapse state is independent between the two views.

2. **`window.moment`** — Obsidian bundles Moment.js as `window.moment`. Don't import moment directly; use `window.moment()`.

3. **`expandFolderInParent`** — `deckFolderEl` in `redraw()` is the `nav-folder-children` div (extracted via `getElementsByClassName`), not the `nav-folder` div itself. The `expandFolderInParent` helper uses `.closest(".nav-folder")` to walk up, which works correctly.

4. **Empty state** — The empty state message (`DUE_TODAY_EMPTY`) is only shown when there ARE decks but nothing is due. If `reviewDecks` is empty (sync not yet run), nothing is rendered — this matches the behavior of the existing sidebar.

5. **`dueTodayView` may be undefined** — The field is only set when Obsidian instantiates the view (i.e., when the leaf is opened). Always guard with `if (this.dueTodayView)` before calling `.redraw()`.

### File map

| File | Change |
|------|--------|
| `src/due-today-view.ts` | **Create** — new `ItemView` subclass |
| `src/lang/locale/en.ts` | **Modify** — add 5 locale strings |
| `src/main.ts` | **Modify** — import, field, command, register, redraw, detach |
