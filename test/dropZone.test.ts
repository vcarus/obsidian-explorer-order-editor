import { describe, expect, it } from 'vitest';
import { dropSideFor } from '../src/dropZone';

describe('dropSideFor', () => {
	describe('file rows: split 50/50, before | after', () => {
		const rowTop = 0;
		const rowHeight = 100;

		it('top of the row: before', () => {
			expect(dropSideFor(0, rowTop, rowHeight, 'file')).toBe('before');
		});

		it('just above the midline: before', () => {
			expect(dropSideFor(49, rowTop, rowHeight, 'file')).toBe('before');
		});

		it('exactly on the midline: after — the band is [0.5, 1], half-open on the low side', () => {
			expect(dropSideFor(50, rowTop, rowHeight, 'file')).toBe('after');
		});

		it('just below the midline: after', () => {
			expect(dropSideFor(51, rowTop, rowHeight, 'file')).toBe('after');
		});

		it('bottom of the row: after', () => {
			expect(dropSideFor(100, rowTop, rowHeight, 'file')).toBe('after');
		});
	});

	describe('collapsed-folder rows: before | native (null) | after, 25/50/25', () => {
		const rowTop = 0;
		const rowHeight = 100;

		it('top of the row: before', () => {
			expect(dropSideFor(0, rowTop, rowHeight, 'collapsed-folder')).toBe('before');
		});

		it('just above the 0.25 boundary: before', () => {
			expect(dropSideFor(24, rowTop, rowHeight, 'collapsed-folder')).toBe('before');
		});

		it('exactly on the 0.25 boundary: native — the "before" band is half-open on the high side', () => {
			expect(dropSideFor(25, rowTop, rowHeight, 'collapsed-folder')).toBeNull();
		});

		it('middle of the row: native', () => {
			expect(dropSideFor(50, rowTop, rowHeight, 'collapsed-folder')).toBeNull();
		});

		it('just below the 0.75 boundary: native', () => {
			expect(dropSideFor(74, rowTop, rowHeight, 'collapsed-folder')).toBeNull();
		});

		it('exactly on the 0.75 boundary: after — the native band is half-open on the high side too', () => {
			expect(dropSideFor(75, rowTop, rowHeight, 'collapsed-folder')).toBe('after');
		});

		it('further past the 0.75 boundary: still after', () => {
			expect(dropSideFor(76, rowTop, rowHeight, 'collapsed-folder')).toBe('after');
		});

		it('bottom of the row: after', () => {
			expect(dropSideFor(100, rowTop, rowHeight, 'collapsed-folder')).toBe('after');
		});
	});

	describe('expanded-folder rows: before | native (null), no after at all', () => {
		const rowTop = 0;
		const rowHeight = 100;

		it('top of the row: before', () => {
			expect(dropSideFor(0, rowTop, rowHeight, 'expanded-folder')).toBe('before');
		});

		it('just above the 0.25 boundary: before', () => {
			expect(dropSideFor(24, rowTop, rowHeight, 'expanded-folder')).toBe('before');
		});

		it('exactly on the 0.25 boundary: native', () => {
			expect(dropSideFor(25, rowTop, rowHeight, 'expanded-folder')).toBeNull();
		});

		it('middle of the row: native', () => {
			expect(dropSideFor(50, rowTop, rowHeight, 'expanded-folder')).toBeNull();
		});

		it('bottom of the row: native, not after — an expanded folder has no after band', () => {
			expect(dropSideFor(100, rowTop, rowHeight, 'expanded-folder')).toBeNull();
		});
	});

	describe('rowHeight guard', () => {
		it('rowHeight of exactly 0: null, division-by-zero guard', () => {
			expect(dropSideFor(50, 0, 0, 'file')).toBeNull();
			expect(dropSideFor(50, 0, 0, 'collapsed-folder')).toBeNull();
			expect(dropSideFor(50, 0, 0, 'expanded-folder')).toBeNull();
		});

		it('negative rowHeight: null — same rowHeight <= 0 guard as zero; a negative height has no sensible geometry to divide by', () => {
			expect(dropSideFor(50, 100, -20, 'file')).toBeNull();
			expect(dropSideFor(50, 100, -20, 'collapsed-folder')).toBeNull();
		});
	});

	describe('pointer outside the row: clamped to the nearest edge, not null', () => {
		const rowTop = 100;
		const rowHeight = 40;

		it('pointer above rowTop clamps to fraction 0 (before, for every kind that has one)', () => {
			expect(dropSideFor(50, rowTop, rowHeight, 'file')).toBe('before');
			expect(dropSideFor(0, rowTop, rowHeight, 'collapsed-folder')).toBe('before');
			expect(dropSideFor(-1000, rowTop, rowHeight, 'expanded-folder')).toBe('before');
		});

		it('pointer below rowTop + rowHeight clamps to fraction 1', () => {
			expect(dropSideFor(1000, rowTop, rowHeight, 'file')).toBe('after');
			expect(dropSideFor(500, rowTop, rowHeight, 'collapsed-folder')).toBe('after');
			// expanded-folder's fraction-1 band is still native — there is no after to clamp into.
			expect(dropSideFor(9999, rowTop, rowHeight, 'expanded-folder')).toBeNull();
		});
	});

	describe('non-integer row height (real measured row heights are fractional pixels)', () => {
		const rowTop = 200;
		const rowHeight = 27.5;

		it('file: midline at 213.75', () => {
			expect(dropSideFor(213.74, rowTop, rowHeight, 'file')).toBe('before');
			expect(dropSideFor(213.75, rowTop, rowHeight, 'file')).toBe('after');
		});

		it('collapsed-folder: 0.25 boundary at 206.875, 0.75 boundary at 220.625', () => {
			expect(dropSideFor(206.8, rowTop, rowHeight, 'collapsed-folder')).toBe('before');
			expect(dropSideFor(206.9, rowTop, rowHeight, 'collapsed-folder')).toBeNull();
			expect(dropSideFor(220.6, rowTop, rowHeight, 'collapsed-folder')).toBeNull();
			expect(dropSideFor(220.7, rowTop, rowHeight, 'collapsed-folder')).toBe('after');
		});

		it('expanded-folder: 0.25 boundary at 206.875, everything past it is native', () => {
			expect(dropSideFor(206.8, rowTop, rowHeight, 'expanded-folder')).toBe('before');
			expect(dropSideFor(206.9, rowTop, rowHeight, 'expanded-folder')).toBeNull();
			expect(dropSideFor(227.5, rowTop, rowHeight, 'expanded-folder')).toBeNull();
		});
	});
});
