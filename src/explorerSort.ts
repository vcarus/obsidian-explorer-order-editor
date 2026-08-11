/**
 * Patches the file explorer to render the order this plugin stores.
 *
 * Since 1.0 there is a single vault-level order index (`orderIndex.ts`,
 * held in memory by `IndexFileStore`) and this is the only thing that ever
 * renders it — there is no longer a separately-installed renderer (the old
 * custom-sort integration) to defer to, so the rule is simply "override
 * folders the index has an order for, pass everything else through
 * untouched."
 *
 * Deliberately thin: every judgment that doesn't need a live
 * `TFolder`/`TAbstractFile` — reconciling a stored order against live
 * siblings — is already pure (`mergeOrder` in `orderIndex.ts`). This file's
 * own job is narrow: locate the file explorer view, patch its prototype,
 * read the in-memory index synchronously, and map the resulting order back
 * onto the live item objects `getSortedFolderItems` already produced.
 *
 * The `getSortedFolderItems` patch itself mirrors exactly how custom-sort
 * patches the same method (verified against its bundled `main.js`: it
 * monkey-patches `leaf.view.constructor.prototype.getSortedFolderItems` with
 * its own `around`-style helper — the same contract `patch.ts` reimplements)
 * — the one place this project patches the file tree, under the four
 * guardrails CLAUDE.md's patch rule lists. Beyond those, this never touches
 * the DOM the file explorer builds, never calls a private renderer, and
 * always falls back to the explorer's own result on any error.
 */
import { App, normalizePath, Plugin, TAbstractFile, TFile, TFolder, type View } from 'obsidian';
import { folderIndexKey, type IndexFileStore } from './indexFile';
import { mergeOrder } from './orderIndex';
import { aroundPrototypeMethod } from './patch';
import type { ExplorerOrderEditorSettings } from './settings';

/**
 * `getSortedFolderItems` and `requestSort` are not part of Obsidian's public
 * typed API — they live on the file explorer's own internal view subclass,
 * not on the base `View` every leaf's `.view` is typed as (confirmed against
 * custom-sort's bundled source, which checks for both members by name before
 * trusting a leaf is really the file explorer — the same two this interface
 * declares). A local interface plus a runtime guard, rather than a `declare
 * module 'obsidian'` augmentation on `View` itself: augmenting `View` would
 * make every *other* view (markdown, graph, ...) wrongly appear to have
 * these two members too.
 */
interface FileExplorerView extends View {
	getSortedFolderItems(folder: TFolder): FileExplorerItem[];
	requestSort(): void;
}

/**
 * `getSortedFolderItems` returns the file explorer's own *row* objects, not
 * `TAbstractFile`s — each row wraps the file it renders. Verified in
 * custom-sort's bundled `main.js`, whose replacement for this same method
 * ends with `a.sort(s), a.map(m => o[m.path])` where `o = this.fileItems`:
 * it sorts `TAbstractFile`s and then maps each one back through the view's
 * `fileItems` index before returning. So the array in and the array out are
 * both rows, and `.file` is how you get from one to the other.
 *
 * Declaring only `.file` deliberately: it is all this module reads. Getting
 * this shape wrong is not a theoretical concern — an earlier draft of this
 * file typed the return as `TAbstractFile[]`, which type-checked (the
 * interface is our own assertion about an untyped internal, so nothing could
 * contradict it), made every `instanceof TFile` check silently false, and
 * would have rendered every ordered folder as empty. Hence the runtime shape
 * guard in the replacement below: a wrong assumption here has to fail into
 * the explorer's own ordering, not into an empty file tree.
 */
interface FileExplorerItem {
	readonly file: TAbstractFile;
}

function isFileExplorerView(view: View): view is FileExplorerView {
	const candidate = view as Partial<FileExplorerView>;
	return typeof candidate.getSortedFolderItems === 'function' && typeof candidate.requestSort === 'function';
}

type GetSortedFolderItemsFn = (this: FileExplorerView, folder: TFolder) => FileExplorerItem[];

