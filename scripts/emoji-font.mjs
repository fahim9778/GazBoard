#!/usr/bin/env node
/*
 * The character list for the bundled emoji font, and how to rebuild that font.
 *
 * src/assets/fonts/gazboard-emoji.woff2 is a cut-down copy of Noto Color
 * Emoji carrying only the characters the picker offers. Trimming is what makes
 * it under half a megabyte instead of five and a half, and it means the file
 * has to be rebuilt whenever the catalogue in src/js/core/emoji.js changes -
 * add an emoji without rebuilding and that one character quietly falls back to
 * whatever the machine owns, which on a phone is the blurry version we bundled
 * the font to get away from.
 *
 * Running this writes the list the font was built from. A test compares that
 * list against the catalogue, so forgetting the rebuild fails the suite rather
 * than shipping one odd-looking emoji.
 *
 *   node scripts/emoji-font.mjs          list the catalogue, write the manifest
 *   node scripts/emoji-font.mjs --how    print the rebuild commands
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EMOJI_GROUPS } from '../src/js/core/emoji.js';

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(here, 'emoji-font-chars.json');

export function catalogueChars() {
  const seen = new Set();
  for (const group of EMOJI_GROUPS) for (const e of group.items) seen.add(e.ch);
  return [...seen];
}

const HOW = `
Rebuilding src/assets/fonts/gazboard-emoji.woff2
------------------------------------------------
Needs Python with fonttools and brotli:

  pip install fonttools brotli

1. Write the character list and a plain text file of those characters:

     node scripts/emoji-font.mjs

2. Take an SVG/COLR build of Noto Color Emoji as the source. The @fontsource
   package carries one:

     npm pack @fontsource/noto-color-emoji
     (the file wanted inside is files/noto-color-emoji-emoji-400-normal.woff2)

3. Trim it to our characters, keeping every layout feature so the sequences
   that need two code points still join up:

     python -m fontTools.subset <source.woff2> ^
       --text-file=scripts/emoji-font-chars.txt ^
       --layout-features=* --no-hinting --desubroutinize ^
       --flavor=woff2 --output-file=src/assets/fonts/gazboard-emoji.woff2

4. Run the suite. The font tests check the size, the format and that the
   manifest and the catalogue still agree.
`;

if (process.argv[2] === '--how') {
  console.log(HOW);
} else {
  const chars = catalogueChars();
  writeFileSync(MANIFEST, JSON.stringify(chars, null, 0) + '\n');
  writeFileSync(join(here, 'emoji-font-chars.txt'), chars.join(''));
  console.log(`Wrote ${chars.length} characters to scripts/emoji-font-chars.json`);
  console.log('Run with --how for the rebuild commands.');
}
