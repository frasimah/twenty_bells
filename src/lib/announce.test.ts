import { describe, expect, it } from 'vitest';

import {
  ANNOUNCE_MAX_LINES,
  announce,
  flattenTables,
} from 'src/lib/announce';

// Copied off a real note: somebody's weekly plan, pasted out of a spreadsheet.
const PASTED_TABLE = [
  '|                                          |       |        |             |',
  '| ---------------------------------------- | ----- | ------ | ----------- |',
  '| задача                                   | чекин | статус | комментарии |',
  '| доделать и согласовать новый дизайнгайд  | 20.07 |        |             |',
  '| запустить работу по дизайну              | 16.07 |        |             |',
].join('\n');

describe('flattenTables', () => {
  it('joins the cells of a row and drops the scaffolding', () => {
    expect(flattenTables(PASTED_TABLE).split('\n')).toEqual([
      'задача · чекин · статус · комментарии',
      'доделать и согласовать новый дизайнгайд · 20.07',
      'запустить работу по дизайну · 16.07',
    ]);
  });

  it('leaves prose alone, pipes and all', () => {
    const prose = 'Выбор такой: A | B. Решаем завтра.\n\nВторой абзац.';

    expect(flattenTables(prose)).toBe(prose);
  });

  it('keeps the blank lines an author typed', () => {
    expect(flattenTables('первый\n\nвторой')).toBe('первый\n\nвторой');
  });

  it('survives a row with no closing pipe', () => {
    expect(flattenTables('| одна | две')).toBe('одна · две');
  });
});

describe('announce', () => {
  it('leaves a short note exactly as it is', () => {
    expect(announce('Короткая заметка.')).toBe('Короткая заметка.');
  });

  it('clamps by lines and says it did', () => {
    const long = Array.from({ length: 12 }, (_, i) => `строка ${i + 1}`).join('\n');
    const result = announce(long);

    expect(result.split('\n')).toHaveLength(ANNOUNCE_MAX_LINES);
    expect(result.endsWith('…')).toBe(true);
    expect(result.startsWith('строка 1\n')).toBe(true);
  });

  it('clamps by characters when a single line is the problem', () => {
    const result = announce('я'.repeat(900));

    expect(result.length).toBeLessThan(400);
    expect(result.endsWith('…')).toBe(true);
  });

  it('flattens before it counts, so a table gets five rows and not five pipes', () => {
    expect(announce(PASTED_TABLE)).toBe(flattenTables(PASTED_TABLE));
  });
});
