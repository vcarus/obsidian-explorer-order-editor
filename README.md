# Explorer Order Editor

An Obsidian plugin for setting a manual, drag-and-drop order for the folders
and notes inside a folder, without renaming files and without storing the
order somewhere that sync setups excluding `.obsidian/` (Dropbox, for
example) would drop.

## What it does

Right-click a folder in the file explorer and choose **Set explorer order**
to open a dialog listing that folder's direct children. Drag them into the
order you want and hit **Save**. The order is written into a `sortspec.md`
file inside that same folder.

For the vault root, right-click empty space in the file explorer — below the
last item — and the same entries appear. There are also **Set explorer order
for vault root** and **Clear explorer order for vault root** commands, which
is the route to use if you'd rather bind a hotkey, or on a layout with no
empty space left to click.

**Clear explorer order** in the same context menu undoes this — it appears
only when there is a saved order to remove. It deletes what this plugin
wrote for that folder, cleaning up the now-unneeded `sorting-spec` key, the
front matter block, or the whole file, as each becomes empty.

An order applies to **one folder only**. It does not cascade into
subfolders: ordering `Projects` rearranges the items directly inside it,
while `Projects/Client A` keeps sorting the way it did until you give that
folder its own order. This also means ordering the vault root only
rearranges top-level items. There is nothing to cascade — a manual order is
a list of specific names, and those names don't exist in the folders below.

The dialog works on mobile as well as desktop; drag a row by its grip
handle, using a long press on touch.

Renaming an item keeps its position. A saved order is a list of names, so a
rename would otherwise leave the old name behind and the new one unlisted —
and anything unlisted sorts to the end, so the item you renamed would quietly
drop to the bottom of its folder. Instead the saved order is rewritten to
match, in place. Deleting an item, or moving it out of the folder, removes it
from the order the same way. Moving an item *into* a folder does not insert it
into that folder's order: there's no way to know where you'd want it, so it
joins everything else that order doesn't mention, at the end.

Expect a brief flicker on rename: the file explorer redraws before this
plugin has updated `sortspec.md`, so the renamed item sits at the bottom for
roughly half a second and then returns to its place. Obsidian reports a rename
only after the fact, and `custom-sort` re-sorts only when asked, so that gap
can't be closed — only kept short.

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
to cover (nested sorting groups, date-based sorting, and more). Duplicating
that logic — or worse, patching the file explorer's internals directly the
way the now-abandoned Bartender plugin did — isn't worth the risk. This
plugin's whole job is to be a drag-and-drop editor for the one slice of
`custom-sort`'s syntax that represents "a manual list of names, in order."

After a save or a clear, this plugin also runs `custom-sort`'s own refresh
command for you (it doesn't otherwise notice that `sortspec.md` changed), so
the new order shows up immediately. This can be turned off in settings if
you'd rather trigger it yourself.

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

A few things worth knowing about this format:

- Notes are listed without their `.md` extension; every other file keeps its
  extension; folders use their plain name.
- Anything in the folder that isn't listed sorts to the end, in whatever
  order the file explorer would otherwise use — you don't have to list
  everything, only what you want to pin.
- `sortspec.md` never lists itself: it's the file doing the listing.
- The `// explorer-order-editor` marker line identifies a section this
  plugin wrote, and it is what keeps hand-written configuration safe.
  **Clear explorer order** can only ever delete a marked section, so it
  cannot remove something you wrote yourself. Saving is less conservative:
  if a folder already has a hand-written `sorting-spec` section of its own,
  saving replaces it and the notice afterwards tells you it did. Back up
  anything you would not want overwritten before saving over it.
- If `sortspec.md` contains a section covering this folder *together with
  others* (a multi-folder `target-folder:` section), saving is refused
  outright rather than rewriting it, since editing it here would silently
  change the other folders too.
- Only the `sorting-spec` front matter key and the file's own existence are
  ever touched. Any other front matter keys, and any body text below the
  front matter, are left byte-for-byte untouched.

## Settings

The settings tab opens with a status row showing whether `custom-sort` was
detected. If it wasn't, you also get a notice when Obsidian starts, since
without it nothing you do here has a visible effect.

- **Automatically refresh after saving** (on by default) — re-run
  `custom-sort`'s refresh command after a save or a clear. When off, a
  notice tells you to run that command yourself.
- **Hide sortspec.md in the file explorer** (off by default) — ask
  `custom-sort` to hide `sortspec.md` from folders where you've saved an
  order, using `custom-sort`'s own item-hide syntax. Toggling this applies
  immediately across the vault, in both directions: every section this
  plugin wrote is updated, and sections you wrote by hand are left alone.
  Because those sections get rewritten, this also drops any stale entry
  from them — notably `sortspec` itself, which older versions of this plugin
  used to list.

## Known limitations

- Some names can't be represented in `custom-sort`'s syntax at all, because
  it has no escape mechanism: names containing `...` anywhere (its wildcard
  marker), names containing a backslash (in practice unreachable — Obsidian does not
  index such files at all), names with leading or trailing
  whitespace (every line is trimmed when parsed), and names whose first
  word is itself one of `custom-sort`'s reserved prefix tokens (`%`, `/`,
  `/folders`, `/:files`, `--%`, `/!`, `/+` and their close relatives — see
  the "sorting group type" and priority/combine prefixes in `custom-sort`'s
  own syntax). Such items are listed separately in the dialog, below the
  orderable ones, each with a tooltip explaining why; they aren't draggable,
  since there's no order for them to take — they always sort to the end,
  like anything else that isn't listed. Saving still works for everything
  else, and the notice afterwards names what was skipped.
  Names that merely *start* with one of those tokens as a prefix of a longer
  word — `%Report`, `--dashes`, `<x` — are fine: they get written with an
  explicit `/folders ` or `/:files ` prefix, which is also how a folder and
  a note sharing one name are told apart. It's only when the reserved token
  is a complete leading word (the whole name, or followed by a space) that
  prefixing can't help: `/folders ` in front of a name that is itself, say,
  `--% hidden` gives `custom-sort` two prefixes to recognize on one line,
  which it rejects outright — and unlike a single unrepresentable item, that
  specific failure suspends the whole plugin, dropping every folder's order
  in the vault. So those names are skipped instead of guessed at.
  Names beginning with `with-metadata:`, `bookmarked:` or `with-icon:` are
  skipped for a related reason: `custom-sort` reads those as instructions to
  match items *by* a metadata field, a bookmark, or an icon, and it looks for
  them after stripping any prefix, so a prefix can't mark them as literal
  names. Writing one would not only lose that item's position but turn its
  line into a live matching rule capable of dragging an unrelated file into
  that spot.