/**
 * Structural slice of `Plugin`, matching `OrderSyncHost`/`SettingsHost`
 * elsewhere — avoids a circular import against `main.ts`.
 */
export interface ExplorerSortHost extends Plugin {
	settings: ExplorerOrderEditorSettings;
	store: IndexFileStore;
}

/**
 * Builds the `getSortedFolderItems` replacement for one file explorer view.
 */
function buildReplacement(host: ExplorerSortHost): (original: GetSortedFolderItemsFn) => GetSortedFolderItemsFn {
	const { store } = host;

	return (original) =>
		function replacement(this: FileExplorerView, folder: TFolder): FileExplorerItem[] {
			// Always computed first and kept as the fallback: the explorer's
			// own ordering under whatever sort setting the user has chosen,
			// and the raw material our own reorder works from. No I/O here,
			// so nothing before this line needs the try/catch below.
			const items = original.call(this, folder);

			try {
				const indexNotePath = normalizePath(host.settings.indexPath);
				const stored = store.get(folderIndexKey(folder));

				// Entries derived in the *items' own* order — this is what
				// makes the result agree with the explorer's current sort
				// setting for anything the stored order doesn't mention,
				// instead of falling back to `fallbackEntryOrder`'s alphabetic
				// guess. The index note itself is tracked separately: it never
				// participates in `mergeOrder`, and is re-appended or omitted
				// below based on the "hide" setting alone.
				let indexFileItem: FileExplorerItem | null = null;
				const liveNames: string[] = [];
				const itemByName = new Map<string, FileExplorerItem>();
				for (const item of items) {
					const file: unknown = item?.file;
					// The shape guard the doc comment on `FileExplorerItem`
					// documents. A row that isn't wrapping a file or a folder
					// means our assumption about this internal no longer
					// holds, and the only safe answer is to render nothing of
					// our own.
					if (!(file instanceof TFile) && !(file instanceof TFolder)) return items;

					if (file instanceof TFile && file.path === indexNotePath) {
						indexFileItem = item;
						continue;
					}
					liveNames.push(file.name);
					itemByName.set(file.name, item);
				}

				// Nothing stored for this folder, and no reason to touch the
				// order anyway — the common case, kept cheap. The index note
				// counts as a reason only when it is actually being hidden:
				// with hiding off and nothing stored, rebuilding the array
				// would re-append that note at the end, moving it out of the
				// position the explorer's own sort just gave it, in a folder
				// the user never ordered at all.
				if (stored === undefined && (indexFileItem === null || !host.settings.hideIndexFile)) return items;

				// Every item was classified as *either* the index note *or* a
				// real sibling above, so `liveNames` can only be empty here if
				// the folder holds nothing but the index note — legitimate,
				// not a bug. If it's empty for any other reason while there
				// were items to begin with, that's the exact shape of the
				// internal-assumption bug the guard above already returns out
				// of; this is a second, redundant catch of the same case on
				// the way out, in case some future change to the loop above
				// ever lets it slip past the first one.
				if (liveNames.length === 0 && indexFileItem === null && items.length > 0) return items;

				const merged = mergeOrder(stored, liveNames);
				const result: FileExplorerItem[] = [];
				for (const name of merged) {
					const item = itemByName.get(name);
					// Always found: `merged` only ever contains names that
					// came from `liveNames`, and every `liveNames` entry has a
					// corresponding `itemByName` mapping by construction. The
					// guard exists so a future change to that invariant fails
					// safe (skips one item) instead of pushing `undefined`.
					if (item !== undefined) result.push(item);
				}

				if (indexFileItem !== null && !host.settings.hideIndexFile) {
					result.push(indexFileItem);
				}

				return result;
			} catch (err) {
				// Obsidian's internals changed under us, or something above
				// misbehaved: degrade to the explorer's own ordering rather
				// than let the file explorer break. Logged once per call, not
				// deduplicated.
				console.error('[explorer-order-editor] failed to render the saved explorer order, falling back to the default sort', err);
				return items;
			}
		};
}

