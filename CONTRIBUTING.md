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
src/types.ts         Entry / EntryKind — the vocabulary shared by the pure layer and the UI.
src/sortspec.ts      Pure: parse/serialize/upsert/remove the sorting-spec value, plus name encoding and decoding.
src/frontmatter.ts   Pure: locating and splicing the sorting-spec key within a file's front matter.
src/rowMove.ts       Pure: the index arithmetic behind the dialog's move-to-top/bottom buttons and shortcuts.
src/navigation.ts    Pure: the judgments behind walking the tree in the dialog — whether anything has been
                     dragged since the level was drawn, and which levels of a deep path stay visible.
src/sortspecFile.ts  The only module importing `obsidian` for data access: TFolder to entries, reading and
                     writing sortspec.md, triggering custom-sort.
src/orderSync.ts     Keeps a saved order in step with the vault's rename and delete events.
src/OrderModal.ts    The drag-and-drop dialog.
src/settings.ts      The settings tab.
src/main.ts          Plugin entry point: commands, the context menu, lifecycle.
```

`types.ts`, `sortspec.ts`, `frontmatter.ts`, `rowMove.ts` and `navigation.ts`
have no dependency on the `obsidian` package (front matter parsing is
injected as a parameter), so they're covered by the `vitest` unit tests in
`test/`; `sortspecFile.ts`, `orderSync.ts`, `OrderModal.ts` and `main.ts` are
exercised by hand in the test vault. Logic those four need is pushed down
into the pure modules wherever it can be, precisely so it can be tested — a
change to any of the four needs a manual pass in the vault, because nothing
else will catch it.

Writes never go through `app.fileManager.processFrontMatter`: it
re-serializes the entire YAML block, which can strip comments and hard-wrap
long lines in ways that would corrupt file names. Instead, writes locate the
exact line range the `sorting-spec` value occupies and splice in new text
directly through `Vault.process`, leaving everything else byte-for-byte
untouched, then re-read and verify the result before treating the write as
successful.

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
