# Contributing

## Development

```bash
npm install
npm run dev     # esbuild watch; output goes straight into the test vault's plugin folder
npm test        # vitest
npm run lint    # eslint-plugin-obsidianmd
npm run build   # tsc -noEmit (src and test) + production build, output to repo root
```

All three of `lint`, `test` and `build` run in CI on pushes to `main` and on
every pull request. Run them locally anyway; CI is the last net, not the first.

`npm run build` also parses `styles.css` and exits non-zero on a syntax error.
Nothing else in the toolchain looks at CSS, and a CSS parser recovers from a
mistake by discarding everything up to the next block — so a stray `*/` can
silently delete a whole rule while lint, tsc and the tests all stay green. The
only other way to notice is to look at the running plugin.

The `tsc -p test` step in `build` is not redundant: eslint does not report
type errors, and the root `tsconfig.json` includes only `src/`. Without it,
nothing at all type-checks `test/`.

## A vault to test in

`npm run dev` writes its output to
`testvault/testvault/.obsidian/plugins/explorer-order-editor/`
(`esbuild.config.mjs`). **That vault is not in the repository** — `testvault/`
is git-ignored, because a vault is local scratch space rather than something
to ship. Create your own before the first `npm run dev`: point Obsidian's
*Open folder as vault* at `testvault/testvault/`, then let the build populate
the plugin folder. Add an empty `.hotreload` file beside the output if you use
the [Hot Reload](https://github.com/pjeby/hot-reload) plugin, which reloads the
plugin on every rebuild.

Anything that imports `obsidian` is verified in that vault by hand, so it is
worth filling with content chosen to break things rather than with lorem:

- Names that stress the format and the tree — a quote or a backslash in a
  filename, a file and a folder sharing a name, a note named like the order
  note, and a pair that differ only in Unicode normalisation (NFC/NFD), which
  look identical and must still sort deterministically.
- At least one folder with more items than fit on screen. Edge auto-scroll
  during a drag cannot be exercised in a folder you can see all of.

## Source layout

```
src/types.ts          Entry / EntryKind / displayLabel / compareNames / parentPathOf /
                      baseNameOf — the vocabulary the pure layer and the UI share.
src/orderIndex.ts     Pure: the index itself. Parse, serialize, mutate, salvage a damaged
                      note line by line, merge recovery sources. Zero imports.
src/rebuildStep.ts    Pure: the decision table for one attempt of the repair loop.
src/storeHealth.ts    Pure: the usable/unusable state machine. Evidence is a required
                      parameter, and the invariants are in the shape of the types.
src/quarantine.ts     Pure: naming the copy kept when an unreadable order note is
                      repaired, and recognising those copies again later.
src/patch.ts          Pure: monkey-around's patch/remove contract, reimplemented.
                      Removing our patch must never detach one installed on top of it.
src/rowMove.ts        Pure: the index arithmetic behind move-to-top/bottom and the
                      dialog's shortcuts.
src/entrySort.ts      Pure: the dialog's six Sort by options and their comparators.
src/navigation.ts     Pure: walking the tree inside the dialog (dirty checks, breadcrumb
                      truncation) and the order rows open in.
src/dropZone.ts       Pure: drop-zone geometry — which band of a row the pointer is in.
src/notices.ts        The single source of every user-facing string; the wording of a
                      refusal is changed here and nowhere else.
src/moveItem.ts       Imports obsidian. The four direct move actions and the write side
                      of in-tree drag and drop.
src/indexFile.ts      Imports obsidian. The runtime home of the index: loads it once at
                      startup, serves synchronous lookups, writes on a debounce, repairs
                      when asked. Also owns which file is the order note.
src/explorerSort.ts   Imports obsidian. Patches the file explorer's getSortedFolderItems
                      so a saved order is what the tree renders.
src/explorerDrag.ts   Imports obsidian. Takes over the file explorer's drag and drop in
                      the capture phase and draws the insertion line.
src/folderEntries.ts  Imports obsidian. Derives a folder's rows from folder.children,
                      excluding the order note.
src/fileExplorerLeaves.ts  Type-only import. Walks getLeavesOfType and filters out
                      deferred leaves. Every file explorer lookup goes through here.
src/orderSync.ts      Keeps saved orders in step with the vault's rename and delete events.
src/OrderModal.ts     The drag-and-drop dialog (SortableJS).
src/ConfirmModal.ts   A yes/no dialog, used only before something destructive.
src/settings.ts       The settings tab, including the rows that appear conditionally.
src/main.ts           Plugin entry point: the file menu, commands, lifecycle.
```

## Testing

Everything without an `obsidian` import is covered by the `vitest` suites in
`test/`. `indexFile.ts`, `explorerSort.ts`, `explorerDrag.ts`, `orderSync.ts`,
`OrderModal.ts`, `settings.ts`, `moveItem.ts`, `folderEntries.ts` and `main.ts`
are exercised by hand in the test vault, so a change to any of them needs a
manual pass — nothing else will catch it. **Judgments are pushed down into the
pure modules wherever they can be, precisely so they can be tested.**
`fileExplorerLeaves.ts` is the clearest case: "a deferred leaf is returned by
`getLeavesOfType` but its view has no such method" used to live in five places
and was testable in none.

`test/stubs/obsidian.ts` is a hand-written stand-in, swapped in at run time by
`resolve.alias` in `vitest.config.ts`. It never reaches the build: `obsidian`
is external to esbuild, and the root `tsconfig.json` compiles only `src/`.

- **Types always come from the real package.** Do not map `obsidian` to the
  stub with `paths` in `test/tsconfig.json` — that project also includes
  `../src/**`, so the mapping would check the whole of `src` against the stub's
  much smaller interface, replacing the only layer of real API checking there
  is. Tests that need the stub's extra affordances import it by path instead.
- **Assert our own control flow** — which branch ran, which outcome was
  reported, whether a failure was announced, whether a copy was kept.
- **Never assert timing, lifecycle or view behaviour.** Every expensive bug in
  this plugin has been Obsidian behaving differently from an assumption, and a
  stub written to the same assumption stays green right alongside the code.
- A green stub is not a release. The manual pass in `testvault/` is the
  authority.

## How the order is rendered

The saved order is not applied by asking Obsidian to sort differently; it *is*
the sort. `explorerSort.ts` wraps the file explorer view's internal
`getSortedFolderItems`, which is not public API, so the wrapper holds four
guardrails:

- Only folders that actually have a saved order are touched; everything else is
  passed straight through, keeping the user's own sort setting.
- The returned shape is checked at run time. The method returns the explorer's
  **row objects** (`{ file }`), not `TAbstractFile`, and a draft that assumed
  otherwise passed tsc, eslint and the whole suite while rendering every
  ordered folder empty.
- Any exception returns the original result, so a changed internal degrades to
  Obsidian's ordering rather than breaking the tree.
- The uninstaller restores the method only while it is still our own wrapper,
  so removing our patch cannot detach one installed on top of it.

`explorerDrag.ts` takes over drag and drop in the capture phase under the same
kind of rule: never call `preventDefault()` unless we are taking the drop over,
never call `stopPropagation()` at all, and fall back to native behaviour on any
error.

## Writing to the order note

Writes never go through `app.fileManager.processFrontMatter`, which
re-serializes the whole document, and never compute the new file text in
advance: `Vault.process` re-reads the file when it runs, which is what makes a
write a genuine atomic read-modify-write. Serializing the same index twice
produces identical bytes.

Damage is never repaired on a background event — only when the user asks for
something (a save, a move, a drop, a clear, or a settings row), because a note
being hand-edited passes through invalid JSON on every autosave. Before
overwriting an order note that cannot be parsed, the unreadable text is always
copied aside first, and those copies are never deleted automatically: they are
the only evidence of what a repair could not recover.

## Releasing

Pushing a tag runs `.github/workflows/release.yml`, which builds and attaches
`main.js`, `manifest.json` and `styles.css` — the three files BRAT looks for
— to a **draft** release.

The tag must equal `manifest.json`'s version exactly, with no `v` prefix
(`npm version 0.4.1` produces one, since `.npmrc` sets an empty
`tag-version-prefix`). That is what Obsidian requires of a plugin release, and
the community directory checks it.

Then publish the draft. GitHub's "latest release" API skips drafts, so BRAT
cannot see one and nobody gets the update until it is published:

```bash
gh release edit <tag> --draft=false
```

`npm version` keeps `manifest.json`, `package.json` and `versions.json` in step
with the tag via `version-bump.mjs`. BRAT reads `id` and `version` from the
`manifest.json` attached to the release, and refuses to install if
`minAppVersion` is newer than the user's Obsidian.

Before tagging, quit Obsidian completely and open it again with the final
build in place, and check that saved orders are still there. Hot reload and the
settings toggle do not go down that path, and it is the path that was broken in
1.0 through 1.2.1.