/**
 * Installs the patch on `view`'s constructor prototype — once per file
 * explorer view class, not per instance, since Obsidian only ever
 * constructs one file explorer view class and every leaf of that type
 * shares its prototype. Registers the remover with `host.register` so
 * unloading the plugin restores `getSortedFolderItems` untouched, then
 * immediately asks the view to redraw so an already-open file explorer
 * reflects any order already saved, without waiting for an unrelated
 * refresh to trigger one.
 */
function installOnView(host: ExplorerSortHost, view: FileExplorerView): void {
	const remove = aroundPrototypeMethod<GetSortedFolderItemsFn>(
		view.constructor.prototype as Record<string, unknown>,
		'getSortedFolderItems',
		buildReplacement(host),
	);
	host.register(remove);
	view.requestSort();
}

/**
 * Wires up the file explorer patch. Call once, from `onLayoutReady` — plugin
 * load order is not guaranteed any earlier, and the file explorer leaf
 * itself may not exist yet the first time this runs. When it doesn't (or its
 * view doesn't yet expose `getSortedFolderItems`/`requestSort` — e.g. it's
 * still a deferred, lazily constructed leaf), this retries on every
 * `layout-change` until it succeeds once, then stops listening; it does not
 * retry on any later failure, since a leaf that has already produced a real
 * file explorer view is not expected to stop being one.
 */
export function installExplorerSort(host: ExplorerSortHost): void {
	// Every leaf is tried, not just `[0]`: `getLeavesOfType` returns deferred
	// leaves too, whose views fail `isFileExplorerView`, so `[0]` alone would
	// skip a real explorer sitting behind a deferred one (`explorerDrag.ts`
	// documents the same trap for its own install). One real view is enough —
	// the patch lands on the shared prototype, which covers every instance.
	const tryInstall = (): boolean => {
		for (const leaf of host.app.workspace.getLeavesOfType('file-explorer')) {
			if (!isFileExplorerView(leaf.view)) continue;
			installOnView(host, leaf.view);
			return true;
		}
		return false;
	};

	if (tryInstall()) return;

	const ref = host.app.workspace.on('layout-change', () => {
		if (tryInstall()) host.app.workspace.offref(ref);
	});
	host.registerEvent(ref);
}

/**
 * The order the file explorer is showing for `folder` right now, as plain
 * child names — for `OrderModal` to seed its rows with, so the dialog opens
 * agreeing with the tree next to it instead of guessing alphabetically.
 *
 * Deliberately goes through `leaf.view.getSortedFolderItems(folder)` itself
 * — the very method this file patches above — rather than reading the index
 * or the explorer's sort setting separately: called after the patch is
 * installed, this returns the stored order for a folder that has one, and
 * the explorer's own current sort (name/modified/...) for one that doesn't.
 * Either way it is exactly what the tree is rendering, which is what makes
 * this correct rather than a second, possibly-diverging guess.
 *
 * Returns `null`, never throws, whenever the file explorer can't be
 * consulted: no file-explorer leaf, a view that isn't (yet) recognizable as
 * one (`isFileExplorerView`), or a row whose `.file` isn't a `TFile`/
 * `TFolder` — the same runtime shape guard `buildReplacement` above applies
 * to the identical rows, reused here rather than re-declared.
 */
export function explorerOrderNames(app: App, folder: TFolder): readonly string[] | null {
	try {
		// First *real* view, not `[0]`: a deferred leaf ahead of a real one
		// would otherwise read as "no explorer to consult" — same trap every
		// other leaf lookup here now sidesteps (see `installExplorerSort`).
		const view = app.workspace
			.getLeavesOfType('file-explorer')
			.map((leaf) => leaf.view)
			.find(isFileExplorerView);
		if (view === undefined) return null;

		const items = view.getSortedFolderItems(folder);
		const names: string[] = [];
		for (const item of items) {
			const file: unknown = item?.file;
			if (!(file instanceof TFile) && !(file instanceof TFolder)) return null;
			names.push(file.name);
		}
		return names;
	} catch (err) {
		console.error('[explorer-order-editor] failed to read the file explorer\'s current order, falling back', err);
		return null;
	}
}
