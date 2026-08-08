# Explorer Order Editor

An Obsidian plugin for setting a manual, drag-and-drop order for the folders
and notes inside a folder, without renaming files and without storing the
order somewhere that sync setups excluding `.obsidian/` (Dropbox, for
example) would drop.

![Right-clicking the file explorer, dragging the vault's top-level folders into a chosen order, and saving — after which the file explorer shows that order instead of the alphabetical one](docs/images/reorder.gif)

> Works on its own. The order lives in one plain-text note inside your
> vault, so it syncs with your notes, diffs in version control, and can be
> read and edited by hand. See [below](#how-the-order-is-stored).

## What it does

Right-click a folder and choose **Set explorer order** to get a dialog
listing its direct children; drag them into the order you want and **Save**.
The order is recorded in the plugin's order note. **Clear explorer order**,
in the same menu, removes it again — it only appears when that folder
actually has an order to remove.

For the vault root, right-click empty space below the last item in the file
explorer. There are also **Set explorer order for vault root** and **Clear
explorer order for vault root** commands, for binding a hotkey or for a
layout with no empty space left to click.

An order applies to **one folder only**; it does not cascade. Ordering
`Projects` rearranges the items directly inside it, while `Projects/Client A`
keeps sorting as it did until you give that folder its own order. There is
nothing to cascade — a manual order is a list of specific names, and those
names don't exist in the folders below.

So arranging a whole tree means visiting each folder in turn, which is why
the dialog lets you walk the tree without closing it. Every folder row has a
**›** button that opens that folder, and each level of the path at the top is
clickable, so getting from four levels deep back to the vault root is one
click rather than four. Nothing is saved behind your back: if you have
dragged rows, the control you are about to click says **Save and open "…"**
and does exactly that; if you have not touched anything, opening a folder
writes nothing at all.

![Opening a subfolder from inside the dialog: the path at the top gains a level, and the folder's own contents are listed ready to arrange](docs/images/subfolders.gif)

The dialog works on mobile as well as desktop — drag a row by its grip
handle, using a long press on touch. Dragging is not the only way to move a
row: each one has buttons that send it straight to the top or bottom, and on
desktop `Alt`+`↑`/`Alt`+`↓` nudge the focused row a step at a time while
`Alt`+`Shift`+`↑`/`Alt`+`Shift`+`↓` send it to either end.

Renaming an item keeps its position, and deleting it — or moving it out of
the folder — drops it from the order. Moving an item *into* a folder does not
insert it into that folder's order: there is no way to know where you would
want it, so it joins everything else the order doesn't mention, at the
end.

## How it renders

This plugin renders the saved order in the file explorer itself; nothing else
needs to be installed. It does that by wrapping the file explorer's internal
`getSortedFolderItems`. Names the stored order doesn't mention keep whatever
position Obsidian's own sort setting gives them, so a folder you have ordered
still respects your choice of name, modified time or anything else for
everything you didn't place by hand.

Only folders that actually have a saved order are touched; every other folder
is passed straight through. That method is not part of Obsidian's public API,
so the wrapper is written to fail quietly: on any unexpected result it hands
back the file explorer's own ordering untouched. The worst case is that a
saved order stops being applied, never a broken file tree.

After a save or a clear, the file explorer is asked to redraw right away.
That can be turned off in settings.

## How the order is stored

Every order in the vault lives in one note — `explorer-order.md` at the vault
root by default — in a fenced `json` block, one folder per line:

```json
{
  "Projects/Alpha": ["Design.md", "Notes", "TODO.md"],
  "Projects/Beta": ["b.md", "a.md"]
}
```

It is a plain note in your own vault, so it syncs like any other note, diffs
in version control, and can be read or edited by hand. A few things worth
knowing:

- Names are exactly as they appear in the vault, extensions included. Any
  name can be stored, whatever characters it contains.
- Anything in a folder that isn't listed sorts to the end — you don't have to
  list everything, only what you want to pin.
- One line per folder is deliberate: a three-way merge in git resolves
  conflicts per folder rather than on the whole file.
- Only the contents of that one fenced block are ever rewritten. Any prose you
  add around it, and any other block, is left byte-for-byte alone.
- If the block cannot be parsed, the plugin says so and **refuses to write**
  until you fix it, rather than overwriting a file it could not read.

If you used a version before 1.0, your orders are in per-folder `sortspec.md`
files. The settings tab grows two rows while any of those still exist:
**Import orders from sortspec.md files** copies them all into the order note
in one pass — only sections this plugin wrote, skipping folders that already
have an order, safe to run twice — and deletes nothing. Once you have checked
the result, **Delete imported sortspec.md files** removes the old ones, and
only for folders whose order actually made it into the note. Both rows
disappear once no sortspec.md is left, so a vault that started on 1.0 never
sees them.

## Settings

- **Automatically refresh after saving** (on by default) — update the file
  explorer as soon as an order is saved or cleared. When off, the change is
  still written immediately and shows up at the explorer's next refresh.
- **Hide the order note in the file explorer** (on by default) — keep
  `explorer-order.md` out of the tree, since it is a byproduct of using the
  plugin rather than something you wrote. Only the file explorer is affected;
  search, the quick switcher and the graph still show it. Turn this off to see
  it in place.

## Known limitations

- An order is keyed by folder path, so a folder renamed or moved **while this
  plugin isn't running** — on another device, or with the plugin disabled —
  leaves its order under a path nothing lives at any more. Renames made while
  it is running are followed automatically. Orders for folders that no longer
  exist are deliberately kept rather than pruned at startup, since a missing
  folder is just as likely to be sync lag as a real deletion.
- Every order lives in one file, so two devices reordering different folders
  at the same time can produce a sync conflict on that file, where the old
  per-folder layout could not. The one-line-per-folder format is what keeps a
  git merge resolving cleanly; Obsidian Sync will leave a conflict copy.
- There is no multi-select drag; reordering is one row at a time.
- The order the dialog suggests for a folder with no saved order — folders
  first, then files, each by name with digit runs compared as numbers —
  approximates the file explorer rather than matching it. The dialog reads the
  folder from the vault rather than from the explorer, so if you've set the
  explorer to anything other than name A→Z, the dialog's starting order will
  differ from what you see in the tree. It's a starting point to drag from;
  once saved, the order is explicit and identical everywhere. (The rendered
  result does follow your sort setting for anything you didn't place by hand —
  this is only about the dialog's initial suggestion.)

## Installation

In Obsidian, open **Settings → Community plugins → Browse**, search for
**Explorer Order Editor**, then install and enable it.

That is the whole installation — no companion plugin, no configuration.

From 0.5.0 onward this plugin needs **Obsidian 1.13 or newer**, which is what
lets its settings be declared to Obsidian rather than drawn by hand — that is
the form Obsidian's own settings search can read. On an older Obsidian you are
offered 0.4.2 instead, which is complete and fully working; you simply stop
receiving updates until you update the app.

To track pre-release builds instead, point
[BRAT](https://github.com/TfTHacker/obsidian42-brat) at
`https://github.com/vcarus/obsidian-explorer-order-editor`.

## Contributing

Development setup, the source layout and the release process are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).

This plugin is not a fork of, and contains no code from,
[Custom File Explorer sorting](https://github.com/SebastianMC/obsidian-custom-sort)
(GPL-3.0). Versions before 1.0 wrote a configuration file in the format that
plugin reads; the two were separate programs communicating through a data
file, with no linking involved. Since 1.0 there is no interoperation at all,
and the only remaining trace is factual: its published build was read to
confirm which file explorer method to wrap and what a patch remover must do
to coexist with another patch. Both are documented where they are relied on,
in `src/explorerSort.ts` and `src/patch.ts`.
