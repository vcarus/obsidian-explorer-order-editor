# Explorer Order Editor

An Obsidian plugin for setting a manual, drag-and-drop order for the folders
and notes inside a folder, without renaming files and without storing the
order somewhere that sync setups excluding `.obsidian/` (Dropbox, for
example) would drop.

![Right-clicking the file explorer, dragging the vault's top-level folders into a chosen order, and saving — after which the file explorer shows that order instead of the alphabetical one](docs/images/reorder.gif)

> **Requires [Custom File Explorer sorting](https://obsidian.md/plugins?id=custom-sort)**
> to have any visible effect. This plugin writes the order; that one renders
> it. See [below](#the-dependency-on-custom-file-explorer-sorting) for why.

## What it does

Right-click a folder and choose **Set explorer order** to get a dialog
listing its direct children; drag them into the order you want and **Save**.
The order is written to a `sortspec.md` inside that same folder. **Clear
explorer order**, in the same menu, removes it again — it only appears when
there is something of this plugin's to remove.

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
the folder — drops it from the order. Expect a brief flicker on rename: the
file explorer redraws before `sortspec.md` has been updated, so the renamed
item sits at the bottom for about half a second and then returns. Moving an
item *into* a folder does not insert it into that folder's order: there is no
way to know where you would want it, so it joins everything else the order
doesn't mention, at the end.

## The dependency on Custom File Explorer sorting

This plugin does not render the file explorer itself. It only writes
configuration. Actually reordering the file tree on screen is the job of the
[Custom File Explorer sorting](https://github.com/SebastianMC/obsidian-custom-sort)
community plugin (`custom-sort`), which **must be installed and enabled** for
anything you set here to have a visible effect. Without it, `sortspec.md`
still gets written correctly, but the file explorer keeps sorting
alphabetically.

This split is deliberate. `custom-sort` already solves "read a spec file and
reorder the tree accordingly" well, including cases this plugin doesn't try
to cover. Duplicating that logic — or worse, patching the file explorer's
internals directly, the way the now-abandoned Bartender plugin did — isn't
worth the risk. This plugin's whole job is to be a drag-and-drop editor for
the one slice of `custom-sort`'s syntax that means "a manual list of names,
in order."

After a save or a clear, this plugin runs `custom-sort`'s own refresh command
for you, since it doesn't otherwise notice that `sortspec.md` changed. That
can be turned off in settings if you'd rather trigger it yourself.

## How the order is stored

Each folder's order lives in a `sortspec.md` file inside that same folder
(the vault root's is just `sortspec.md` at the top level), under a
`sorting-spec` front matter key that `custom-sort` reads:

```yaml
---
sorting-spec: |
  target-folder: .
  // explorer-order-editor
  Meeting notes
  Requirements
  Subproject
  Archive
---
```

It is plain text in your own vault, so it syncs like any other note and
survives this plugin being uninstalled. A few things worth knowing:

- Notes are listed without their `.md` extension; every other file keeps its
  extension; folders use their plain name.
- Anything in the folder that isn't listed sorts to the end — you don't have
  to list everything, only what you want to pin.
- The `// explorer-order-editor` marker identifies a section this plugin
  wrote. **Clear explorer order** can only ever delete a marked section, so
  it cannot remove configuration you wrote by hand. Saving is less
  conservative: it replaces a hand-written section for the same folder, and
  the notice afterwards tells you it did.
- If a section covers this folder *together with others* (a multi-folder
  `target-folder:`), saving is refused outright rather than rewriting it,
  since editing it here would silently change those other folders too.
- Only the `sorting-spec` key and the file's own existence are ever touched.
  Other front matter keys, and any body text, are left byte-for-byte alone.

## Settings

The settings tab opens with a status row showing whether `custom-sort` was
detected. If it wasn't, you also get a notice when Obsidian starts, since
without it nothing you do here has a visible effect.

- **Automatically refresh after saving** (on by default) — re-run
  `custom-sort`'s refresh command after a save or a clear. When off, a
  notice tells you to run that command yourself.
- **Hide sortspec.md in the file explorer** (on by default) — ask
  `custom-sort` to hide `sortspec.md` from folders where you've saved an
  order, using its own item-hide syntax, so ordering twenty folders doesn't
  put twenty files into your tree. Only the file explorer is affected;
  search, the quick switcher and the graph still show the file. Turn this off
  to see it in place. Toggling applies immediately across the vault, in both
  directions: every section this plugin wrote is updated, and sections you
  wrote by hand are left alone.

## Known limitations

- A few names cannot be expressed in `custom-sort`'s syntax, which has no
  escape mechanism: names containing `...`, names with leading or trailing
  whitespace, and names whose first word is one of its reserved tokens
  (`%`, `/folders`, `--%`, `with-metadata:` and their relatives). The dialog
  lists these separately, below the orderable rows, each with a tooltip
  saying why; they aren't draggable, and like anything unlisted they sort to
  the end. Everything else still saves, and the notice afterwards names what
  was skipped. Names that merely *start* with such a token as part of a
  longer word — `%Report`, `--dashes` — are fine.
- `custom-sort` also reads a folder note (`FolderName/FolderName.md`, if one
  exists) as a sorting spec for that same folder. If that note has its own
  `sorting-spec` targeting the folder it lives in, it's a second,
  independent source of truth this plugin cannot reconcile — the dialog
  warns about it, but never edits the folder note.
- A rename can only be followed while this plugin is running. One made on
  another device, or with Obsidian closed, arrives as an already-renamed
  file, and that item loses its position — it sorts to the end until you drag
  it back. The stale name is dropped the next time that folder is saved.
- There is no multi-select drag; reordering is one row at a time.
- The order the dialog suggests for a folder with no saved order — folders
  first, then files, each by name with digit runs compared as numbers —
  approximates the file explorer rather than matching it. Obsidian exposes
  neither the explorer's current visual order nor its sort setting, so if
  you've set the explorer to anything other than name A→Z, the dialog's
  starting order will differ from what you see in the tree. It's a starting
  point to drag from; once saved, the order is explicit and identical
  everywhere.
- The filename `sortspec.md` is fixed. `custom-sort` always reads that
  specific name, so making it configurable would risk silently writing a file
  it never looks at.

## Installation

This plugin isn't in Obsidian's community plugin directory yet, so install it
with [BRAT](https://github.com/TfTHacker/obsidian42-brat), which installs
plugins straight from a GitHub repository and keeps them updated.

1. In Obsidian, open **Settings → Community plugins**, browse for **BRAT**,
   then install and enable it.
2. Open the command palette and run **BRAT: Plugins: Add a beta plugin for
   testing (with or without version)**.
3. Paste this repository's address:
   `https://github.com/vcarus/obsidian-explorer-order-editor`
   Leave the version empty to track the latest release.
4. BRAT downloads and enables the plugin. It checks for updates on startup,
   and you can update on demand with **BRAT: Plugins: Check for updates to
   all beta plugins and UPDATE**.
5. Install and enable
   [Custom File Explorer sorting](https://obsidian.md/plugins?id=custom-sort)
   from the community plugin directory as well — required, see above.

Once the plugin is in the community directory, you can remove it from BRAT
with **BRAT: Plugins: Remove a graduated plugin from BRAT (keep installed)**
and let Obsidian handle updates instead.

## Contributing

Development setup, the source layout and the release process are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).

This plugin is not a fork of, and contains no code from,
[Custom File Explorer sorting](https://github.com/SebastianMC/obsidian-custom-sort)
(GPL-3.0). It is an independent implementation that writes a configuration
file in the format that plugin reads, and asks it to refresh through a
command registered with Obsidian. The two are separate programs that
communicate through a data file; no linking is involved.
