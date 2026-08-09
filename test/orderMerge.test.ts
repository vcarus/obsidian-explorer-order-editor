import { describe, expect, it } from 'vitest';
import { targetIndexFor } from '../src/rowMove';
import { displayLabel, fallbackEntryOrder, type Entry } from '../src/types';

const file = (name: string): Entry => ({ name, kind: 'file' });
const folder = (name: string): Entry => ({ name, kind: 'folder' });

describe('displayLabel', () => {
	it('strips a trailing .md from a file', () => {
		expect(displayLabel(file('Design.md'))).toBe('Design');
	});

	it('keeps a non-.md file extension as part of the label', () => {
		expect(displayLabel(file('photo.png'))).toBe('photo.png');
	});

	it('a file with no extension at all is returned unchanged', () => {
		expect(displayLabel(file('noext'))).toBe('noext');
	});

	it('an extension-only file name strips down to the empty string', () => {
		expect(displayLabel(file('.md'))).toBe('');
	});

	it('only the final .md is stripped, not an earlier one', () => {
		expect(displayLabel(file('a.md.md'))).toBe('a.md');
	});

	it('the .md match is case-sensitive, mirroring TFile.extension', () => {
		expect(displayLabel(file('A.MD'))).toBe('A.MD');
	});

	it('a folder is never touched, even one literally named with a .md suffix', () => {
		expect(displayLabel(folder('Notes.md'))).toBe('Notes.md');
	});
});

describe('fallbackEntryOrder', () => {
	it('puts every folder before every file, whatever the names are', () => {
		const ordered = fallbackEntryOrder([file('aaa'), folder('zzz'), file('bbb'), folder('yyy')]);
		expect(ordered).toEqual([folder('yyy'), folder('zzz'), file('aaa'), file('bbb')]);
	});

	it('compares runs of digits as numbers, not character by character', () => {
		// The reason `numeric: true` is passed: plain localeCompare puts "10"
		// before "2", which disagrees with the file explorer for any folder
		// using numbered names.
		expect(fallbackEntryOrder([file('10'), file('2'), file('1')])).toEqual([file('1'), file('2'), file('10')]);
		expect(fallbackEntryOrder([file('note-10'), file('note-2')])).toEqual([file('note-2'), file('note-10')]);
		expect(fallbackEntryOrder([folder('20 archive'), folder('3 inbox')])).toEqual([folder('3 inbox'), folder('20 archive')]);
	});

	it('orders names without digits the ordinary way', () => {
		expect(fallbackEntryOrder([file('cherry'), file('apple'), file('banana')])).toEqual([
			file('apple'),
			file('banana'),
			file('cherry'),
		]);
	});

	it('does not mutate the input array', () => {
		const input = [file('b'), file('a')];
		const snapshot = [...input];
		fallbackEntryOrder(input);
		expect(input).toEqual(snapshot);
	});

	it('an empty folder produces an empty order', () => {
		expect(fallbackEntryOrder([])).toEqual([]);
	});

	it('an NFC/NFD pair produces the same output regardless of input order', () => {
		// localeCompare alone treats these as equal (see this function's doc
		// comment and compareNames in types.ts), so without the code-unit
		// tiebreak this pair's relative order would depend on which one
		// folder.children happened to hand in first — not fixed, and not
		// guaranteed to agree across two devices holding the same vault.
		const nfc = file('café.md'.normalize('NFC'));
		const nfd = file('café.md'.normalize('NFD'));
		expect(nfc.name).not.toBe(nfd.name);

		expect(fallbackEntryOrder([nfc, nfd])).toEqual(fallbackEntryOrder([nfd, nfc]));
	});
});

describe('targetIndexFor', () => {
	// [a, b, c, d, e] — index 2 ('c') is neither edge, so every move direction
	// has somewhere to go.
	const count = 5;
	const middle = 2;

	it('up: one position earlier', () => {
		expect(targetIndexFor('up', middle, count)).toBe(1);
	});

	it('down: one position later', () => {
		expect(targetIndexFor('down', middle, count)).toBe(3);
	});

	it('top: index 0', () => {
		expect(targetIndexFor('top', middle, count)).toBe(0);
	});

	it('bottom: the last index', () => {
		expect(targetIndexFor('bottom', middle, count)).toBe(count - 1);
	});

	it('up at index 0 -> null, already at the top', () => {
		expect(targetIndexFor('up', 0, count)).toBeNull();
	});

	it('top at index 0 -> null, already there', () => {
		expect(targetIndexFor('top', 0, count)).toBeNull();
	});

	it('down at the last index -> null, already at the bottom', () => {
		expect(targetIndexFor('down', count - 1, count)).toBeNull();
	});

	it('bottom at the last index -> null, already there', () => {
		expect(targetIndexFor('bottom', count - 1, count)).toBeNull();
	});

	it('a single row (count 1): every move is a no-op', () => {
		expect(targetIndexFor('up', 0, 1)).toBeNull();
		expect(targetIndexFor('down', 0, 1)).toBeNull();
		expect(targetIndexFor('top', 0, 1)).toBeNull();
		expect(targetIndexFor('bottom', 0, 1)).toBeNull();
	});

	it('no rows at all (count 0): every move is a no-op', () => {
		expect(targetIndexFor('up', 0, 0)).toBeNull();
		expect(targetIndexFor('down', 0, 0)).toBeNull();
		expect(targetIndexFor('top', 0, 0)).toBeNull();
		expect(targetIndexFor('bottom', 0, 0)).toBeNull();
	});

	it('an out-of-range index (negative or >= count) never throws, always null', () => {
		expect(targetIndexFor('up', -1, count)).toBeNull();
		expect(targetIndexFor('down', -1, count)).toBeNull();
		expect(targetIndexFor('top', count, count)).toBeNull();
		expect(targetIndexFor('bottom', count, count)).toBeNull();
	});

	// count 2 is the smallest case where a move actually goes somewhere, and
	// where 'down'/'top' collapse to the same destination pairs (there's only
	// one other slot) — worth asserting both agree rather than assuming it
	// from the count-5 cases above.
	it('count 2, index 0 (already at the top): down and bottom agree (both land on index 1)', () => {
		expect(targetIndexFor('down', 0, 2)).toBe(1);
		expect(targetIndexFor('bottom', 0, 2)).toBe(1);
	});

	it('count 2, index 1 (already at the bottom): up and top agree (both land on index 0)', () => {
		expect(targetIndexFor('up', 1, 2)).toBe(0);
		expect(targetIndexFor('top', 1, 2)).toBe(0);
	});
});
