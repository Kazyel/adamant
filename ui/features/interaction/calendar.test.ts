import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dateValue, monthDays, readDate, shiftMonth } from './calendar.ts';

await test('calendar month navigation clamps month ends and keeps leap days when valid', () => {
  const january = readDate('2024-01-31')!;
  assert.equal(dateValue(shiftMonth(january, 1)), '2024-02-29');
  assert.equal(dateValue(shiftMonth(readDate('2024-02-29')!, 12)), '2025-02-28');
  assert.equal(dateValue(shiftMonth(january, -1)), '2023-12-31');
  assert.equal(dateValue(january), '2024-01-31');
});

await test('calendar rejects normalized invalid dates and preserves date-only values across DST', () => {
  for (const value of ['2025-02-29', '2024-02-30', '2025-13-01', '2025-1-01', '', 'invalid']) {
    assert.equal(readDate(value), null);
  }
  for (const value of ['2024-03-10', '2024-11-03', '2024-02-29', '0099-01-01']) {
    assert.equal(dateValue(readDate(value)!), value);
  }
});

await test('calendar grid includes every day once, starting Monday and crossing month boundaries', () => {
  const days = monthDays(readDate('2024-02-15')!);
  assert.equal(days.length, 42);
  assert.equal(days[0].getDay(), 1);
  assert.equal(dateValue(days[0]), '2024-01-29');
  assert.equal(dateValue(days.at(-1)!), '2024-03-10');
  assert.equal(days.filter((day) => day.getMonth() === 1).length, 29);
  assert.equal(new Set(days.map(dateValue)).size, 42);
});
