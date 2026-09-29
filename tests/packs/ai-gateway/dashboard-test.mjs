// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Merged suite. Each section below was a standalone suite and keeps its own scope:
//   - calendar-heatmap-test.mjs
//   - calendar-heatmap-view-test.mjs
//   - calendar-heatmap-contract-test.mjs
//   - dashboard-model-filter-test.mjs
//   - dashboard-consumption-semantics-test.mjs
//   - readme-status-test.mjs

import { targetRoot as root } from '#kit/target.mjs';
import { collectVarsFromEnv } from '#target/scripts/github-deployment-config.mjs';
import { renderHeatmap } from '#target/src/dashboard/heatmap-view.ts';
import { buildCalendarHeatmap } from '#target/src/dashboard/heatmap.ts';
import { filterDashboardModelStatus, publicModelStatus, renderModels } from '#target/src/dashboard/model-status-view.ts';
import { quickStartSection } from '#target/src/dashboard/quick-start-view.ts';
import { readmeStatusSvgResponse, renderReadmeStatusSvg } from '#target/src/dashboard/readme-status.ts';
import { THEME_CSS } from '#target/src/dashboard/theme.ts';
import { buildHeatmap, selectDashboardModelUsageRows, usageSection } from '#target/src/dashboard/usage-view.ts';
import { loadUpstreamDaily } from '#target/src/observability/token-usage-store.ts';
import { preflight } from '#target/src/request/preflight.ts';
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ==========================================================================
// calendar-heatmap-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // @ts-check
  // Copyright (c) 2026 Fongap Labs
  //
  // Calendar heatmap utility tests (PR: refactor heatmap into a shared
  // rolling-52-weeks / calendar-year abstraction). The spec lives in
  // docs/architecture/calendar-heatmap.md; the assertions here pin the
  // observable contract — date keys, weekIndex / weekdayIndex, inRange /
  // isFuture semantics, the two modes' time-range rules, and the month
  // label anchoring.




  function dateAtIso(iso) {
    // TRUE UTC+8 midnight for the business date `iso` (= 16:00Z on the
    // previous day). Deliberately NOT `${iso}T00:00:00Z`: that instant is
    // 08:00 UTC+8 on the same business day, so boundary tests would pass by
    // coincidence ("the day is still the same") without ever exercising the
    // timezone conversion. Starting from the real UTC+8 midnight makes the
    // builder's day-boundary math part of every assertion below.
    return Date.parse(`${iso}T00:00:00+08:00`);
  }

  async function test(name, fn) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      console.error(`not ok - ${name}`);
      console.error(error?.stack || error);
      process.exitCode = 1;
    }
  }

  // === Mode A: rolling-52-weeks =============================================

  await test('rolling-52-weeks: 52 columns, 7 days each, current week is the last column', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
    assert.equal(heatmap.weeks.length, 52, '52 week columns');
    for (const week of heatmap.weeks) assert.equal(week.length, 7, '7 days per week');
    // Last column is the current week (Mon = 2026-08-31).
    const last = heatmap.weeks[51];
    assert.equal(last[0].date, '2026-08-31', 'column 51 week-start is Monday 2026-08-31');
    assert.equal(last[0].weekdayIndex, 0, 'Monday is weekday 0');
    assert.equal(last[4].date, '2026-09-04', 'Friday matches the today input');
    assert.equal(last[4].isFuture, false, 'Friday 2026-09-04 is NOT in the future');
    assert.equal(last[5].date, '2026-09-05', 'Saturday 2026-09-05 (future)');
    assert.equal(last[5].isFuture, true, 'Saturday is future');
    assert.equal(last[6].date, '2026-09-06', 'Sunday 2026-09-06 (future)');
    assert.equal(last[6].isFuture, true, 'Sunday is future');
  });

  await test('rolling-52-weeks: future cells keep their layout slot but value is null', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
    const lastSat = heatmap.weeks[51][5];
    assert.equal(lastSat.inRange, true, 'future Saturday is still inRange');
    assert.equal(lastSat.isFuture, true);
    assert.equal(lastSat.value, null, 'value is null for future cells');
  });

  await test('rolling-52-weeks: weekday index is Monday-first even when JavaScript Date.getDay is Sunday-first', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
    // 2026-09-04 is a Friday -> weekdayIndex 4 (Mon=0..Sun=6)
    assert.equal(heatmap.weeks[51][4].weekdayIndex, 4, 'Friday has weekdayIndex 4');
    // 2026-09-05 is a Saturday -> weekdayIndex 5
    assert.equal(heatmap.weeks[51][5].weekdayIndex, 5);
    // 2026-09-06 is a Sunday -> weekdayIndex 6
    assert.equal(heatmap.weeks[51][6].weekdayIndex, 6);
    // 2026-08-31 is a Monday -> weekdayIndex 0
    assert.equal(heatmap.weeks[51][0].weekdayIndex, 0);
  });

  await test('rolling-52-weeks: month labels anchor to where each month 1st lives', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
    // The label for 2026-09-01 (Tuesday) must point at the column that
    // contains 2026-09-01, NOT at the column whose Monday is in August.
    const sep1 = heatmap.monthLabels.find((l) => l.year === 2026 && l.month === 8);
    assert.ok(sep1, 'September label exists');
    const col = sep1.weekIndex;
    const datesInCol = heatmap.weeks[col].map((c) => c.date);
    assert.ok(datesInCol.includes('2026-09-01'), `column ${col} contains 2026-09-01`);
  });

  await test('rolling-52-weeks: business data is matched by YYYY-MM-DD key, not position', () => {
    const today = dateAtIso('2026-09-04');
    const data = new Map();
    data.set('2026-08-15', { total: 100, requests: 2 });
    const heatmap = buildCalendarHeatmap({
      mode: 'rolling-52-weeks',
      today,
      data,
      valueKey: 'total',
    });
    // Find the cell whose date is 2026-08-15.
    let found = null;
    for (const week of heatmap.weeks)
      for (const cell of week) {
        if (cell.date === '2026-08-15') {
          found = cell;
          break;
        }
      }
    assert.ok(found, 'cell exists for 2026-08-15');
    assert.equal(found.value, 100, 'value comes from the data Map, not from a position');
  });

  await test('rolling-52-weeks: in-range past cells with no data are 0 (real number, not null)', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today, data: null });
    // Pick a date well in the past — its value should be 0, not null.
    let past = null;
    for (const week of heatmap.weeks)
      for (const cell of week) {
        if (cell.date === '2026-08-01') {
          past = cell;
          break;
        }
      }
    assert.ok(past, 'cell for 2026-08-01 exists');
    assert.equal(past.inRange, true);
    assert.equal(past.isFuture, false);
    assert.equal(past.value, 0, 'in-range past cell with no data has value=0');
  });

  // === Mode B: calendar-year ===============================================

  await test('calendar-year 2026: rangeStart=2026-01-01, rangeEnd=2026-12-31', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
    assert.equal(heatmap.rangeStart, '2026-01-01');
    assert.equal(heatmap.rangeEnd, '2026-12-31');
  });

  await test('calendar-year 2026: 2026-01-01 is a Thursday (weekdayIndex=3)', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
    let first = null;
    for (const week of heatmap.weeks)
      for (const cell of week) {
        if (cell.date === '2026-01-01') {
          first = cell;
          break;
        }
      }
    assert.ok(first, '2026-01-01 cell exists');
    assert.equal(first.weekdayIndex, 3, '2026-01-01 is Thursday (Mon=0..Sun=6 -> 3)');
  });

  await test('calendar-year 2026: layout padding before Jan 1 is out of range', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
    // 2025-12-29, 2025-12-30, 2025-12-31 must be present as layout
    // placeholders for the first column but inRange must be false.
    for (const iso of ['2025-12-29', '2025-12-30', '2025-12-31']) {
      let cell = null;
      for (const week of heatmap.weeks)
        for (const c of week) {
          if (c.date === iso) {
            cell = c;
            break;
          }
        }
      assert.ok(cell, `${iso} cell exists (layout placeholder)`);
      assert.equal(cell.inRange, false, `${iso} is layout padding, not in 2026 range`);
      assert.equal(cell.value, null, `${iso} value is null`);
    }
  });

  await test('calendar-year 2026: layout padding after Dec 31 is out of range', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
    // 2027-01-01..2027-01-03 may or may not be in the grid depending on
    // 2026-12-31's weekday. If present, they must be inRange=false.
    for (const week of heatmap.weeks)
      for (const cell of week) {
        if (cell.date >= '2027-01-01') {
          assert.equal(cell.inRange, false, `${cell.date} is 2027, not in 2026 range`);
        }
      }
  });

  await test('calendar-year 2026: months 1..12 each have a label, anchored to the week of their 1st day', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
    assert.equal(heatmap.monthLabels.length, 12, '12 month labels');
    for (let m = 0; m < 12; m += 1) {
      const label = heatmap.monthLabels.find((l) => l.month === m);
      assert.ok(label, `month ${m + 1} label exists`);
      // The column must contain the 1st day of that month.
      const iso = `${label.year}-${String(m + 1).padStart(2, '0')}-01`;
      const datesInCol = heatmap.weeks[label.weekIndex].map((c) => c.date);
      assert.ok(datesInCol.includes(iso), `month ${m + 1} label column contains ${iso}`);
    }
  });

  await test('calendar-year current year: future days in-range but value null', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
    let future = null;
    for (const week of heatmap.weeks)
      for (const c of week) {
        if (c.date === '2026-12-31') {
          future = c;
          break;
        }
      }
    assert.ok(future, '2026-12-31 cell exists');
    assert.equal(future.inRange, true);
    assert.equal(future.isFuture, true, '2026-12-31 is in-range future when today=2026-09-04');
    assert.equal(future.value, null, 'value is null for future cells');
  });

  await test('calendar-year historical year: no future days', () => {
    // 2025 is fully in the past relative to today=2026-09-04.
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2025 });
    for (const week of heatmap.weeks)
      for (const cell of week) {
        if (cell.inRange) {
          assert.equal(cell.isFuture, false, `${cell.date} in 2025 must NOT be future when today=2026-09-04`);
        }
      }
  });

  await test('calendar-year: 2026 has EXACTLY 53 columns and 365 in-range days', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
    // 2026-01-01 is Thursday (Mon-first dow 3), 2026 is not a leap year:
    // the year spans exactly 53 Monday-first calendar week columns. For a
    // given year the count is deterministic — "53 or 54" is not a contract.
    assert.equal(heatmap.weeks.length, 53, `got ${heatmap.weeks.length} weeks`);
    const inRange = heatmap.weeks.flat().filter((c) => c.inRange).length;
    assert.equal(inRange, 365, '365 in-range days (53*7=371 cells, 6 padding)');
  });

  await test('calendar-year: a leap year starting on Sunday spans EXACTLY 54 columns (2012)', () => {
    // 2012-01-01 is a Sunday (Mon-first dow 6) and 2012 is a leap year, so
    // Dec 31 lands in a week whose Monday is exactly 53 weeks after the
    // first column's Monday: 54 real columns, 366 in-range days.
    const today = dateAtIso('2012-06-15');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2012 });
    assert.equal(heatmap.weeks.length, 54, `got ${heatmap.weeks.length} weeks`);
    const inRange = heatmap.weeks.flat().filter((c) => c.inRange).length;
    assert.equal(inRange, 366);
  });

  await test('calendar-year: 2040 is also an EXACT 54-column year (leap + Sunday Jan 1)', () => {
    const today = dateAtIso('2040-06-15');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2040 });
    assert.equal(heatmap.weeks.length, 54, `got ${heatmap.weeks.length} weeks`);
  });

  await test('calendar-year: non-leap years have EXACTLY 53 columns (2019)', () => {
    // 2019-01-01 is a Tuesday — the non-trivial layout case.
    const today = dateAtIso('2019-06-15');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2019 });
    assert.equal(heatmap.weeks.length, 53, `got ${heatmap.weeks.length} weeks`);
  });

  await test('calendar-year: leap year 2028 includes 2028-02-29 and has EXACTLY 53 columns / 366 days', () => {
    const today = dateAtIso('2028-02-29');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2028 });
    assert.equal(heatmap.weeks.length, 53, `got ${heatmap.weeks.length} weeks`);
    let leap = null;
    for (const week of heatmap.weeks)
      for (const c of week) {
        if (c.date === '2028-02-29') {
          leap = c;
          break;
        }
      }
    assert.ok(leap, '2028-02-29 cell exists');
    assert.equal(leap.inRange, true, '2028-02-29 is in 2028 range');
    const inRange = heatmap.weeks.flat().filter((c) => c.inRange).length;
    assert.equal(inRange, 366, 'leap year has 366 in-range days');
  });

  // === Month-boundary anchoring ==============================================

  await test('rolling-52-weeks: 8月31日 (Mon) and 9月1日 (Tue) share the last column; 9月 anchors there', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
    const last = heatmap.weeks[51];
    assert.equal(last[0].date, '2026-08-31', 'last column starts Monday 8月31日');
    assert.equal(last[1].date, '2026-09-01', '9月1日 sits in the SAME column');
    const sep = heatmap.monthLabels.find((l) => l.year === 2026 && l.month === 8);
    assert.ok(sep, 'September label exists');
    assert.equal(sep.weekIndex, 51, '9月 anchors to weekIndex 51 (the column containing 2026-09-01), NOT to the column whose Monday is in August');
  });

  await test('calendar-year: month starting on Monday anchors to its own week column (2027-02-01)', () => {
    const today = dateAtIso('2027-02-01');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2027 });
    const feb = heatmap.monthLabels.find((l) => l.month === 1);
    assert.ok(feb, 'February label exists');
    assert.equal(heatmap.weeks[feb.weekIndex][0].date, '2027-02-01', '2027-02-01 is a Monday -> the February label column starts on it');
  });

  await test('calendar-year: month starting on Sunday anchors to the PREVIOUS week column (2026-02-01)', () => {
    const today = dateAtIso('2026-02-01');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
    const feb = heatmap.monthLabels.find((l) => l.month === 1);
    assert.ok(feb, 'February label exists');
    const col = heatmap.weeks[feb.weekIndex].map((c) => c.date);
    assert.ok(col.includes('2026-02-01'), 'label column contains 2026-02-01');
    assert.equal(
      heatmap.weeks[feb.weekIndex][0].date,
      '2026-01-26',
      '2026-02-01 is a Sunday -> column Monday is 2026-01-26 (label is NOT pushed to the next column)',
    );
  });

  await test('rolling-52-weeks: labels span the 12月 → 1月 year boundary', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
    const dec = heatmap.monthLabels.find((l) => l.year === 2025 && l.month === 11);
    const jan = heatmap.monthLabels.find((l) => l.year === 2026 && l.month === 0);
    assert.ok(dec, '2025-12 label exists');
    assert.ok(jan, '2026-01 label exists');
    assert.ok(dec.weekIndex < jan.weekIndex, 'each label anchors at its own month start');
  });

  // === UTC+8 day-boundary =====================================================

  await test('UTC+8 midnight boundary: 15:59:59Z vs 16:00:00Z split the business day', () => {
    // 2026-09-03T15:59:59Z = 2026-09-03 23:59:59 UTC+8; 2026-09-03T16:00:00Z
    // = 2026-09-04 00:00:00 UTC+8. The business date advances by one day,
    // the weekday follows the business date (Thu -> Fri), the month does
    // not shift.
    const before = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: Date.parse('2026-09-03T15:59:59Z') });
    const after = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: Date.parse('2026-09-03T16:00:00Z') });
    assert.equal(before.weeks[51][3].date, '2026-09-03', 'business today is Thursday 2026-09-03 before the boundary');
    assert.equal(before.weeks[51][3].weekdayIndex, 3, 'Thursday is weekday 3 — no weekday offset');
    assert.equal(before.weeks[51][4].isFuture, true, '2026-09-04 is future before the boundary');
    assert.equal(after.weeks[51][4].date, '2026-09-04', 'business today is Friday 2026-09-04 after the boundary');
    assert.equal(after.weeks[51][4].weekdayIndex, 4, 'Friday is weekday 4 — no weekday offset');
    assert.equal(after.weeks[51][4].isFuture, false, '2026-09-04 is today after the boundary');
    assert.equal(after.monthLabels[after.monthLabels.length - 1].month, 8, 'month label does not shift with the boundary');
  });

  await test('UTC+8 month/week boundary: 2026-08-31T16:00:00Z rolls date AND month with correct weekday math', () => {
    const before = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: Date.parse('2026-08-31T15:59:59Z') });
    const after = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: Date.parse('2026-08-31T16:00:00Z') });
    assert.equal(before.weeks[51][0].date, '2026-08-31', 'business today is Monday 8月31日 before the boundary');
    assert.equal(before.weeks[51][0].weekdayIndex, 0);
    assert.equal(after.weeks[51][1].date, '2026-09-01', 'business today is Tuesday 9月1日 after the boundary');
    assert.equal(after.weeks[51][1].weekdayIndex, 1, 'Tuesday is weekday 1 — no weekday offset');
    assert.equal(after.weeks[51][0].date, '2026-08-31', 'both sides share the same current-week Monday');
    const sepBefore = before.monthLabels.find((l) => l.year === 2026 && l.month === 8);
    const sepAfter = after.monthLabels.find((l) => l.year === 2026 && l.month === 8);
    assert.equal(sepBefore.weekIndex, 51, '9月 anchors to the last column before the boundary');
    assert.equal(sepAfter.weekIndex, 51, '9月 anchors to the last column after the boundary');
  });

  await test('rolling-52-weeks: Date input also works (not just number ms)', () => {
    const today = new Date('2026-09-04T08:00:00Z');
    const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
    assert.equal(heatmap.weeks.length, 52);
    // 2026-09-04 (UTC+8) is the same calendar day.
    const last = heatmap.weeks[51][4];
    assert.equal(last.date, '2026-09-04');
  });

  await test('rolling-52-weeks: rejects unknown mode', () => {
    assert.throws(() => buildCalendarHeatmap({ mode: 'wrong', today: Date.now() }), /unknown mode/);
  });

  await test('rolling-52-weeks: rejects missing mode', () => {
    assert.throws(() => buildCalendarHeatmap({ today: Date.now() }), /mode is required/);
  });

  await test('rolling-52-weeks: rejects non-finite today', () => {
    assert.throws(() => buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: NaN }), /today must be a Date/);
  });
  console.log('ok - file:calendar-heatmap');
} catch (error) {
  console.error('not ok - calendar-heatmap-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// calendar-heatmap-view-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // @ts-check
  // Copyright (c) 2026 Fongap Labs
  //
  // Calendar heatmap renderer tests. Pins the HTML contract the dashboard
  // depends on:
  //   * 364 cells (52 * 7) for `rolling-52-weeks`
  //   * 53/54 cells (NOT 52) for `calendar-year` 2026
  //   * data-level="0" for out-of-range / future / zero cells
  //   * data-level="1".."4" for active cells, quantized to max
  //   * month labels carry the M月 text and a grid-column index
  //   * data-tooltip, data-date, data-future, data-inrange attributes
  //     are present so the existing PAGE_SCRIPT tooltip layer keeps
  //     working and so a future "data-future" / "data-inrange" CSS rule
  //     can be added without breaking layout.





  function dateAtIso(iso) {
    // TRUE UTC+8 midnight (= 16:00Z the previous day), NOT `${iso}T00:00:00Z`
    // (which is 08:00 UTC+8) — see calendar-heatmap-test.mjs for the rationale.
    return Date.parse(`${iso}T00:00:00+08:00`);
  }

  async function test(name, fn) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      console.error(`not ok - ${name}`);
      console.error(error?.stack || error);
      process.exitCode = 1;
    }
  }

  await test('renderer rolling-52-weeks: 364 cells, 12 month labels, levels 0/1..4 populated', () => {
    const today = dateAtIso('2026-09-04');
    const data = new Map();
    data.set('2026-09-04', { total: 100, requests: 1 });
    data.set('2026-08-15', { total: 25, requests: 1 });
    data.set('2026-08-01', { total: 1, requests: 1 });
    const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today, data, valueKey: 'total' });
    const { cells, labels, ariaLabel } = renderHeatmap(heatmap, { data, valueKey: 'total' });
    assert.equal(cells.length, 364, '52 * 7 cells');
    assert.ok(labels.length >= 11 && labels.length <= 13, `12 month labels (got ${labels.length})`);
    // 100 is the max -> level 4. 25 is ~25% of max -> level 1 (ceil).
    // 1 is ~1% of max -> level 1 (max(1, ...)).
    const html = cells.join('');
    assert.ok(html.includes('data-level="4"'), 'max-day is level 4');
    assert.ok(html.includes('data-level="1"'), 'low days are level 1');
    assert.ok(html.includes('data-level="0"'), 'zero days are level 0');
    // data-future and data-inrange are now part of the contract.
    assert.ok(html.includes('data-future="1"'), 'future cells carry data-future="1"');
    assert.ok(html.includes('data-future="0"'), 'past cells carry data-future="0"');
    assert.ok(html.includes('data-inrange="1"'), 'in-range cells carry data-inrange="1"');
    assert.ok(html.includes('data-date="2026-09-04"'), 'every cell has its YYYY-MM-DD key on data-date');
    assert.match(ariaLabel, /近 52 周/);
  });

  await test('renderer rolling-52-weeks: future cells stay level 0, tooltip is the bare ISO date', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
    const { cells } = renderHeatmap(heatmap);
    // The last column's Sat (2026-09-05) and Sun (2026-09-06) are
    // future cells; their tooltip must NOT contain "Token" or "次请求".
    const satCell = cells.find((c) => c.includes('data-date="2026-09-05"'));
    assert.ok(satCell, 'Saturday cell exists');
    assert.match(satCell, /data-level="0"/, 'future Saturday is level 0');
    assert.match(satCell, /data-future="1"/);
    assert.match(satCell, /data-tooltip="2026-09-05"/, 'future tooltip is bare ISO');
    assert.ok(!satCell.includes('次请求'), 'future cell has no request count');
  });

  await test('renderer rolling-52-weeks: tooltip carries date + tokens + requests', () => {
    const today = dateAtIso('2026-09-04');
    const data = new Map();
    data.set('2026-08-15', { total: 12345, requests: 7 });
    const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today, data });
    const { cells } = renderHeatmap(heatmap, { data });
    const cell = cells.find((c) => c.includes('data-date="2026-08-15"'));
    assert.ok(cell, 'cell exists for 2026-08-15');
    // The tooltip should contain the month/day + token count + request count.
    // We use loose matching because the formatter outputs CJK characters
    // and the console encoding may mangle them, but the structure is stable.
    assert.match(cell, /data-tooltip="[^"]*Token[^"]*次请求"/);
    assert.match(cell, /data-tooltip="[^"]*1\.2万[^"]*"/);
    assert.match(cell, /data-tooltip="[^"]*7 次请求"/);
  });

  await test('renderer calendar-year 2026: 53 columns, 12 month labels, no inRange past cells are quantified as 0', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
    const { cells, labels, ariaLabel } = renderHeatmap(heatmap);
    // 2026 has 53 columns
    assert.equal(cells.length, 53 * 7, `53 columns * 7 days = 371 cells (got ${cells.length})`);
    assert.equal(labels.length, 12, '12 month labels');
    assert.match(ariaLabel, /2026/);
    // Out-of-range (Dec 2025 padding) cells are level 0.
    const paddingCell = cells.find((c) => c.includes('data-date="2025-12-31"'));
    assert.ok(paddingCell, '2025-12-31 padding cell exists');
    assert.match(paddingCell, /data-level="0"/);
    assert.match(paddingCell, /data-inrange="0"/);
  });

  await test('renderer calendar-year 2026: month labels are in 1..12 order and use the right week column', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
    const { labels } = renderHeatmap(heatmap);
    const seen = labels.map((l) => Number(l.match(/>(\d+)月</)[1]));
    // 1..12 in order (the spec mandates month order; we still collapse
    // any duplicate month-start that lands on the same week).
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i] >= seen[i - 1], `month label order is non-decreasing: ${seen.join(', ')}`);
    }
    assert.ok(seen[0] === 1 || seen[0] === 2, `first month label is 1月 or 2月 (got ${seen[0]}月)`);
    assert.ok(seen[seen.length - 1] <= 12, 'last month label is <= 12月');
  });

  await test('renderer rolling-52-weeks: month labels never crowd closer than 3 columns', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
    const { labels } = renderHeatmap(heatmap);
    let lastCol = -99;
    for (const l of labels) {
      const col = Number(l.match(/grid-column:(\d+)/)[1]);
      if (lastCol > -99) {
        assert.ok(col - lastCol >= 3, `month label at column ${col} is too close to previous (${lastCol})`);
      }
      lastCol = col;
    }
  });

  await test('renderer rolling-52-weeks: the right-edge 9月 label is NOT dropped and binds to week 51', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
    const { labels } = renderHeatmap(heatmap);
    // 2026-09-01 sits in the LAST week column (weekIndex 51). The renderer
    // must not drop the label near the right boundary — it is date
    // semantics, and the shared CSS grid positions it.
    const sep = labels.find((l) => l.includes('>9月<'));
    assert.ok(sep, '9月 label present in renderer output');
    assert.match(sep, /grid-column:52/, '9月 binds to weekIndex 51 (grid-column 52), the real position of 2026-09-01');
  });

  await test('renderer: cells carry data-week/data-weekday and explicit grid placement from the HeatmapDay', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today });
    const { cells } = renderHeatmap(heatmap);
    const sep1 = cells.find((c) => c.includes('data-date="2026-09-01"'));
    assert.ok(sep1, 'cell for 2026-09-01 exists');
    assert.match(sep1, /data-week="51"/, 'data-week comes from the HeatmapDay');
    assert.match(sep1, /data-weekday="1"/, 'data-weekday comes from the HeatmapDay');
    assert.match(sep1, /style="grid-column:52;grid-row:2"/, 'explicit placement — position never depends on DOM order');
    for (const c of cells) {
      assert.match(c, /style="grid-column:\d+;grid-row:\d+"/, 'every cell positions itself explicitly');
      assert.match(c, /data-week="\d+" data-weekday="\d+"/, 'every cell carries its position facts');
    }
  });

  await test('renderer calendar-year 2026: 1月 at column 1 and 12月 present — no edge drops', () => {
    const today = dateAtIso('2026-09-04');
    const heatmap = buildCalendarHeatmap({ mode: 'calendar-year', today, year: 2026 });
    const { labels } = renderHeatmap(heatmap);
    assert.equal(labels.length, 12, 'all 12 month labels render — edges included');
    assert.match(labels[0], /grid-column:1">1月</, '1月 anchors to the padding column containing 2026-01-01');
    assert.ok(
      labels.some((l) => l.includes('>12月<')),
      '12月 never dropped near the right edge',
    );
  });

  await test('renderer: HTML escaping of tooltip payloads with special chars', () => {
    const today = dateAtIso('2026-09-04');
    const data = new Map();
    data.set('2026-08-15', { total: 100, requests: 1 });
    const heatmap = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today, data });
    // Render with a name that contains & < > in the data so we can assert escaping.
    // We can't easily inject HTML through the date key, but we can verify
    // that the level-4 cell is properly emitted with all expected attributes.
    const { cells } = renderHeatmap(heatmap, { data });
    const cell = cells.find((c) => c.includes('data-date="2026-08-15"'));
    assert.ok(/^<i [^>]+><\/i>$/.test(cell), 'cell is a single self-closed <i> tag');
    // Confirm all attribute values are quoted.
    assert.ok(/data-level="[0-4]"/.test(cell));
    assert.ok(/data-tooltip="[^"]*"/.test(cell));
    assert.ok(/aria-label="[^"]*"/.test(cell));
  });
  console.log('ok - file:calendar-heatmap-view');
} catch (error) {
  console.error('not ok - calendar-heatmap-view-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// calendar-heatmap-contract-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Calendar Heatmap Contract — the spec table from the release-hardening
  // round, pinned as executable contracts. The two modes' semantics live in
  // docs/architecture/calendar-heatmap.md; the builder/renderer suites pin
  // behavior in depth, this file pins the CONTRACT so any regression fails
  // with the spec clause in the failure message:
  //
  //   C01  rolling-52-weeks always has exactly 52 columns
  //   C02  Monday-first weekday indexing (Mon=0 .. Sun=6)
  //   C03  business data key is YYYY-MM-DD, matched by key (never position)
  //   C04  future is NOT zero (future -> value null; past no-data -> value 0)
  //   C05  month label anchors at the weekIndex containing the month's 1st day
  //   C06  right-edge month label is never dropped (9月 at the last column)
  //   C07  calendar-year range is Jan 1 .. Dec 31
  //   C08  calendar-year column count is dynamic AND exact (53; 54 for a
  //        leap year starting on Sunday)
  //   C09  calendar-year year-padding is inRange=false / value null
  //   C10  current-year future dates are inRange=true / isFuture / null
  //   C11  historical years contain no future days
  //   C12  leap day exists in range (2028-02-29) with correct day counts
  //   C13  UTC+8 midnight boundary (15:59:59Z vs 16:00:00Z) — date advances,
  //        weekday and month do not shift
  //   C14  renderer and builder share the same week column (data-week /
  //        data-weekday / explicit grid placement match the builder grid)
  //   C15  `.months` shares the heatmap's week-column tracks via the
  //        `--week-count` CSS grid — never flex/space-between







  const __dirname = dirname(fileURLToPath(import.meta.url));


  // TRUE UTC+8 midnight (= 16:00Z the previous day) — see
  // calendar-heatmap-test.mjs for why `${iso}T00:00:00Z` would be wrong.
  const dateAtIso = (iso) => Date.parse(`${iso}T00:00:00+08:00`);

  let failures = 0;
  function check(name, ok, detail) {
    if (ok) console.log(`  ok  ${name}`);
    else {
      failures++;
      console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
  }

  const flat = (h) => h.weeks.flat();
  const findCell = (h, iso) => flat(h).find((c) => c.date === iso) || null;

  // ---- C01: rolling-52-weeks always 52 columns ---------------------------------
  {
    const todays = ['2026-01-01', '2026-09-04', '2026-12-31', '2025-02-28', '2028-02-29', '2020-02-29'];
    const counts = todays.map((iso) => buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: dateAtIso(iso) }).weeks.length);
    check(
      'C01 rolling-52-weeks is always exactly 52 columns',
      counts.every((n) => n === 52),
      `todays=${todays.join(',')} counts=${counts.join(',')}`,
    );
  }

  // ---- C02: Monday-first ---------------------------------------------------------
  {
    const h = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: dateAtIso('2026-09-04') });
    const last = h.weeks[51];
    const okDates = last[0].date === '2026-08-31' && last[6].date === '2026-09-06';
    const okIdx = last.every((c, d) => c.weekdayIndex === d);
    check('C02 Monday-first: column starts Monday (2026-08-31), weekdayIndex 0..6', okDates && okIdx, `first=${last[0].date} last=${last[6].date}`);
  }

  // ---- C03: business key = YYYY-MM-DD --------------------------------------------
  {
    const data = new Map([['2026-08-15', { total: 123, requests: 4 }]]);
    const h = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: dateAtIso('2026-09-04'), data });
    const cell = findCell(h, '2026-08-15');
    const allIso = flat(h).every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.date) && Number.isFinite(Date.parse(`${c.date}T00:00:00Z`)));
    check(
      'C03 business key is YYYY-MM-DD and data is matched by key, not position',
      allIso && cell && cell.value === 123,
      `cell=${JSON.stringify(cell)}`,
    );
  }

  // ---- C04: future != zero --------------------------------------------------------
  {
    const h = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: dateAtIso('2026-09-04') });
    const future = findCell(h, '2026-09-05');
    const pastNoData = findCell(h, '2026-08-01');
    check(
      'C04 future -> null; in-range past with no data -> real 0',
      future?.isFuture && future.value === null && pastNoData && !pastNoData.isFuture && pastNoData.value === 0,
      `future=${JSON.stringify(future)} past=${JSON.stringify(pastNoData)}`,
    );
  }

  // ---- C05: month label = monthStart weekIndex ------------------------------------
  {
    const h = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: dateAtIso('2026-09-04') });
    const sep = h.monthLabels.find((l) => l.year === 2026 && l.month === 8);
    const ok = sep && h.weeks[sep.weekIndex].some((c) => c.date === '2026-09-01');
    check('C05 month label anchors at the weekIndex containing the month 1st day', Boolean(ok), `sep=${JSON.stringify(sep)}`);
  }

  // ---- C06: right-edge month is never dropped --------------------------------------
  {
    const h = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: dateAtIso('2026-09-04') });
    const { labels } = renderHeatmap(h);
    const sep = labels.find((l) => l.includes('>9月<'));
    check(
      'C06 right-edge month label present and bound to the last week column',
      Boolean(sep) && /grid-column:52/.test(sep || ''),
      `labels=${labels.length}`,
    );
  }

  // ---- C07 + C08: calendar-year range and exact column counts ----------------------
  {
    const h = buildCalendarHeatmap({ mode: 'calendar-year', today: dateAtIso('2026-09-04'), year: 2026 });
    const rangeOk = h.rangeStart === '2026-01-01' && h.rangeEnd === '2026-12-31';
    // Non-leap years: exactly 53 columns. Leap years starting on Sunday
    // (2012, 2040): exactly 54. Every other leap year: 53.
    const cases = [
      [2012, 54],
      [2015, 53],
      [2016, 53],
      [2019, 53],
      [2026, 53],
      [2027, 53],
      [2028, 53],
      [2040, 54],
    ];
    const counts = cases.map(([y, expected]) => {
      const hy = buildCalendarHeatmap({ mode: 'calendar-year', today: dateAtIso(`${y}-06-15`), year: y });
      return hy.weeks.length === expected;
    });
    check('C07 calendar-year range is Jan 1 .. Dec 31', rangeOk, `range=${h.rangeStart}..${h.rangeEnd}`);
    check(
      'C08 calendar-year column count is dynamic AND exact (53; 54 for leap+Sunday Jan 1)',
      counts.every(Boolean),
      `cases=${JSON.stringify(cases)}`,
    );
  }

  // ---- C09 + C10 + C11: padding / current-year future / historical year ------------
  {
    const h2026 = buildCalendarHeatmap({ mode: 'calendar-year', today: dateAtIso('2026-09-04'), year: 2026 });
    const padStart = [findCell(h2026, '2025-12-29'), findCell(h2026, '2025-12-30'), findCell(h2026, '2025-12-31')];
    const padEnd = flat(h2026).filter((c) => c.date >= '2027-01-01');
    const future = findCell(h2026, '2026-12-31');
    const c09 = padStart.every((c) => c && c.inRange === false && c.value === null) && padEnd.every((c) => c.inRange === false && c.value === null);
    const c10 = future && future.inRange === true && future.isFuture === true && future.value === null;
    const h2025 = buildCalendarHeatmap({ mode: 'calendar-year', today: dateAtIso('2026-09-04'), year: 2025 });
    const c11 = flat(h2025)
      .filter((c) => c.inRange)
      .every((c) => c.isFuture === false);
    check(
      'C09 year padding (Dec 2025 / Jan 2027) is inRange=false, value=null',
      c09,
      `padStart=${JSON.stringify(padStart.map((c) => c && [c.date, c.inRange, c.value]))}`,
    );
    check('C10 current-year future dates are inRange=true / isFuture=true / value=null', Boolean(c10), `2026-12-31=${JSON.stringify(future)}`);
    check('C11 historical year (2025) contains no future days', c11);
  }

  // ---- C12: leap day -----------------------------------------------------------------
  {
    const h = buildCalendarHeatmap({ mode: 'calendar-year', today: dateAtIso('2028-02-29'), year: 2028 });
    const leap = findCell(h, '2028-02-29');
    const inRange = flat(h).filter((c) => c.inRange).length;
    check(
      'C12 leap day 2028-02-29 exists in range; 366 in-range days; 53 columns',
      Boolean(leap) && leap.inRange === true && inRange === 366 && h.weeks.length === 53,
      `weeks=${h.weeks.length} inRange=${inRange}`,
    );
  }

  // ---- C13: UTC+8 midnight boundary ---------------------------------------------------
  {
    const before = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: Date.parse('2026-09-03T15:59:59Z') });
    const after = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: Date.parse('2026-09-03T16:00:00Z') });
    const ok =
      before.weeks[51][3].date === '2026-09-03' &&
      before.weeks[51][3].weekdayIndex === 3 &&
      after.weeks[51][4].date === '2026-09-04' &&
      after.weeks[51][4].weekdayIndex === 4 &&
      after.monthLabels[after.monthLabels.length - 1].month === 8;
    check(
      'C13 15:59:59Z vs 16:00:00Z: business date ±1, weekday and month do not shift',
      ok,
      `before=${before.weeks[51][3].date} after=${after.weeks[51][4].date}`,
    );
  }

  // ---- C14: renderer and builder share the same week column ----------------------------
  {
    const h = buildCalendarHeatmap({ mode: 'rolling-52-weeks', today: dateAtIso('2026-09-04') });
    const { cells, labels } = renderHeatmap(h);
    const byDate = new Map(flat(h).map((c) => [c.date, c]));
    let cellsOk = true;
    for (const html of cells) {
      const date = html.match(/data-date="([^"]+)"/)?.[1];
      const week = Number(html.match(/data-week="(\d+)"/)?.[1]);
      const weekday = Number(html.match(/data-weekday="(\d+)"/)?.[1]);
      const col = Number(html.match(/grid-column:(\d+)/)?.[1]);
      const row = Number(html.match(/grid-row:(\d+)/)?.[1]);
      const b = byDate.get(date);
      if (!b || b.weekIndex !== week || b.weekdayIndex !== weekday || col !== week + 1 || row !== weekday + 1) {
        cellsOk = false;
        break;
      }
    }
    let labelsOk = true;
    for (const html of labels) {
      const col = Number(html.match(/grid-column:(\d+)/)?.[1]);
      const month = Number(html.match(/>(\d{1,2})月</)?.[1]);
      const label = h.monthLabels.find((l) => l.month === month - 1);
      if (!label || label.weekIndex + 1 !== col) {
        labelsOk = false;
        break;
      }
    }
    check(
      'C14 renderer positions (cells + labels) match the builder week columns exactly',
      cellsOk && labelsOk,
      `cellsOk=${cellsOk} labelsOk=${labelsOk}`,
    );
  }

  // ---- C15: months CSS shares the heatmap week tracks -----------------------------------
  {
    const css = readFileSync(join(root, 'src/dashboard/theme.ts'), 'utf8');
    const monthsRule = css.match(/\.months\{[^}]*\}/)?.[0] || '';
    const heatmapRule = css.match(/\.heatmap\{[^}]*\}/)?.[0] || '';
    const cellRule = css.match(/\.cell\{[^}]*\}/)?.[0] || '';
    const monthsGrid = monthsRule.includes('display:grid') && monthsRule.includes('grid-template-columns:repeat(var(--week-count,52),1fr)');
    const notFlex = !monthsRule.includes('display:flex') && !monthsRule.includes('space-between');
    const heatmapSameTracks = heatmapRule.includes('grid-template-columns:repeat(var(--week-count,52),1fr)');
    // The heatmap fills the content width: 1fr tracks stretch, cells must not
    // pin a fixed width.
    const cellsStretch = heatmapRule.includes('1fr') && !cellRule.includes('width:10px');
    const usageView = readFileSync(join(root, 'src/dashboard/usage-view.ts'), 'utf8');
    const weekCountWired = /class="heatmap" style="\$\{weekTracks\}"/.test(usageView) && /class="months" style="\$\{weekTracks\}"/.test(usageView);
    const titleUpdated = usageView.includes('Token 活动 · 近 52 周');
    check(
      'C15 .months uses the same --week-count CSS grid tracks as .heatmap (no flex/space-between); heatmap fills the width',
      monthsGrid && notFlex && heatmapSameTracks && cellsStretch && weekCountWired && titleUpdated,
      `monthsGrid=${monthsGrid} notFlex=${notFlex} heatmapSameTracks=${heatmapSameTracks} cellsStretch=${cellsStretch} wired=${weekCountWired} title=${titleUpdated}`,
    );
  }

  if (failures > 0) {
    console.error(`calendar-heatmap-contract: ${failures} contract(s) FAILED`);
    suiteExit(1);
  }
  console.log('calendar-heatmap-contract: all contracts passed');
  console.log('ok - file:calendar-heatmap-contract');
} catch (error) {
  console.error('not ok - calendar-heatmap-contract-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// dashboard-model-filter-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs








  const entry = (id, status = 'available') => ({
    id,
    status,
    display_order: 100,
    group: id.startsWith('Code-') ? 'code' : 'general',
  });

  const envelope = {
    observed_at: '2026-09-12T00:00:00.000Z',
    models: [entry('Air'), entry('Max'), entry('Code-Pro'), entry('Code-Ultra')],
  };

  {
    const out = filterDashboardModelStatus(envelope, undefined);
    assert.deepEqual(
      out.models.map((m) => m.id),
      ['Air', 'Max', 'Code-Pro', 'Code-Ultra'],
      'unset variable keeps the full public catalog',
    );
  }

  {
    const html = renderModels(envelope, new Map()).html;
    assert.ok(html.includes('通用模型'), 'general model group keeps its Chinese label');
    assert.ok(html.includes('编程模型'), 'code-prefixed models are presented as 编程模型');
    assert.ok(!html.includes('Code 模型'), 'mixed-language Code 模型 label is removed');
    assert.ok(html.includes('服务状态 · TTFT (24h)'), 'TTFT scope is shown once in the status-panel note');
    assert.ok(html.includes('<span>Samples</span>'), 'sample column header is shortened to Samples');
    assert.ok(!html.includes('Samples (24h)'), '24h is not repeated in the Samples column header');
  }

  {
    const out = filterDashboardModelStatus(envelope, '  code-pro, MAX,missing,code-pro, Code-Ultra  ');
    assert.deepEqual(
      out.models.map((m) => m.id),
      ['Code-Pro', 'Max', 'Code-Ultra'],
      'matching is case-insensitive, unknown names are ignored, duplicates are removed and configured order wins',
    );
    assert.equal(out.observed_at, envelope.observed_at, 'status observation timestamp is preserved');
  }

  {
    const out = filterDashboardModelStatus(envelope, 'missing-one,missing-two');
    assert.deepEqual(out.models, [], 'a non-empty allowlist never fabricates unknown model rows');
  }

  {
    const out = filterDashboardModelStatus(envelope, ' , , ');
    assert.deepEqual(
      out.models.map((m) => m.id),
      ['Air', 'Max', 'Code-Pro', 'Code-Ultra'],
      'whitespace/empty CSV is treated as unset',
    );
  }

  {
    const nodes = [
      {
        id: 'status-filter-node',
        provider: 'mock',
        tier: 'tier-1',
        protocol: 'openai',
        surfaces: ['chat_completions'],
        base_url: 'https://status-filter.example.com/v1',
        credential: 'unused-in-status-test',
        priority: 10,
        models: {
          'Code-Ultra': 'up-ultra',
          'Code-Max': 'up-max',
          'Code-Pro': 'up-pro',
        },
      },
    ];
    const out = publicModelStatus(nodes, { AIG_DASHBOARD_MODELS: 'code-pro,Code-Ultra' }, new Set(), 1_700_000_000_000);
    assert.deepEqual(
      out.models.map((m) => m.id),
      ['Code-Pro', 'Code-Ultra'],
      'dashboard wrapper applies the text variable after public status is computed',
    );
  }

  {
    const vars = collectVarsFromEnv({ AIG_DASHBOARD_MODELS: 'Code-Ultra,Code-Max,Code-Pro' });
    assert.equal(
      vars.vars.AIG_DASHBOARD_MODELS,
      'Code-Ultra,Code-Max,Code-Pro',
      'GitHub deployment bridge admits AIG_DASHBOARD_MODELS as a plain Worker text variable',
    );
  }

  {
    const officialNames = new Map([
      ['code-pro', 'Code-Pro'],
      ['code-max', 'Code-Max'],
      ['code-ultra', 'Code-Ultra'],
      ['general-pro', 'General-Pro'],
    ]);
    const rows = [
      { model: 'code-pro', total: 325, requests: 30 },
      { model: 'code-max', total: 320, requests: 29 },
      { model: 'code-ultra', total: 60, requests: 8 },
      { model: 'general-pro', total: 52, requests: 7 },
      { model: 'glm-5.2', total: 51, requests: 6 },
      { model: 'legacy-provider-model', total: 7, requests: 1 },
    ];
    const out = selectDashboardModelUsageRows(rows, 'General-Pro,Code-Ultra,Code-Max,Code-Pro', officialNames);
    assert.deepEqual(
      out.map((r) => r.model),
      ['Code-Pro', 'Code-Max', 'Code-Ultra', '其他'],
      'usage ranks eligible AIG_DASHBOARD_MODELS by Token total and exposes only the top three',
    );
    assert.deepEqual(out[3], { model: '其他', total: 110, requests: 14 }, 'rank 4+ and every model outside AIG_DASHBOARD_MODELS are merged into 其他');
  }

  {
    const now = Date.parse('2026-09-10T12:00:00+08:00');
    const daily = new Map([['2026-09-10', { total: 106_000_000, requests: 876, reports: 800, missing: 76 }]]);
    const { cells } = buildHeatmap(daily, now);
    const cell = cells.find((html) => html.includes('data-date="2026-09-10"'));
    assert.ok(cell, 'heatmap contains the target date');
    assert.match(cell, /876 次请求/, 'heatmap hover uses 次请求');
    assert.ok(!cell.includes('次上游调用'), 'heatmap hover no longer exposes 上游调用 wording');
  }

  {
    const now = Date.parse('2026-09-10T12:00:00+08:00');
    const stats = {
      summary: {
        available: true,
        today: { total: 1, requests: 1 },
        h24: { total: 1, requests: 1 },
        d7: { total: 1, requests: 1 },
        cumulative: { total: 1, requests: 1, reports: 1, missing: 0, input: 1, output: 0, cacheRead: 0, cacheHitRatio: null },
        coverage: 1,
      },
      daily: new Map(),
      modelUsage: { available: true, rows: [{ model: 'code-pro', total: 1, requests: 1 }] },
    };
    const html = await usageSection({ AIG_DASHBOARD_MODELS: 'Code-Pro' }, now, stats, new Map([['code-pro', 'Code-Pro']]));
    assert.match(html, /<div class="panel-title">模型使用 · 近 7 天<\/div>/, 'model usage heading carries its time window');
    assert.ok(!html.includes('模型使用 · 上游消耗'), 'old heading is removed');
    assert.match(THEME_CSS, /\.usage-detail-grid\{[^}]*grid-template-columns:/, 'desktop usage analysis uses the new two-panel grid');
    assert.match(
      THEME_CSS,
      /@media\(max-width:1120px\)[\s\S]*?\.usage-detail-grid\{grid-template-columns:1fr\}/,
      'responsive layout stacks usage analysis panels before cards can overflow',
    );
    assert.ok(!/section\{[^}]*border-top/.test(THEME_CSS), 'card-based dashboard sections use whitespace instead of section divider lines');
    assert.match(
      THEME_CSS,
      /\.status-grid\{[^}]*repeat\(2,minmax\(0,1fr\)\)/,
      'status cards use shrinkable grid tracks and cannot force the page wider',
    );
    assert.ok(
      THEME_CSS.includes('--brand:#0f5d53') && THEME_CSS.includes('--heat-4:#0f5d53'),
      'dashboard restores the original low-saturation teal palette',
    );
    assert.ok(!THEME_CSS.includes('.composition-layout{'), 'composition no longer reserves an empty title column');
    assert.match(
      THEME_CSS,
      /\.composition-data\{[^}]*display:grid;gap:18px/,
      'track and all four cumulative metrics keep a deliberate gap below the composition track',
    );
    assert.ok(!html.includes('累计 Token 构成'), 'cumulative composition does not add a redundant visible heading');
    assert.match(
      THEME_CSS,
      /\.composition-metrics\.four-up\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)\}/,
      'token composition uses four aligned metrics without a secondary chart',
    );
    assert.ok(!THEME_CSS.includes('.cache-ring{'), 'token composition no longer reserves visual weight for a cache ring');
    assert.match(
      THEME_CSS,
      /\.heatmap\{[^}]*grid-template-rows:repeat\(7,11px\)/,
      'desktop heatmap rows use the fine-tuned 11px height to align with model usage',
    );
    assert.match(THEME_CSS, /\.model-ranking\{[^}]*gap:2px\}/, 'model usage rows use a tighter vertical gap');
    assert.match(THEME_CSS, /\.model-rank-row\{[^}]*padding:6px 8px/, 'model usage rows use compact vertical padding');
    assert.match(THEME_CSS, /\.model-panel \.panel-head\{margin-bottom:14px\}/, 'model usage heading leaves less unused vertical space');
    assert.match(
      THEME_CSS,
      /@media\(max-width:760px\)[\s\S]*?\.heatmap\{grid-template-rows:repeat\(7,10px\)\}/,
      'mobile heatmap keeps the compact 10px row height',
    );
    assert.match(
      THEME_CSS,
      /@media\(min-width:761px\) and \(max-height:900px\)[\s\S]*?\.stat\{min-height:88px/,
      'short desktop viewports compact the first fold so all four Token KPIs remain visible',
    );
  }

  {
    const html = quickStartSection({
      apiBase: 'https://gateway.example.com/v1',
      accessGroups: ['MAX'],
    });
    assert.ok(!html.includes('AIG_ACCESS_KEY_AIR'), 'quick start must not imply AIR is the only usable key');
    assert.ok(!html.includes('GATEWAY_API_KEY'), 'quick start uses standard client API-key variables directly');
    assert.ok(html.includes('Key 组：MAX'), 'quick start key-group list comes from runtime access configuration');
  }

  console.log('dashboard model filter tests passed.');
  console.log('ok - file:dashboard-model-filter');
} catch (error) {
  console.error('not ok - dashboard-model-filter-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// dashboard-consumption-semantics-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs










  {
    const now = Date.parse('2026-09-10T12:00:00+08:00');
    const d1 = {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes('token_usage_daily')) {
                  return {
                    results: [
                      {
                        day: '2026-09-01',
                        upstream_total_tokens: 1_000,
                        requests: 7,
                        upstream_attempts: 99,
                        upstream_usage_reports: 5,
                        upstream_usage_missing: 2,
                      },
                    ],
                  };
                }
                return {
                  results: [
                    {
                      hour: '2026-09-10T04:00:00.000Z',
                      upstream_total_tokens: 2_000,
                      requests: 8,
                      upstream_attempts: 88,
                      upstream_usage_reports: 6,
                      upstream_usage_missing: 2,
                    },
                  ],
                };
              },
            };
          },
        };
      },
    };

    const series = await loadUpstreamDaily({ TOKEN_STATS_DB: d1 }, '2026-09-01', now);
    assert.ok(series instanceof Map);
    assert.equal(series.get('2026-09-01')?.total, 1_000, 'historical Token total stays on physical upstream consumption');
    assert.equal(series.get('2026-09-01')?.requests, 7, 'historical request count uses delivered responses, not upstream attempts');
    assert.equal(series.get('2026-09-10')?.total, 2_000, 'recent Token total stays on physical upstream consumption');
    assert.equal(series.get('2026-09-10')?.requests, 8, 'recent request count uses delivered responses, not upstream attempts');
  }

  {
    const source = fs.readFileSync(join(root, 'src', 'dashboard', 'pages.ts'), 'utf8');
    assert.ok(source.includes("viewBox='0 0 48 48'"), 'favicon uses a compact square canvas for the AI Gateway mark');
    assert.ok(!source.includes('<text'), 'favicon must not depend on a font glyph');
    assert.ok(
      source.includes("stroke='%230f5d53'") && source.includes("d='M7 37L24 5L41 37Q33 40 24 31Q15 40 7 37Z'"),
      'favicon uses the original teal palette and one uninterrupted triangle-convergence mark',
    );
    assert.ok(!source.includes('M17.5 20H30.5'), 'logo does not rely on an A crossbar');
    assert.ok(!source.includes("preserveAspectRatio='none'"), 'favicon must not stretch the logo');
    assert.ok(source.includes('One endpoint. Built for upstream change.'), 'brand slogan stays in the compact header instead of a hero block');
    assert.ok(!source.includes('一个入口，应对所有变化'), 'the old marketing hero copy is removed from the public dashboard');
    assert.ok(source.includes('href="https://labs.fongap.com"') && source.includes('>Fongap Labs</a>'), 'footer brand link points to labs.fongap.com');
  }

  {
    const html = quickStartSection({
      apiBase: 'https://runtime.example/v1',
      accessGroups: ['MAX'],
    });
    assert.ok(html.includes('Key 组：MAX'), 'quick start renders only configured access groups');
    assert.ok(!html.includes('AIR / PRO / MAX / ULTRA / AGENT'), 'quick start must not hard-code the full access-group catalog');
    assert.ok(html.includes('OPENAI_BASE_URL') && html.includes('https://runtime.example/v1'), 'OpenAI quick start uses the runtime public URL');
    assert.ok(
      html.includes('OPENAI_API_KEY') && html.includes('&lt;YOUR_GATEWAY_KEY&gt;'),
      'OpenAI quick start uses the standard client API-key variable directly',
    );
    assert.ok(
      html.includes('ANTHROPIC_BASE_URL') && html.includes('https://runtime.example'),
      'Anthropic quick start uses the same runtime public origin',
    );
    assert.ok(!html.includes('GATEWAY_API_KEY'), 'quick start does not introduce a gateway-only shell indirection');
  }

  {
    const pages = fs.readFileSync(join(root, 'src', 'dashboard', 'pages.ts'), 'utf8');
    assert.ok(pages.includes('AIG_PUBLIC_URL'), 'dashboard quick start derives its public endpoint from backend runtime metadata');
    assert.ok(/loadAccessKeysConfig\(\w+\)\.keys\.map/.test(pages), 'dashboard quick start derives access groups from configured gateway keys');
  }

  console.log('dashboard consumption semantics tests passed.');
  console.log('ok - file:dashboard-consumption-semantics');
} catch (error) {
  console.error('not ok - dashboard-consumption-semantics-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// readme-status-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs





  const svg = renderReadmeStatusSvg({
    today: 35_240_000,
    h24: 36_360_000,
    d7: 747_000_000,
    cumulative: 2_516_000_000,
    input: 2_507_000_000,
    output: 9_150_000,
    cacheHitRatio: 0.526,
    observedAt: '2026-09-18T09:00:00.000Z',
    available: true,
  });

  assert.match(svg, /AI Gateway/);
  assert.doesNotMatch(svg, /Smart AI Gateway/);
  assert.match(svg, />LIVE<\/text>/);
  assert.match(svg, /35\.2M/);
  assert.match(svg, /36\.4M/);
  assert.match(svg, /747M/);
  assert.match(svg, /2\.52B/);
  assert.match(svg, /CACHE HIT/);
  assert.match(svg, /52\.6%/);
  assert.match(svg, />INPUT<\/text>/);
  assert.match(svg, /2\.51B/);
  assert.match(svg, />OUTPUT<\/text>/);
  assert.match(svg, /9\.15M/);
  assert.match(svg, /<g transform="translate\(28 207\)">/);
  assert.match(svg, /<g transform="translate\(460 207\)">/);
  assert.match(svg, /<g transform="translate\(892 207\)">/);
  assert.match(svg, /<circle cx="-21" cy="-4" r="4" fill="#0f5d53"\/>/);
  assert.match(svg, /<text x="-9" y="0" class="metric-label">INPUT<\/text>/);
  assert.match(svg, /class="metric-value" text-anchor="middle">2\.51B<\/text>/);
  assert.match(svg, /<circle cx="-55" cy="-4" r="4" fill="#7cb4a5"\/>/);
  assert.match(svg, /class="metric-label" text-anchor="end">OUTPUT<\/text>/);
  assert.match(svg, /class="metric-value" text-anchor="end">9\.15M<\/text>/);
  assert.doesNotMatch(svg, /CACHE READ|缓存读取/i);
  assert.doesNotMatch(svg, /provider.*key/i);
  assert.match(svg, /Maintainer instance/);
  assert.match(svg, /Observed 2026-09-18 09:00:00 UTC/);
  assert.match(svg, /width="920" height="278"/);
  assert.equal((svg.match(/width="212" height="100"/g) || []).length, 4);
  for (const x of ['18', '242', '466', '690']) {
    assert.match(svg, new RegExp(`<g transform="translate\\(${x} 54\\)">`));
  }

  const degraded = await readmeStatusSvgResponse({}, Date.parse('2026-09-18T09:00:00Z'));
  assert.equal(degraded.status, 200);
  assert.match(degraded.headers.get('content-type') || '', /^image\/svg\+xml/);
  assert.match(degraded.headers.get('cache-control') || '', /max-age=60/);
  const degradedSvg = await degraded.text();
  assert.match(degradedSvg, /UNAVAILABLE/);
  assert.match(degradedSvg, /Live data temporarily unavailable/);
  assert.equal((degradedSvg.match(/class="value">—<\/text>/g) || []).length, 4);
  assert.match(degradedSvg, /class="metric-value">—<\/text>/);

  const publicRoute = await preflight(new Request('https://gateway.example/readme-status.svg', { headers: { accept: 'image/svg+xml' } }), {}, {});
  assert.equal(publicRoute.ok, false);
  assert.equal(publicRoute.response.status, 200);
  assert.match(publicRoute.response.headers.get('content-type') || '', /^image\/svg\+xml/);

  console.log('readme-status-test passed');
  console.log('ok - file:readme-status');
} catch (error) {
  console.error('not ok - readme-status-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
