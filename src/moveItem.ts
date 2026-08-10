/**
 * The thin obsidian layer behind the direct move actions ("move up" /
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
import type { DropSide } from './dropZone';
import { explorerOrderNames } from './explorerSort';
import { folderIndexKey, type IndexFileStore } from './indexFile';
import { setOrder } from './orderIndex';
import { insertNameBeside, moveNameInOrder, type RowMove } from './rowMove';
import type { ExplorerOrderEditorSettings } from './settings';
import { entriesFor } from './folderEntries';

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
		// entriesFor (folderEntries.ts) already excludes the index note by path
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
 * user action (a context-menu click or a command), exactly the kind the store
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

/**
 * `'moved-unsaved'` is the one outcome with no counterpart in `MoveOutcome`,
 * and it exists because only this function performs a step that cannot be
 * taken back: the file is at its new path, but its position within it was not
 * written. It has to stay distinct from `'refused'` — which promises nothing
 * happened — because telling somebody "could not move" about a file that has
 * already moved sends them looking for it where it no longer is.
 */
export type DropOutcome = 'moved' | 'unchanged' | 'refused' | 'move-failed' | 'moved-unsaved';

/**
 * The write side of the self-rendered tree drag-and-drop: places
 * `dragged` immediately before/after `anchor` in `anchor.parent`'s saved
 * order (`insertNameBeside`, `rowMove.ts`), moving `dragged` into that folder
 * first when it isn't there already.
 *
 * `anchor.parent` (`dest`) is `null` only for the vault root itself acting as
 * `anchor` — the root can be a drop *destination* but never someone's
 * `parent`, so there is nothing to write into. `explorerDrag.ts`'s own
 * judgment already rules this case out before calling here (an anchor with no
 * parent fails its own guard), so this is a belt-and-suspenders check, not a
 * path expected to be hit.
 *
 * Two shapes, same as `applyMove` above for the same-folder case, plus a
 * third for the cross-folder one:
 *
 * Same folder (`dragged.parent === dest`, reference comparison — both are
 * live `TFolder` objects resolved from the same vault): compute
 * `effectiveOrder` for `dest`, splice `dragged.name` beside `anchor.name`, and
 * write it — no rename involved, so this is `applyMove`'s shape exactly,
 * `insertNameBeside` standing in for `moveNameInOrder`.
 *
 * Cross folder: order matters here, and it is deliberately "make sure the
 * store can be written at all, *then* compute the destination order, *then*
 * rename, and only write the order after the rename actually lands":
 *
 * 0. `store.repair()` — a no-op when the store is already usable, an attempt
 *    to heal when it is not, and a `'refused'` return when it cannot be
 *    healed. Doing this up front is what keeps step 3's irreversible rename
 *    from running when step 4 is already known to be impossible; the comment
 *    at the call site covers why it also has to precede step 1.
 * 1. `insertNameBeside(effectiveOrder(host, dest), dragged.name, anchor.name,
 *    side)` is computed against `dest`'s *current* order, before `dragged`
 *    has moved anywhere — `insertNameBeside` tolerates `dragged.name` not yet
 *    being a member of that order, which is exactly the cross-folder case.
 *    `null` here would mean `anchor.name` isn't in `dest`'s own order, which
 *    should not be reachable (the caller resolved `anchor` from a row
 *    `dest` is currently rendering) — handled as `'unchanged'` anyway, on the
 *    same "trust the null contract, not the specific reason" basis
 *    `applyMove` already follows.
 * 2. The destination path is built from `dest.path`/`dest.isRoot()` rather
 *    than assuming what the vault root's `TFolder.path` literally is (`''`
 *    vs `'/'`) — the same root-path trap this codebase avoids everywhere
 *    else (`folderIndexKey`, `orderSync.ts`'s rename handling).
 * 3. `fileManager.renameFile` actually performs the move. A failure here
 *    (most commonly a name collision already at the destination) is caught
 *    and reported as `'move-failed'` — **no** order is written in that case,
 *    keeping the on-disk move and the saved order from ever disagreeing
 *    about whether it happened.
 * 4. Only once the rename has actually succeeded is the destination's order
 *    written, using the order computed in step 1. Step 0 makes a refusal here
 *    unlikely but not impossible — the store can go unusable in between — so
 *    this reports `'moved-unsaved'` rather than `'refused'`, the file having
 *    moved either way.
 *
 * Computing the destination order *before* the rename, rather than after, is
 * what keeps this from racing `orderSync.ts`: that module reacts to the same
 * rename event this triggers, but it only ever touches two keys — the old
 * parent's (`removeEntry`, dropping `dragged`'s stale position there) and, if
 * `dragged` is itself a folder, its own key (`renameFolderPath`, moving
 * whatever was saved *inside* it). Neither is `folderIndexKey(dest)`: the
 * caller's own guard against dropping a folder into its own descendant
 * already guarantees `dest` can never be `dragged` or something nested inside
 * it, so `orderSync`'s reaction to this same rename and this function's own
 * write to `dest`'s key can never land on the same key at all, in either
 * order.
 */
