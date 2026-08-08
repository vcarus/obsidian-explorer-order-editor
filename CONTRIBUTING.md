# Contributing

## Development

```bash
npm install
npm run dev     # esbuild watch; output goes straight into the test vault's plugin folder
npm test        # vitest
npm run lint    # eslint-plugin-obsidianmd
npm run build   # tsc -noEmit + production build, output to repo root
```

`npm run build` also parses `styles.css` and exits non-zero on a syntax
error. Nothing else in the toolchain looks at CSS, and a CSS parser recovers
from a mistake by discarding everything up to the next block — so a stray
`*/` can silently delete a whole rule while lint, tsc and the tests all stay
green. The only other way to notice is to look at the running plugin.

The test vault lives at `testvault/testvault/` (nested two levels — that
inner folder is the vault Obsidian should be pointed at). The plugin builds
into `testvault/testvault/.obsidian/plugins/explorer-order-editor/`, which
contains an empty `.hotreload` file so the
[Hot Reload](https://github.com/pjeby/hot-reload) plugin picks up rebuilds
automatically. `custom-sort` is pre-installed in the same vault for manual
testing.

## Source layout

```
src/types.ts         Entry / EntryKind and the label shown for a row — the vocabulary the pure
                     layer and the UI share.
src/orderIndex.ts    Pure: the order index itself. Parse, serialize, mutate, salvage a damaged
                     note line by line, and merge recovery sources. Zero imports.
src/quarantine.ts    Pure: naming the copy kept when an unreadable order note is repaired, and
                     recognising those copies again later.
src/patch.ts         Pure: monkey-around's patch/remove contract, reimplemented. Removing our
                     patch must never detach one installed on top of it.
src/rowMove.ts       Pure: the index arithmetic behind the dialog's move-to-top/bottom buttons
                     and shortcuts.
src/navigation.ts    Pure: the judgments behind walking the tree in the dialog.
src/indexFile.ts     Imports obsidian. The runtime home of the index: loads it once at startup,
                     serves synchronous lookups, writes on a debounce, repairs when asked.
src/explorerSort.ts  Imports obsidian. Patches the file explorer's getSortedFolderItems so a
                     saved order is what the tree renders.
src/orderSync.ts     Keeps saved orders in step with the vault's rename and delete events.
src/OrderModal.ts    The drag-and-drop dialog.
src/ConfirmModal.ts  A yes/no dialog, used only before something destructive.
src/settings.ts      The settings tab, including the conditional migration, repair and prune rows.
src/main.ts          Plugin entry point: commands, the context menu, lifecycle.

src/sortspec.ts      Legacy, read-only. The pre-1.0 sortspec.md format, kept solely so the
src/frontmatter.ts   import command can read orders written by earlier versions. Nothing writes
src/sortspecFile.ts  this format any more. To be removed once the migration is retired.
src/sortspecMigration.ts   The two one-time commands that read the above into the index.
```

Everything without an `obsidian` import is covered by the `vitest` suites in
`test/`. `indexFile.ts`, `explorerSort.ts`, `orderSync.ts`, `OrderModal.ts`,
`settings.ts` and `main.ts` are exercised by hand in the test vault, so a
change to any of them needs a manual pass — nothing else will catch it.
Logic those need is pushed down into the pure modules wherever it can be,
precisely so it can be tested.

The file explorer patch is the one place this plugin reaches for an
undocumented API, and it is written to fail into the explorer's own ordering
rather than into a broken tree: the row shape is checked at runtime, and any
error returns the untouched original result. See the comments in
`explorerSort.ts` for what happened the one time that shape was assumed
rather than checked.

Writes never go through `app.fileManager.processFrontMatter`, and never
compute the new file text in advance: `Vault.process` re-reads the file when
it runs, which is what makes a write a genuine atomic read-modify-write.
Before overwriting an order note that cannot be parsed, the unreadable text
is always copied aside first.

## Releasing

Pushing a tag runs `.github/workflows/release.yml`, which builds and attaches
`main.js`, `manifest.json` and `styles.css` — the three files BRAT looks for
— to a **draft** release.

The tag must equal `manifest.json`'s version exactly, with no `v` prefix
(`npm version 0.4.1` produces one, since `.npmrc` sets an empty
`tag-version-prefix`). That is what Obsidian requires of a plugin release,
and the community directory checks it.

Then publish the draft. GitHub's "latest release" API skips drafts, so BRAT
cannot see one and nobody gets the update until it is published:

```bash
gh release edit <tag> --draft=false
```

`npm version` keeps `manifest.json`, `package.json` and `versions.json` in
step with the tag via `version-bump.mjs`. BRAT reads `id` and `version` from
the `manifest.json` attached to the release, and refuses to install if
`minAppVersion` is newer than the user's Obsidian.
