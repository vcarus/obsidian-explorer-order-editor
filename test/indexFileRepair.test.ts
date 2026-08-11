/**
 * The repair/start-over branches of `IndexFileStore`, through the stub in
 * `test/stubs/obsidian.ts`.
 *
 * Read that stub's header first. These assert *our* control flow — which
 * outcome a refusal reports, whether a copy was kept, whether a failure was
 * announced — and nothing about how Obsidian behaves. Hand testing in
 * `testvault/` is still what decides whether a change works.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexFileStore, type IndexFileHost } from '../src/indexFile';
import { serializeIndex } from '../src/orderIndex';
import { DEFAULT_SETTINGS } from '../src/settings';
import { StubPlugin, notices, resetNotices } from './stubs/obsidian';

const NOTE = 'explorer-order.md';

/**
 * The stub is imported by path, never by mapping `obsidian` to it in
 * `test/tsconfig.json`. A mapping would apply to `src/**` as well — this
 * project compiles those too — and every module here would then be checked
 * against the stub's tiny surface instead of the real API, which is the one
 * check that actually protects the plugin. Types come from the real package
 * everywhere; only the runtime module is substituted, by the alias in
 * `vitest.config.ts`.
 *
 * The cast is where those two facts meet, and it is the only place they do.
 * It is honest at run time precisely because of that alias.
 *
 * Settings are spread from `DEFAULT_SETTINGS` rather than naming the one
 * field the store reads, so a key added later cannot leave this compiling
 * against a shape the plugin no longer has.
 */
function makeHost(): { host: IndexFileHost; stub: StubPlugin } {
	const stub = new StubPlugin();
	const host = stub as unknown as IndexFileHost;
	host.settings = { ...DEFAULT_SETTINGS, indexPath: NOTE };
	return { host, stub };
}

/** A note whose fence is present but holds nothing any line can be salvaged from. */
const unsalvageable = '```json\n{\n  totally broken\n}\n```\n';

/** A note whose fence is broken but whose folder lines survive line-by-line salvage. */
const salvageable = '```json\n{\n  "navtest": ["a.md"],\n  "weird": ["b.md"\n}\n```\n';

/**
 * A *different* broken version, of the shape a half-synced note produces:
 * still invalid, so nothing can adopt it, but carrying orders that
 * line-by-line salvage would recover. Writing over this without preserving it
 * is what the snapshot check exists to prevent.
 */
const newerBroken = '```json\n{\n  "navtest": ["landed-a.md","landed-b.md"],\n  "weird": ["landed-c.md"\n}\n```\n';

async function loadedStore(noteText: string, backup?: string): Promise<{ store: IndexFileStore; stub: StubPlugin }> {
	const { host, stub } = makeHost();
	stub.app.vault.files.set(NOTE, noteText);
	if (backup !== undefined) await stub.saveData({ indexBackup: backup });
	const store = new IndexFileStore(host);
	await store.load();
	return { store, stub };
}

beforeEach(() => {
	resetNotices();
});

describe('repair() distinguishes why it could not repair', () => {
	it('reports nothing-to-recover when the note, memory and backup are all empty', async () => {
		const { store } = await loadedStore(unsalvageable);
		expect(store.isUsable()).toBe(false);
		expect(await store.repair()).toBe('nothing-to-recover');
	});

	it('reports failed — not nothing-to-recover — when the attempt itself breaks', async () => {
		const { store, stub } = await loadedStore(salvageable);
		expect(store.isUsable()).toBe(false);
		// Orders *are* recoverable here; it is the quarantine write that dies.
		// Conflating this with the case above is what would invite a wipe on a
		// false premise.
		stub.app.vault.failCreate = 'disk full';
		expect(await store.repair()).toBe('failed');
		expect(store.isUsable()).toBe(false);
	});

	it('reports healed when salvage finds something, and keeps a copy', async () => {
		const { store, stub } = await loadedStore(salvageable);
		expect(await store.repair()).toBe('healed');
		expect(store.isUsable()).toBe(true);
		expect(store.get('navtest')).toEqual(['a.md']);
		const kept = [...stub.app.vault.files.keys()].filter((p) => p !== NOTE);
		expect(kept).toHaveLength(1);
	});

	it('adopts a note that turned readable mid-flight rather than overwriting it with what it salvaged', async () => {
		// Same race as the one under startOver, on the heal path — which is
		// where it predates all of this: the recovered index is reconstructed
		// from the stale snapshot, and writing it would replace orders that are
		// strictly newer.
		const { store, stub } = await loadedStore(salvageable);
		expect(store.isUsable()).toBe(false);

		const arrived = serializeIndex('', new Map([['navtest', ['landed.md']]]));
		stub.app.vault.files.set(NOTE, arrived);

		expect(await store.repair()).toBe('healed');
		expect(store.get('navtest')).toEqual(['landed.md']);
		expect(stub.app.vault.files.get(NOTE)).toBe(arrived);
	});

	it('re-plans from a newer still-invalid version rather than from the snapshot it started with', async () => {
		// Recovery has to be derived from the text actually being replaced.
		// Planning from the older snapshot would write `a.md` over a note whose
		// own salvageable lines say `landed-a.md`, and preserve the wrong one.
		const { store, stub } = await loadedStore(salvageable);
		expect(store.isUsable()).toBe(false);

		stub.app.vault.files.set(NOTE, newerBroken);

		expect(await store.repair()).toBe('healed');
		expect(store.get('navtest')).toEqual(['landed-a.md', 'landed-b.md']);

		const kept = [...stub.app.vault.files.entries()].filter(([p]) => p !== NOTE);
		expect(kept.map(([, text]) => text)).toEqual([newerBroken]);
	});

	it('is a no-op answering healed when the store was never unusable', async () => {
		const { store } = await loadedStore(serializeIndex('', new Map([['navtest', ['a.md']]])));
		expect(store.isUsable()).toBe(true);
		expect(await store.repair()).toBe('healed');
	});
});