- `custom-sort` also reads a folder note (`FolderName/FolderName.md`, if one
  exists) as a sorting spec for that same folder. If that note has its own
  `sorting-spec` targeting the folder it lives in, it's a second,
  independent source of truth that this plugin cannot reconcile — the
  dialog detects and warns about this, but does not edit the folder note.
- A rename can only be followed while this plugin is running. One made on
  another device, or with Obsidian closed, arrives as an already-renamed file,
  and that item loses its position — it sorts to the end until you drag it
  back. The stale name is dropped from `sortspec.md` the next time that
  folder's order is saved.
- There is no multi-select drag; reordering is one row at a time.
- The order the dialog suggests for a folder with no saved order — folders
  first, then files, each by name with digit runs compared as numbers —
  approximates the file explorer rather than matching it. Obsidian exposes
  neither the explorer's current visual order nor its sort setting, so if
  you've set the explorer to anything other than name A→Z, the dialog's
  starting order will differ from what you see in the tree. It's a starting
  point to drag from; once saved, the order is explicit and identical
  everywhere.
- The filename `sortspec.md` is fixed; there is no setting to rename it.
  `custom-sort` always reads that specific filename, so making it
  configurable here would risk silently writing a file `custom-sort` never
  looks at.

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

## Development

```bash
npm install
npm run dev     # esbuild watch; output goes straight into the test vault's plugin folder
npm test        # vitest
npm run lint    # eslint-plugin-obsidianmd
npm run build   # tsc -noEmit + production build, output to repo root
```

The test vault lives at `testvault/testvault/` (nested two levels — that
inner folder is the vault Obsidian should be pointed at). The plugin builds
into `testvault/testvault/.obsidian/plugins/explorer-order-editor/`, which
contains an empty `.hotreload` file so the
[Hot Reload](https://github.com/pjeby/hot-reload) plugin picks up rebuilds
automatically. `custom-sort` is pre-installed in the same vault under
`testvault/testvault/.obsidian/plugins/custom-sort/` for manual testing.

### Releasing

Pushing a tag runs `.github/workflows/release.yml`, which builds and attaches
`main.js`, `manifest.json` and `styles.css` — the three files BRAT looks for
— to a **draft** release.

The tag must equal `manifest.json`'s version exactly, with no `v` prefix
(`git tag -a 0.2.0 -m "0.2.0"`): that is what Obsidian requires of a plugin
release, and the community directory checks it.

Publish that draft. GitHub's "latest release" API skips drafts, so BRAT
cannot see one, and testers get nothing until it is published.

Keep `manifest.json` and `versions.json` in step with the tag: BRAT reads
`id` and `version` from the `manifest.json` attached to the release, and
refuses to install if the plugin's `minAppVersion` is newer than the user's
Obsidian.

### Source layout

```
src/types.ts         Entry / EntryKind — the vocabulary shared by the pure layer and the UI.
src/sortspec.ts      Pure: parse/serialize/upsert/remove the sorting-spec value, plus name encoding and decoding.
src/frontmatter.ts   Pure: locating and splicing the sorting-spec key within a file's front matter.
src/sortspecFile.ts  The only module importing `obsidian` for data access: TFolder to entries, reading and
                     writing sortspec.md, triggering custom-sort.
src/orderSync.ts     Keeps a saved order in step with the vault's rename and delete events.
src/OrderModal.ts    The drag-and-drop dialog.
src/settings.ts      The settings tab.
src/main.ts          Plugin entry point: commands, the context menu, lifecycle.
```

`types.ts`, `sortspec.ts` and `frontmatter.ts` have no dependency on the
`obsidian` package (front matter parsing is injected as a parameter), so
they're covered by the `vitest` unit tests in `test/`; `sortspecFile.ts`,
`orderSync.ts`, `OrderModal.ts`, and `main.ts` are exercised by hand in the
test vault. Logic those four need is pushed down into the pure modules
wherever it can be, precisely so it can be tested.

Writes never go through `app.fileManager.processFrontMatter` — it
re-serializes the entire YAML block, which can strip comments and hard-wrap
long lines in ways that would corrupt file names. Instead, writes locate the
exact line range the `sorting-spec` value occupies and splice in new text
directly, leaving everything else in the file untouched, then re-read and
verify the result before treating the write as successful.

## License

MIT — see [LICENSE](./LICENSE).

This plugin is not a fork of, and contains no code from,
[Custom File Explorer sorting](https://github.com/SebastianMC/obsidian-custom-sort)
(GPL-3.0). It is an independent implementation that writes a configuration
file in the format that plugin reads, and asks it to refresh through a
command registered with Obsidian. The two are separate programs that
communicate through a data file; no linking is involved.
