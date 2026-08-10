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

	it('does not wipe anything if the store became usable first', async () => {
		const { store } = await loadedStore(salvageable);
		expect(await store.repair()).toBe('healed');
		// The confirmation dialog can still be open at this point; starting
		// over now must not discard what the heal just recovered.
		expect(await store.startOver()).toBe(true);
		expect(store.get('navtest')).toEqual(['a.md']);
	});
});
