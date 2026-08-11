import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'testvault',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					// Test files are covered by test/tsconfig.json, not by the
					// default project: typescript-eslint hard-errors once more
					// than 8 files fall through to it, so listing 'test/*.ts'
					// here breaks as soon as the suite grows by one file.
					allowDefaultProject: ['eslint.config.mts', 'manifest.json', 'vitest.config.ts'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// The `obsidian` stub is never bundled — `esbuild.config.mjs` lists
		// `obsidian` as external and the production tsconfig compiles `src/`
		// alone — so rules about how a *plugin* must reach timers and globals
		// have nothing to say about it. It has to use the bare ones on purpose:
		// its whole job is to install `window` where node has none.
		//
		// Turned off here rather than left as warnings because `eslint .` exits
		// 0 on warnings, so a noisy report is indistinguishable from a clean
		// one at the gate, and the next genuine warning arrives as one more line
		// in a list nobody reads.
		files: ['test/stubs/**/*.ts'],
		rules: {
			'obsidianmd/no-global-this': 'off',
			'obsidianmd/prefer-window-timers': 'off',
		},
	},
);
