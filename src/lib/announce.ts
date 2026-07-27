// What a card shows of a note or a comment.
//
// Two problems, one place. Notes get pasted out of spreadsheets, so they
// arrive as markdown tables and the panel rendered every pipe and dash of
// them; and a note can be as long as its author felt like, while a card is an
// announcement with the note one click behind it.

const TABLE_ROW = /^\s*\|/;
// A separator row is the `| --- | :--: |` line under a header: punctuation
// only, and it means nothing without the table drawn around it.
const SEPARATOR_ROW = /^\s*\|[\s|:-]*-[\s|:-]*\|?\s*$/;

const flattenRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell !== '')
    .join(' · ');

/**
 * Turns markdown table rows into plain lines, cells joined by a middle dot.
 * Text that merely contains a pipe is left alone — only a line that starts
 * with one is a row.
 */
export const flattenTables = (text: string) => {
  const lines: string[] = [];

  for (const line of text.split('\n')) {
    if (!TABLE_ROW.test(line)) {
      lines.push(line);
      continue;
    }

    if (SEPARATOR_ROW.test(line)) {
      continue;
    }

    const flat = flattenRow(line);

    // A row of nothing but empty cells is the padding around a table, not a
    // blank line somebody typed.
    if (flat !== '') {
      lines.push(flat);
    }
  }

  return lines.join('\n');
};

export const ANNOUNCE_MAX_LINES = 5;
export const ANNOUNCE_MAX_CHARS = 320;

/**
 * Both limits apply, whichever bites first: a table is many short rows and a
 * paragraph is few long ones, and either runs a card off the screen alone.
 */
export const announce = (text: string) => {
  const flat = flattenTables(text);
  const byLine = flat.split('\n').slice(0, ANNOUNCE_MAX_LINES).join('\n');
  const clipped =
    byLine.length > ANNOUNCE_MAX_CHARS
      ? byLine.slice(0, ANNOUNCE_MAX_CHARS).trimEnd()
      : byLine;

  return clipped === flat ? flat : `${clipped}…`;
};
