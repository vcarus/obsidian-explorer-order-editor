/**
 * The shared middle of every refusal notice (`notices.ts`), through the stub in
 * `test/stubs/obsidian.ts`.
 *
 * Read that stub's header first. What is asserted here is our own wording, and
 * the reasons it is built from come from a real `IndexFileStore` driven into
 * each unusable state rather than from strings written out by hand — a copy of
 * a reason in a test proves the test agrees with itself.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexFileStore, type IndexFileHost } from '../src/indexFile';
import { unusableClause } from '../src/notices';
import { serializeIndex } from '../src/orderIndex';
import { DEFAULT_SETTINGS } from '../src/settings';
import { StubPlugin, resetNotices } from './stubs/obsidian';

const NOTE = 'explorer-order.md';

/** See the identically-shaped helper in `indexFileRepair.test.ts` for why the cast is the only one. */
function makeHost(): { host: IndexFileHost; stub: StubPlugin } {
	const stub = new StubPlugin();
	const host = stub as unknown as IndexFileHost;
	host.settings = { ...DEFAULT_SETTINGS, indexPath: NOTE };
	return { host, stub };
}

async function storeThatFailedToLoad(noteText: string, backup?: string): Promise<IndexFileStore> {
	const { host, stub } = makeHost();
	stub.app.vault.files.set(NOTE, noteText);
	if (backup !== undefined) await stub.saveData({ indexBackup: backup });
	const store = new IndexFileStore(host);
	await store.load();
	return store;
}

beforeEach(() => {
	resetNotices();
});

describe('unusableClause', () => {
	it('lowercases the reason it embeds, for every state the store can be in', async () => {
		// The reasons are capitalized at their source because the store also
		// announces each one as a whole sentence. Dropped into the middle of
		// "Could not save: the order note …" unchanged, they produced "the order
		// note Its json block is missing" in all seven refusal notices.
		const cases = [
			// A block that opens and never closes.
			'```json\n{\n  "navtest": ["a.md"]\n',
			// Present, closed, and not JSON.
			'```json\n{\n  totally broken\n}\n```\n',
			// JSON, but not an object.
			'```json\n[1, 2, 3]\n```\n',
			// An object whose value is not an array of strings.
			'```json\n{\n  "navtest": 3\n}\n```\n',
		];

		for (const text of cases) {
			const store = await storeThatFailedToLoad(text);
			// Without this the case could be silently benign — a note that
			// parses leaves no reason at all, and the fallback clause is already
			// lowercase, so the assertion below would pass having tested nothing.
			expect(store.isUsable()).toBe(false);
			const reason = store.unusableReason() ?? '';
			expect(reason.charAt(0)).toBe(reason.charAt(0).toUpperCase());

			expect(unusableClause(store)).toBe(`the order note ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`);
		}
	});

	it('lowercases the missing-block reason, which is authored in indexFile.ts rather than the parser', async () => {
		// The one reason the parser never produces: a note with no fence at all,
		// which is only unusable because something proves a block was there —
		// here, the backup.
		const store = await storeThatFailedToLoad('just prose, no fence\n', serializeIndex('', new Map([['navtest', ['a.md']]])));
		expect(store.isUsable()).toBe(false);
		expect(unusableClause(store)).toBe('the order note its json block is missing');
	});

	it('falls back to a clause, not a sentence, when the store never said why', async () => {
		const { host } = makeHost();
		const store = new IndexFileStore(host);
		await store.load();
		// A usable store has no reason at all; the fallback still has to read as
		// the middle of somebody else's sentence.
		expect(unusableClause(store)).toBe('the order note could not be repaired');
	});
});
