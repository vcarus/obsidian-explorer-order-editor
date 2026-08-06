# Explorer Order Editor

An Obsidian plugin for setting a manual, drag-and-drop order for folders and
notes in the file explorer, and persisting that order into a `sortspec.md`
file inside the vault.

## Status

Early scaffolding (M0). No user-facing functionality exists yet.

## How it works (once built)

This plugin does not render the file explorer itself — it only edits
configuration. Rendering the custom order is the job of the
[Custom File Explorer sorting](https://github.com/SebastianMC/obsidian-custom-sort)
community plugin (`custom-sort`), which **this plugin requires to be
installed and enabled**. Without it, the order this plugin writes has no
visible effect in the file explorer.

The order for a folder is stored as a `sorting-spec` front matter key inside
a `sortspec.md` file in that folder, using the block format `custom-sort`
understands (a `target-folder: .` line plus one entry name per line). This
plugin writes that file; `custom-sort` reads it and reorders the file
explorer accordingly.

Keeping the order inside the vault (rather than in `.obsidian/`) means it
survives sync setups — such as Dropbox — that exclude `.obsidian/` from sync.

## Development

```bash
npm install
npm run dev     # esbuild watch; output goes straight into the test vault's plugin folder
npm test        # vitest
npm run lint    # eslint-plugin-obsidianmd
npm run build   # tsc -noEmit + production build, output to repo root
```

The test vault lives at `testvault/testvault/` (nested two levels). The
plugin builds into
`testvault/testvault/.obsidian/plugins/explorer-order-editor/`, which
contains an empty `.hotreload` file so the
[Hot Reload](https://github.com/pjeby/hot-reload) plugin picks up rebuilds
automatically. `custom-sort` 3.1.6 is pre-installed in the same vault under
`testvault/testvault/.obsidian/plugins/custom-sort/` for manual testing.

## License

MIT — see [LICENSE](./LICENSE).
