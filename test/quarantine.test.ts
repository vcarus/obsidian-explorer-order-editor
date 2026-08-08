import { describe, expect, it } from 'vitest';
import { findFreeQuarantinePath, isQuarantinePath, quarantinePath } from '../src/quarantine';

const TIMESTAMP = new Date(2026, 7, 8, 14, 3); // 2026-08-08 14:03 local time, month is 0-indexed

describe('quarantinePath', () => {
	it('a root-level note gets a sibling name with no folder component', () => {
		expect(quarantinePath('explorer-order.md', TIMESTAMP)).toBe('explorer-order (unreadable 2026-08-08 1403).md');
	});

	it('a note in a subfolder keeps the same folder', () => {
		expect(quarantinePath('Config/explorer-order.md', TIMESTAMP)).toBe('Config/explorer-order (unreadable 2026-08-08 1403).md');
	});

	it('a note nested several folders deep keeps the full folder path', () => {
		expect(quarantinePath('A/B/C/explorer-order.md', TIMESTAMP)).toBe('A/B/C/explorer-order (unreadable 2026-08-08 1403).md');
	});

	it('preserves the extension', () => {
		expect(quarantinePath('notes/order.markdown', TIMESTAMP)).toBe('notes/order (unreadable 2026-08-08 1403).markdown');
	});

	it('a note with no extension gets none appended', () => {
		expect(quarantinePath('order', TIMESTAMP)).toBe('order (unreadable 2026-08-08 1403)');
	});

	it('a dotfile with no real extension is not mistaken for one', () => {
		expect(quarantinePath('.explorer-order', TIMESTAMP)).toBe('.explorer-order (unreadable 2026-08-08 1403)');
	});

	it('zero-pads single-digit month, day, hour, and minute', () => {
		const early = new Date(2026, 0, 5, 3, 7); // 2026-01-05 03:07
		expect(quarantinePath('order.md', early)).toBe('order (unreadable 2026-01-05 0307).md');
	});

	it('suffix 0 (the default) adds no disambiguator', () => {
		expect(quarantinePath('order.md', TIMESTAMP, 0)).toBe('order (unreadable 2026-08-08 1403).md');
	});

	it('suffix 1 reads as "the 2nd one," not "attempt 1"', () => {
		expect(quarantinePath('order.md', TIMESTAMP, 1)).toBe('order (unreadable 2026-08-08 1403 2).md');
	});

	it('suffix 2 continues the same way', () => {
		expect(quarantinePath('order.md', TIMESTAMP, 2)).toBe('order (unreadable 2026-08-08 1403 3).md');
	});
});

describe('findFreeQuarantinePath', () => {
	it('returns the unsuffixed path when it is free', () => {
		const path = findFreeQuarantinePath('order.md', TIMESTAMP, () => false);
		expect(path).toBe('order (unreadable 2026-08-08 1403).md');
	});

	it('adjusts the suffix until a free name is found', () => {
		const taken = new Set(['order (unreadable 2026-08-08 1403).md', 'order (unreadable 2026-08-08 1403 2).md']);
		const path = findFreeQuarantinePath('order.md', TIMESTAMP, (p) => taken.has(p));
		expect(path).toBe('order (unreadable 2026-08-08 1403 3).md');
	});

	it('never returns a path isTaken reported as taken', () => {
		const taken = new Set([
			'order (unreadable 2026-08-08 1403).md',
			'order (unreadable 2026-08-08 1403 2).md',
			'order (unreadable 2026-08-08 1403 3).md',
			'order (unreadable 2026-08-08 1403 4).md',
		]);
		const path = findFreeQuarantinePath('order.md', TIMESTAMP, (p) => taken.has(p));
		expect(taken.has(path)).toBe(false);
	});

	it('works for a note in a subfolder the same way as at the root', () => {
		const taken = new Set(['Config/order (unreadable 2026-08-08 1403).md']);
		const path = findFreeQuarantinePath('Config/order.md', TIMESTAMP, (p) => taken.has(p));
		expect(path).toBe('Config/order (unreadable 2026-08-08 1403 2).md');
	});

	it('is a pure function of its inputs: calling isTaken never mutates anything it is given', () => {
		const calls: string[] = [];
		findFreeQuarantinePath('order.md', TIMESTAMP, (p) => {
			calls.push(p);
			return calls.length < 3;
		});
		expect(calls).toEqual([
			'order (unreadable 2026-08-08 1403).md',
			'order (unreadable 2026-08-08 1403 2).md',
			'order (unreadable 2026-08-08 1403 3).md',
		]);
	});
});

describe('isQuarantinePath', () => {
	it('matches a copy this module would have made, whatever its timestamp or collision suffix', () => {
		expect(isQuarantinePath('explorer-order.md', 'explorer-order (unreadable 2026-08-08 1729).md')).toBe(true);
		expect(isQuarantinePath('explorer-order.md', 'explorer-order (unreadable 2026-01-01 0000 3).md')).toBe(true);
	});

	it('does not match the order note itself', () => {
		expect(isQuarantinePath('explorer-order.md', 'explorer-order.md')).toBe(false);
	});

	it('does not match a note in a different folder, or one that merely starts the same', () => {
		expect(isQuarantinePath('config/explorer-order.md', 'explorer-order (unreadable 2026-08-08 1729).md')).toBe(false);
		expect(isQuarantinePath('explorer-order.md', 'explorer-order notes.md')).toBe(false);
		expect(isQuarantinePath('explorer-order.md', 'explorer-order (backup).md')).toBe(false);
	});

	it('matches inside a subfolder, and respects the extension', () => {
		expect(isQuarantinePath('config/explorer-order.md', 'config/explorer-order (unreadable 2026-08-08 1729).md')).toBe(true);
		expect(isQuarantinePath('explorer-order.md', 'explorer-order (unreadable 2026-08-08 1729).txt')).toBe(false);
	});
});