export async function applyDrop(
	host: MoveItemHost,
	dragged: TFile | TFolder,
	anchor: TFile | TFolder,
	side: DropSide,
): Promise<{ outcome: DropOutcome; error?: string }> {
	const dest = anchor.parent;
	if (dest === null) return { outcome: 'unchanged' };

	if (dragged.parent === dest) {
		const order = effectiveOrder(host, dest);
		const next = insertNameBeside(order, dragged.name, anchor.name, side);
		if (next === null) return { outcome: 'unchanged' };

		const accepted = await host.store.updateOrRepair((index) => setOrder(index, folderIndexKey(dest), next));
		return { outcome: accepted ? 'moved' : 'refused' };
	}

	// Heal first, before either the order is computed or the rename runs.
	//
	// Before the rename, because `renameFile` is the one step in this function
	// that cannot be undone: finding out afterwards that the store will not
	// accept the write leaves the file moved with nothing recording where it
	// belongs, which is precisely the state the step-3 note above claims this
	// ordering prevents.
	//
	// Before `effectiveOrder` too, and that part is not merely tidiness: while
	// the store is unusable `store.get` has nothing for `dest`, so
	// `effectiveOrder` falls back to whatever the explorer is rendering.
	// Computing the new order from that and writing it after a heal would
	// overwrite the order the heal just recovered with one derived from the
	// fallback view.
	//
	// Not a new healing trigger — the `updateOrRepair` at the foot of this
	// function already healed on a drop, one of the three explicit user
	// actions healing is allowed to run for. This only moves that same heal
	// earlier in the sequence. `repair()` is a no-op answering `'healed'` when
	// the store is already usable, so the ordinary drop pays nothing for it.
	//
	// The same-folder branch above deliberately keeps the original order: it
	// renames nothing, so a refused write there leaves no on-disk state
	// disagreeing with the saved order, and `'refused'` remains the honest
	// answer.
	// Compared against `'healed'`, not tested for truthiness: `repair()` answers
	// with a `RepairOutcome`, and every member of that union is a non-empty
	// string, so `!outcome` would be false for the failures too — and silently,
	// since that is valid TypeScript. All this branch needs is "can the store
	// be written now"; why it cannot is the settings tab's business.
	if ((await host.store.repair()) !== 'healed') return { outcome: 'refused' };

	const next = insertNameBeside(effectiveOrder(host, dest), dragged.name, anchor.name, side);
	if (next === null) return { outcome: 'unchanged' };

	const newPath = normalizePath(dest.isRoot() ? dragged.name : `${dest.path}/${dragged.name}`);
	try {
		await host.app.fileManager.renameFile(dragged, newPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { outcome: 'move-failed', error: message };
	}

	// `'moved-unsaved'`, not `'refused'`: the rename above already landed. The
	// heal makes this branch unlikely rather than impossible — the store can
	// still go unusable between it and here, since `onExternalModify` is free
	// to run across either await.
	const accepted = await host.store.updateOrRepair((index) => setOrder(index, folderIndexKey(dest), next));
	return { outcome: accepted ? 'moved' : 'moved-unsaved' };
}
