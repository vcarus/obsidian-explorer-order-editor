/**
 * The `data.json` vocabulary: what each of `loadData()`'s three answers means,
 * and what may be written back.
 *
 * These are the only tests in the project that cover this decision directly.
 * It lived on the plugin class for a day, where nothing could reach it, and
 * the test double's copy had already lost the non-object arm — so the arms
 * below are here in the order they were lost, not in the order they read.
 */
import { describe, expect, it } from 'vitest';
import { classifyData, mergedData } from '../src/pluginData';

describe('classifyData', () => {
	it('reads undefined as unreadable, because that is what a failed read returns', () => {
		// Obsidian's `readJson` catches the error, logs it and returns
		// `undefined`; nothing throws. This arm is the whole fix.
		expect(classifyData(undefined)).toEqual({ status: 'unreadable' });
	});

	it('reads null as absent, because that is ENOENT and a first run', () => {
		// Must stay distinct from the arm above: this one is positive evidence
		// that nothing was ever stored, which is what lets a block-less note be
		// treated as the blank slate it really is.
		expect(classifyData(null)).toEqual({ status: 'absent' });
	});

	it('passes an object through', () => {
		expect(classifyData({ indexBackup: 'x' })).toEqual({ status: 'ok', data: { indexBackup: 'x' } });
		expect(classifyData({})).toEqual({ status: 'ok', data: {} });
	});

	it('reads valid json that is not an object as unreadable', () => {
		// `JSON.parse` succeeding is not the same as the file being usable:
		// spreading either of these produces an object made of their indices,
		// and that is what would be written back over the file.
		expect(classifyData([1, 2])).toEqual({ status: 'unreadable' });
		expect(classifyData('hi')).toEqual({ status: 'unreadable' });
		expect(classifyData(42)).toEqual({ status: 'unreadable' });
	});
});

describe('mergedData', () => {
	const addKey = (data: Record<string, unknown>): Record<string, unknown> => ({ ...data, added: true });

	it('refuses when the file could not be read', () => {
		// The mutation is not even run: there is nothing to merge it onto, and
		// writing it alone would replace every key the caller did not name.
		let ran = false;
		const result = mergedData({ status: 'unreadable' }, (data) => {
			ran = true;
			return data;
		});

		expect(result).toBeNull();
		expect(ran).toBe(false);
	});

	it('merges onto what was read', () => {
		expect(mergedData({ status: 'ok', data: { kept: 1 } }, addKey)).toEqual({ kept: 1, added: true });
	});

	it('does not hand the caller its own object to mutate in place', () => {
		const data = { kept: 1 };
		mergedData({ status: 'ok', data }, (d) => {
			d.clobbered = true;
			return d;
		});

		expect(data).toEqual({ kept: 1 });
	});

	it('starts from nothing when the file is absent', () => {
		expect(mergedData({ status: 'absent' }, addKey)).toEqual({ added: true });
	});
});