describe('startOver()', () => {
	it('keeps the unreadable content as a copy before rebuilding', async () => {
		const { store, stub } = await loadedStore(unsalvageable);
		const before = notices.length;
		expect(await store.startOver()).toBe(true);
		expect(store.isUsable()).toBe(true);
		expect(store.keys().size).toBe(0);

		const kept = [...stub.app.vault.files.entries()].filter(([p]) => p !== NOTE);
		expect(kept.map(([, text]) => text)).toEqual([unsalvageable]);
		// The copy is only findable if it is named, so the notice has to carry
		// it. Counted as "one more than before" rather than as a total: going
		// unusable during `load` above legitimately raised one already.
		expect(notices.length).toBe(before + 1);
		const keptPaths = kept.map(([path]) => path);
		expect(keptPaths).toHaveLength(1);
		expect(notices[notices.length - 1] ?? '').toContain(keptPaths.join(''));
	});

	it('skips the copy when the note was empty, since there is nothing to preserve', async () => {
		// An index note emptied to nothing is marked unusable on the strength
		// of the backup alone — and copying zero bytes would only leave a file
		// the "delete the kept copies" row then offers to tidy away.
		const { store, stub } = await loadedStore('', serializeIndex('', new Map([['navtest', ['a.md']]])));
		expect(store.isUsable()).toBe(false);

		const before = notices.length;
		expect(await store.startOver()).toBe(true);
		expect([...stub.app.vault.files.keys()]).toEqual([NOTE]);
		// Still reports, but with no copy to name — the clause is conditional,
		// not the notice.
		expect(notices.length).toBe(before + 1);
		expect(notices[notices.length - 1] ?? '').not.toContain('kept as');
	});

	it('reports failure rather than going silent when the rebuild throws', async () => {
		const { store, stub } = await loadedStore(unsalvageable);
		stub.app.vault.failProcess = 'note is locked';

		expect(await store.startOver()).toBe(false);
		expect(store.isUsable()).toBe(false);
	});

	it('adopts the note instead of wiping it when it turned readable mid-flight', async () => {
		// The window Codex found: a sync client replaces the broken note with a
		// good one, and `onExternalModify` has not run yet — it is not on the
		// write chain and starts with its own await — so `usable` is still
		// false while the disk already holds real orders. Writing through that
		// would put an empty block over them, and the quarantine copy beside it
		// holds the *old* text, so they would survive nowhere.
		//
		// The stub reproduces it without any timing games: it accepts the
		// `modify` handler and has no way to fire it, which is exactly "the
		// disk changed and nothing has told the store".
		const { store, stub } = await loadedStore(unsalvageable);
		expect(store.isUsable()).toBe(false);

		const arrived = serializeIndex('', new Map([['navtest', ['landed.md']]]));
		stub.app.vault.files.set(NOTE, arrived);

		expect(await store.startOver()).toBe(true);
		expect(store.isUsable()).toBe(true);
		expect(store.get('navtest')).toEqual(['landed.md']);
		expect(stub.app.vault.files.get(NOTE)).toBe(arrived);
	});

	it('preserves a newer still-invalid version instead of writing over it', async () => {
		// The case an "is it readable now?" check cannot catch: the note is
		// replaced by a *differently* broken one, so `usable` never goes true
		// and no adoption is possible — but its lines are salvageable, and the
		// quarantine copy taken from the older snapshot would not have held
		// them.
		const { store, stub } = await loadedStore(unsalvageable);
		expect(store.isUsable()).toBe(false);

		stub.app.vault.files.set(NOTE, newerBroken);

		expect(await store.startOver()).toBe(true);
		expect(store.keys().size).toBe(0);

		// The bytes that were actually replaced are the bytes that were kept.
		const kept = [...stub.app.vault.files.entries()].filter(([p]) => p !== NOTE);
		expect(kept.map(([, text]) => text)).toEqual([newerBroken]);
	});

	it('does not wipe anything if the store became usable first, and says so', async () => {
		const { store } = await loadedStore(salvageable);
		expect(await store.repair()).toBe('healed');

		resetNotices();
		// The confirmation dialog can still be open at this point; starting
		// over now must not discard what the heal just recovered.
		expect(await store.startOver()).toBe(true);
		expect(store.get('navtest')).toEqual(['a.md']);

		// And must not do it silently. This is the *likely* way to reach "start
		// over cleared nothing" — repair says nothing to recover, the dialog
		// sits open, a readable copy lands — and it returns through the guard at
		// the top of `startOver`, not through the branch that used to hold the
		// only notice. Asserting the return value alone is what let that pass.
		expect(notices).toHaveLength(1);
		expect(notices[0] ?? '').toContain('nothing was cleared');
	});
});

