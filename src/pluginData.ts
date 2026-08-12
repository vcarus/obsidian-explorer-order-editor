/**
 * Pure: what `data.json` had to say, and what may be written back to it.
 *
 * Obsidian's `Plugin.loadData()` answers three different things through one
 * nullish-looking value, and the difference between two of them decides
 * whether a missing json block is a blank slate or a note that lost one:
 *
 * | value | meaning |
 * | --- | --- |
 * | the parsed object | normal |
 * | `null` | the file genuinely is not there (`ENOENT`) — a first run |
 * | `undefined` | the read or the `JSON.parse` failed |
 *
 * **It never throws.** `Vault.readJson` catches, logs "failed to read JSON",
 * and returns `undefined`, so a `try`/`catch` around `loadData()` cannot see a
 * corrupt or unreadable file at all. Verified against `obsidian.asar`; the
 * greps are in `docs/dev/obsidian-internals.md`.
 *
 * A leaf module rather than a few lines inside `main.ts` for the reason
 * `storeHealth.ts` and `rebuildStep.ts` are leaves: it is the judgment, and a
 * judgment that only exists on a `Plugin` subclass cannot be tested, so the
 * test double has to re-implement it — which is exactly what happened here.
 * The double's copy had already lost the non-object arm below while every test
 * stayed green.
 */

/** @see classifyData — the three answers `loadData()` collapses into one value. */
export type DataRead =
	| { readonly status: 'ok'; readonly data: Record<string, unknown> }
	| { readonly status: 'absent' }
	| { readonly status: 'unreadable' };

/**
 * `loadData()`'s return value, classified.
 *
 * `absent` is kept apart from `ok` even though every consumer today treats an
 * absent file as an empty one: this function exists to preserve the
 * distinction Obsidian's API drops, and collapsing one here would send the
 * next caller that needs "was this file ever written?" back to the raw value.
 *
 * Valid json that is not an object — `[1,2]`, `"hi"` — belongs with the
 * unreadable. Spreading either into a mutation produces an object made of its
 * indices, and that is what would then be written over the file: the same loss
 * as an unreadable file, arriving through `JSON.parse` *succeeding*.
 */
export function classifyData(raw: unknown): DataRead {
	if (raw === undefined) return { status: 'unreadable' };
	if (raw === null) return { status: 'absent' };
	if (typeof raw !== 'object' || Array.isArray(raw)) return { status: 'unreadable' };
	return { status: 'ok', data: raw as Record<string, unknown> };
}

/**
 * The object to write back, or `null` for "refuse — leave the file alone".
 *
 * The refusal is the policy half of the same rule the index note follows
 * (`CLAUDE.md`: detect, warn, never overwrite what could not be read).
 * Everything `data.json` holds that the caller did not ask to change — the
 * other writer's key, every setting — survives only by being read back and
 * merged, so a failed read must not become a write of the mutation alone.
 *
 * Pure, and shared with the test double, because a double with a *different*
 * write policy is a second implementation of the fix: it would accept writes
 * in precisely the case this refuses, and any test asserting "the backup was
 * not clobbered" would then be asserting it against the double.
 */
export function mergedData(
	read: DataRead,
	mutate: (data: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> | null {
	if (read.status === 'unreadable') return null;
	// `absent` is a blank slate — no file has ever been written here — so the
	// mutation starts from nothing, which is what spreading `null` used to do.
	return mutate(read.status === 'ok' ? { ...read.data } : {});
}
