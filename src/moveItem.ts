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
 *
 * Only for reading — deciding whether to offer a menu item, seeding a dialog.
 * Anything about to *write* an order back must go through `orderToWriteFrom`
 * below instead, which heals first: what this returns while the store is
 * unusable is the tree's own sort, and writing that back is how a saved order
 * gets replaced by the view that stood in for it.
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

/**
 * `folder`'s order to compute a write from, or `null` when the store cannot
 * be written at all.
 *
 * Every action that reads an order in order to write one back goes through
 * this rather than calling `effectiveOrder` directly, and the reason is that
 * the heal and the read are not two steps that happen to be adjacent — they
 * are one operation, and doing them in the other order silently destroys
 * data. While the store is unusable `store.get` holds nothing for `folder`,
 * so `effectiveOrder` falls back to whatever the file explorer is rendering:
 * the tree's own sort setting, not the saved order. Compute a new order from
 * that, heal, and write, and the write lands on top of exactly what the heal
 * just recovered — the fallback view, plus one item nudged, is now the saved
 * order.
 *
 * This was originally a guard inside `applyDrop`'s cross-folder branch alone,
 * defended on the grounds that the other paths rename nothing and so leave
 * nothing on disk disagreeing with the saved order when a write is refused.
 * That defence answers the wrong question: it is about *refusal*, and the
 * damage here comes from *staleness* — a write that succeeds, from an order
 * that was never real. So the rule is the invariant, not the branch: no
 * caller may read an order to write back from while `!store.isUsable()`.
 *
 * `repair()` is a no-op answering `'healed'` when the store is already
 * usable, so the ordinary case pays nothing for it. Compared against
 * `'healed'` rather than tested for truthiness — every member of
 * `RepairOutcome` is a non-empty string, so `!outcome` is false for the
 * failures too, silently and legally.
 */
export async function orderToWriteFrom(host: MoveItemHost, folder: TFolder): Promise<readonly string[] | null> {
	if ((await host.store.repair()) !== 'healed') return null;
	return effectiveOrder(host, folder);
}

export type MoveOutcome = 'moved' | 'unchanged' | 'refused';

/**
 * Resolves `file`'s parent folder, takes its `orderToWriteFrom`, and moves
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
 *   isn't in the folder's order at all). The menu and the commands both gate on
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
 * Which is why the no-op check is *not* hoisted above the heal to preserve
 * `'unchanged'` in the unhealable case: answering "nothing to do" needs an
 * order worth believing, and while the store is unusable the only order
 * available is the file explorer's fallback view. "The note cannot be written"
 * is the true answer there; "nothing to do" would be a guess wearing the
 * reassuring one's clothes.
 *
 * Note what a first move into a folder with no saved order yet means: it
 * materializes one from the folder's `effectiveOrder` — whatever is currently
 * on screen — with `file` nudged one step. That is a write the user did not
 * explicitly ask for ("set this folder's order"), but it is the correct reading of what
 * they *did* ask for ("move this one thing"): the alternative, refusing to
 * act until a full order already exists, would make the direct move actions
 * useless for the common case of a folder nobody has ever opened the reorder
 * dialog for.
 */
export async function applyMove(host: MoveItemHost, file: TFile | TFolder, move: RowMove): Promise<MoveOutcome> {
	const parent = file.parent;
	if (parent === null) return 'unchanged';

	// Heal before reading, never after — see `orderToWriteFrom`. `'refused'`
	// rather than `'unchanged'` for a `null`: nothing about the move was a
	// no-op, the note could not be made writable, and the caller's message for
	// that names the note and points at repair.
	const order = await orderToWriteFrom(host, parent);
	if (order === null) return 'refused';

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
 * One sequence, branching exactly once — on whether `dragged` already lives
 * in `dest` (`dragged.parent !== dest`, reference comparison: both are live
 * `TFolder` objects resolved from the same vault). The same-folder case is
 * `applyMove`'s shape exactly, `insertNameBeside` standing in for
 * `moveNameInOrder`; the cross-folder case runs the identical sequence with
 * the rename spliced in before the write. The ordering is deliberate —
 * "make sure the store can be written at all, *then* compute the destination
 * order, *then* rename, and only write the order after the rename actually
 * lands":
 *
 * 0. The heal inside `orderToWriteFrom` — a no-op when the store is already
 *    usable, an attempt when it is not, and a `null` (reported as
 *    `'refused'`) when it cannot be healed. Happening before the read is that
 *    function's whole point; happening before step 3 is what keeps the
 *    irreversible rename from running when step 4 is already known to be
 *    impossible.
 * 1. `insertNameBeside` is computed against `dest`'s *current* order, before
 *    `dragged` has moved anywhere — it tolerates `dragged.name` not yet
 *    being a member of that order, which is exactly the cross-folder case.
 *    `null` here would mean `anchor.name` isn't in `dest`'s own order, which
 *    should not be reachable (the caller resolved `anchor` from a row
 *    `dest` is currently rendering) — handled as `'unchanged'` anyway, on the
 *    same "trust the null contract, not the specific reason" basis
 *    `applyMove` already follows.
 * 2. Cross-folder only: the destination path is built from
 *    `dest.path`/`dest.isRoot()` rather than assuming what the vault root's
 *    `TFolder.path` literally is (`''` vs `'/'`) — the same root-path trap
 *    this codebase avoids everywhere else (`folderIndexKey`, `orderSync.ts`'s
 *    rename handling).
 * 3. Cross-folder only: `fileManager.renameFile` actually performs the move.
 *    A failure here (most commonly a name collision already at the
 *    destination) is caught and reported as `'move-failed'` — **no** order is
 *    written in that case, keeping the on-disk move and the saved order from
 *    ever disagreeing about whether it happened.
 * 4. The write. A refusal here maps to two different outcomes because the
 *    two cases have done two different amounts of damage: same-folder renamed
 *    nothing, so `'refused'` truthfully promises nothing happened; after a
 *    rename the file has moved either way, so it is `'moved-unsaved'` — step
 *    0 makes this unlikely but not impossible, since the store can go
 *    unusable in between.
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

	const needsRename = dragged.parent !== dest;

	// Heal-before-reading, like every path that computes a write from an
	// existing order (`orderToWriteFrom` carries the argument). Healing before
	// the *rename* matters too: `renameFile` is the one step here that cannot
	// be undone, so a store that cannot be written has to be found out before
	// it, not after. Not a new healing trigger — the `updateOrRepair` at the
	// foot of this function already healed on a drop; this only runs the same
	// heal earlier in the sequence.
	const order = await orderToWriteFrom(host, dest);
	if (order === null) return { outcome: 'refused' };

	const next = insertNameBeside(order, dragged.name, anchor.name, side);
	if (next === null) return { outcome: 'unchanged' };

	if (needsRename) {
		const newPath = normalizePath(dest.isRoot() ? dragged.name : `${dest.path}/${dragged.name}`);
		try {
			await host.app.fileManager.renameFile(dragged, newPath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { outcome: 'move-failed', error: message };
		}
	}

	// After a rename the refusal is `'moved-unsaved'`, not `'refused'`: the
	// rename already landed, and the heal above makes this unlikely rather
	// than impossible — the store can still go unusable between the two, since
	// `onExternalModify` is free to run across either await. With no rename,
	// nothing irreversible has happened and `'refused'` stays the honest word.
	const accepted = await host.store.updateOrRepair((index) => setOrder(index, folderIndexKey(dest), next));
	return { outcome: accepted ? 'moved' : needsRename ? 'moved-unsaved' : 'refused' };
}