describe('recovering from the text a read last found unreadable', () => {
	it('repairs a note that was deleted after it was found unreadable', async () => {
		// Detected unreadable, then removed — a sync conflict resolved on
		// another device, or by hand. The note now reads as nothing, and on a
		// cold start neither memory nor the backup holds anything, so the only
		// remaining copy of those orders is the text this store already read.
		const { store, stub } = await loadedStore(salvageable);
		expect(store.isUsable()).toBe(false);
		stub.app.vault.files.delete(NOTE);

		expect(await store.repair()).toBe('healed');
		expect(store.get('navtest')).toEqual(['a.md']);
		// Rebuilt where it was, and with no copy kept: there were no bytes on
		// disk to preserve.
		expect([...stub.app.vault.files.keys()]).toEqual([NOTE]);
	});

	it('is beaten by the note itself whenever the note still has the key', async () => {
		// Lowest precedence, and it has to stay there: the older text is by
		// definition the stalest source in the union.
		const { store, stub } = await loadedStore(salvageable);
		stub.app.vault.files.set(NOTE, newerBroken);

		expect(await store.repair()).toBe('healed');
		expect(store.get('navtest')).toEqual(['landed-a.md', 'landed-b.md']);
	});

	it('is beaten by what is loaded, so a repaired note is never re-recovered from the text before it', async () => {
		// Fourth of four sources, which puts it below the in-memory index too.
		// A note found unreadable, repaired, then broken again recovers from
		// what the repair produced — not from the text that was there before it.
		const { store, stub } = await loadedStore(salvageable);
		expect(await store.repair()).toBe('healed');
		expect(store.get('navtest')).toEqual(['a.md']);

		stub.app.vault.files.set(NOTE, unsalvageable);
		await store.load();
		expect(store.isUsable()).toBe(false);

		expect(await store.repair()).toBe('healed');
		expect(store.get('navtest')).toEqual(['a.md']);
	});
});

describe('the rebuild loop reads the note, not the read cache', () => {
	it('plans from what is on disk when the cache still holds the older text', async () => {
		// The state `quarantineThenRebuild` exists for is the same state that
		// makes the cache stale: a sync client has replaced the note and
		// Obsidian's `modify` event — the only thing that invalidates the cache —
		// has not fired. Planning from the cached copy and writing against the
		// file means `data !== expected` on every attempt: three rounds spent,
		// three copies kept of text that no longer exists, and a `'failed'`
		// reported about a note nothing ever touched.
		const { store, stub } = await loadedStore(unsalvageable);
		expect(store.isUsable()).toBe(false);

		stub.app.vault.files.set(NOTE, newerBroken);
		stub.app.vault.staleCache.set(NOTE, unsalvageable);

		expect(await store.repair()).toBe('healed');
		expect(store.get('navtest')).toEqual(['landed-a.md', 'landed-b.md']);

		// One copy, of the bytes that were actually replaced.
		const kept = [...stub.app.vault.files.entries()].filter(([p]) => p !== NOTE);
		expect(kept.map(([, text]) => text)).toEqual([newerBroken]);
	});
});
