/**
 * The thin obsidian layer behind the direct move actions (M11: "move up" /
 * "move down" / "move to top" / "move to bottom") — the context menu items
 * and commands in `main.ts` both funnel through `applyMove` below, the same
 * way the reorder modal's own move buttons funnel through `rowMove.ts`'s
 * `moveNameInOrder`, which this reuses rather than re-deriving.
 *
 * Deliberately thin, same reasoning as `indexFile.ts`/`explorerSort.ts`:
 * every judgment that doesn't need a live `TFolder` (whether a move is a
 * no-op, where the moved name lands) is already pure in `rowMove.ts`. This
 * file's own job is narrow — find the parent folder's current order, ask the
 * pure layer where the moved item belongs, and write the result.
 */
import { normalizePath, type Plugin, type TFile, type TFolder } from 'obsidian';
import { explorerOrderNames } from './explorerSort';
import { folderIndexKey, type IndexFileStore } from './indexFile';
import { setOrder } from './orderIndex';
import { moveNameInOrder, type RowMove } from './rowMove';
import type { ExplorerOrderEditorSettings } from './settings';
import { entriesFor } from './sortspecFile';

/**
 * Structural slice of `Plugin`, matching `ExplorerSortHost`/`IndexFileHost`
 * elsewhere — avoids a circular import against `main.ts`.
 */
export interface MoveItemHost extends Plugin {
	settings: ExplorerOrderEditorSettings;
	store: IndexFileStore;
}

/**
 * `folder`'s current order, as the user sees it right now, with the order
 * index note itself excluded — it is never orderable.
 *
 * Prefers `explorerOrderNames` (`explorerSort.ts`): it reads back through
 * this plugin's own render patch, so it already reflects either a saved
 * order or the file explorer's own current sort setting — exactly what is
 * on screen right now. Falls back to `entriesFor(folder)`'s names only when
 * that returns `null` (no file-explorer leaf to consult, or its internals
 * didn't match what this plugin expects) — see `explorerOrderNames`'s own
 * doc comment for when that happens.
 *
 * Synchronous: both sources already are (`store.get` is a `Map` lookup;
 * `folder.children` is already in memory), so there is no reason for this to
 * be async and every caller benefits from not having to await it.
 */
export function effectiveOrder(host: MoveItemHost, folder: TFolder): readonly string[] {
	const indexNotePath = normalizePath(host.settings.indexPath);

	const fromExplorer = explorerOrderNames(host.app, folder);
	if (fromExplorer === null) {
		// entriesFor (sortspecFile.ts) already excludes the index note by path
		// — nothing further to filter here.
		return entriesFor(folder, indexNotePath).map((entry) => entry.name);
	}

	// explorerOrderNames reads through the render patch, which re-appends the
	// index note at the end unless "hide" is on — so unlike the fallback
	// above, it can still be present here. Find its name (if it lives in this
	// folder at all) by matching path against folder's own live children,
	// same identity `entryForChild` uses, and filter that one name out.
	for (const child of folder.children) {
		if (child.path === indexNotePath) return fromExplorer.filter((name) => name !== child.name);
	}
	return fromExplorer;
}

export type MoveOutcome = 'moved' | 'unchanged' | 'refused';

/**
 * Resolves `file`'s parent folder, computes its `effectiveOrder`, and moves
 * `file.name` within it (`moveNameInOrder`, `rowMove.ts`). Writes the result
 * with `store.updateOrRepair` — not `update` — because a move is an explicit
 * user action (a context-menu click or a command), exactly the kind M10e
 * heals an unreadable order note for, the same way `main.ts`'s
 * `clearOrderFor` already does for "Clear explorer order".
 *
 * Three outcomes, deliberately not collapsed into a boolean:
 *
 * - `'moved'` — written.
 * - `'unchanged'` — there was nothing to do: `file` has no parent (the vault
 *   root itself, which cannot be moved within anything), or the move would
 *   not change the order (already at the edge `move` targets, or `file.name`
 *   isn't in `effectiveOrder` at all). The menu and the commands both gate on
 *   this already, but it is re-checked here rather than trusted: the order can
 *   change between a menu opening and the click, and a command's
 *   `checkCallback` runs against whatever was active at check time.
 * - `'refused'` — the store would not write, and `store.unusableReason()`
 *   names why.
 *
 * The split matters because the caller reports these differently and the
 * failure message names the order note: telling somebody who pressed a hotkey
 * on an item already at the top that their order note is broken and needs
 * repairing would be a fault report about data that is perfectly fine.
 *
 * Note what a first move into a folder with no saved order yet means: it
 * materializes one from `effectiveOrder` — whatever is currently on screen —
 * with `file` nudged one step. That is a write the user did not explicitly
 * ask for ("set this folder's order"), but it is the correct reading of what
 * they *did* ask for ("move this one thing"): the alternative, refusing to
 * act until a full order already exists, would make the direct move actions
 * useless for the common case of a folder nobody has ever opened the reorder
 * dialog for.
 */
export async function applyMove(host: MoveItemHost, file: TFile | TFolder, move: RowMove): Promise<MoveOutcome> {
	const parent = file.parent;
	if (parent === null) return 'unchanged';

	const order = effectiveOrder(host, parent);
	const moved = moveNameInOrder(order, file.name, move);
	if (moved === null) return 'unchanged';

	const accepted = await host.store.updateOrRepair((index) => setOrder(index, folderIndexKey(parent), moved));
	return accepted ? 'moved' : 'refused';
}
