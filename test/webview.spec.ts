import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { getColumnValues, matchingRowIndices, parseCsv, type ColumnFilters, type CsvOptions, type Delimiter } from '../src/csv';
import type { HostMessage, WebviewMessage } from '../src/protocol';
import type { ViewState } from '../src/viewState';
import { createWebviewHtml } from '../src/webviewHtml';

declare global {
  interface Window {
    __csvState: unknown;
    __csvMessages: WebviewMessage[];
    acquireVsCodeApi(): {
      getState(): unknown;
      setState(state: ViewState): void;
      postMessage(message: WebviewMessage): void;
    };
  }
}

const headers = ['Name', 'Department', 'City', 'Status', 'Notes'];
const records = [
  ['Alice', 'Engineering', 'Seattle', 'Active', 'APIs, tools'],
  ['Bob', 'Sales', 'Berlin', 'Active', 'Quoted "value"'],
  ['Carla', 'Engineering', 'Berlin', 'Active', 'First line\nSecond line'],
  ['Dan', 'Support', 'Berlin', 'Inactive', ''],
  ['Eve', 'Support', 'Tokyo', 'Active', ''],
  ['Finn', 'Sales', 'Seattle', 'Inactive', ''],
  ['Grace', 'Engineering', 'Seattle', 'Inactive', ''],
  ['Hugo', 'Support', '', 'Active', ''],
];

function csv(rows = records, delimiter: Delimiter = ',', names = headers): string {
  return [names, ...rows].map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(delimiter)).join('\r\n');
}

async function sendFile(
  page: Page,
  text: string,
  options: CsvOptions = { delimiter: 'auto', hasHeader: true },
  version = 1,
): Promise<void> {
  const document = { name: 'example.csv', uri: 'file:///example.csv', version };
  let message: HostMessage;
  try {
    message = { type: 'data', document, data: parseCsv(text, options), options };
  } catch (error: unknown) {
    message = { type: 'error', document, message: error instanceof Error ? error.message : String(error), options };
  }
  await page.evaluate(payload => window.postMessage(payload, '*'), message);
  await expect(page.locator('#table-region')).toHaveAttribute('aria-busy', 'false');
}

async function mount(page: Page, text = csv(), saved: ViewState | null = null): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const [script, style] = await Promise.all([
    readFile(resolve('dist', 'webview.js'), 'utf8'),
    readFile(resolve('media', 'webview.css'), 'utf8'),
  ]);
  const html = createWebviewHtml({
    scriptUri: 'https://csv.test/webview.js',
    styleUri: 'https://csv.test/webview.css',
    cspSource: "'self'",
    nonce: 'csv-test-nonce',
  });
  await page.route('https://csv.test/**', async route => {
    switch (new URL(route.request().url()).pathname) {
      case '/':
        await route.fulfill({ contentType: 'text/html', body: html });
        break;
      case '/webview.js':
        await route.fulfill({ contentType: 'text/javascript', body: script });
        break;
      case '/webview.css':
        await route.fulfill({ contentType: 'text/css', body: style });
        break;
      default:
        await route.abort();
    }
  });
  await page.addInitScript(initialState => {
    window.__csvState = initialState;
    window.__csvMessages = [];
    window.acquireVsCodeApi = () => ({
      getState: () => window.__csvState,
      setState: state => { window.__csvState = structuredClone(state); },
      postMessage: message => { window.__csvMessages.push(structuredClone(message)); },
    });
  }, saved);
  await page.goto('https://csv.test/');
  await expect.poll(() => page.evaluate(() => window.__csvMessages.some(message => message.type === 'ready'))).toBe(true);
  await expect(page).toHaveTitle('CSVScope');
  await expect(page.locator('#file-name')).toHaveText('CSVScope');
  await sendFile(page, text, saved?.options);
  expect(errors).toEqual([]);
}

async function selectOnly(page: Page, column: number, values: string[]): Promise<void> {
  await page.locator('#table-head .filter-button').nth(column).click();
  await page.locator('#select-all-values').uncheck();
  for (const value of values) {
    const name = value === '' ? 'Blank cells'
      : value.trim() === '' ? `Whitespace value (${value.length} characters)` : value;
    await page.getByRole('checkbox', { name, exact: true }).check();
  }
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
}

test('shows the total, original record numbers, colored columns, and literal CSV cell contents', async ({ page }) => {
  await mount(page);
  await expect(page.locator('#record-count')).toHaveText('8 of 8 records');
  await expect(page.locator('.data-row')).toHaveCount(8);
  await expect(page.locator('.data-row').nth(1).locator('.cell-text').nth(4)).toHaveText('Quoted "value"');
  await expect(page.locator('.data-row').nth(2).locator('.cell-text').nth(4)).toHaveText('First line\nSecond line');
  const colors = await page.locator('.data-row').first().locator('td').evaluateAll(cells => (
    cells.map(cell => getComputedStyle(cell).backgroundColor)
  ));
  expect(new Set(colors).size).toBe(headers.length);
  await expect(page.locator('.data-row').first().locator('th')).toHaveText('1');
  await page.getByRole('button', { name: 'Open source', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__csvMessages.at(-1)?.type)).toBe('openSource');
});

test('combines multiple values with OR and multiple column filters with AND', async ({ page }) => {
  await mount(page);
  await selectOnly(page, 1, ['Engineering', 'Support']);
  await expect(page.locator('#record-count')).toHaveText('6 of 8 records');
  await page.locator('#table-head .filter-button').nth(2).click();
  await expect(page.locator('.value-option').filter({ has: page.getByRole('checkbox', { name: 'Berlin', exact: true }) }).locator('.value-count')).toHaveText('2');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await selectOnly(page, 2, ['Berlin']);
  await expect(page.locator('#record-count')).toHaveText('2 of 8 records');
  await expect(page.locator('#filter-summary')).toHaveText('2 column filters active');
  await expect(page.locator('.data-row .row-number')).toHaveText(['3', '4']);
  await selectOnly(page, 3, ['Active']);
  await expect(page.locator('#record-count')).toHaveText('1 of 8 records');
  await expect(page.locator('.data-row td').first()).toHaveText('Carla');
  await expect(page.locator('.filter-button.is-active')).toHaveCount(3);
  await page.getByRole('button', { name: 'Clear all filters', exact: true }).click();
  await expect(page.locator('#record-count')).toHaveText('8 of 8 records');
});

test('search bulk selection preserves values outside the search; cancel and Escape discard drafts', async ({ page }) => {
  await mount(page);
  await page.locator('#table-head .filter-button').nth(2).click();
  await page.getByRole('searchbox', { name: 'Search filter values' }).fill('sea');
  await page.locator('#select-all-values').uncheck();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#record-count')).toHaveText('8 of 8 records');
  await page.locator('#table-head .filter-button').nth(2).click();
  await page.getByRole('searchbox', { name: 'Search filter values' }).fill('sea');
  await page.locator('#select-all-values').uncheck();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('#record-count')).toHaveText('5 of 8 records');
  await page.locator('#table-head .filter-button').nth(2).click();
  await page.locator('#select-all-values').uncheck();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('#record-count')).toHaveText('5 of 8 records');
  await expect(page.locator('#table-head .filter-button').nth(2)).toBeFocused();
  await page.locator('#table-head .filter-button').nth(2).click();
  await page.getByRole('button', { name: 'Clear column filter', exact: true }).click();
  await expect(page.locator('#record-count')).toHaveText('8 of 8 records');
});

test('empty selections match nothing, blanks remain selectable, and filters are recoverable', async ({ page }) => {
  await mount(page);
  await selectOnly(page, 0, []);
  await expect(page.locator('#record-count')).toHaveText('0 of 8 records');
  await expect(page.locator('.empty-records')).toContainText('No records match');
  await page.getByRole('button', { name: 'Clear all filters', exact: true }).click();
  await selectOnly(page, 2, ['']);
  await expect(page.locator('#record-count')).toHaveText('1 of 8 records');
  await expect(page.locator('.data-row td').first()).toHaveText('Hugo');
});

test('pins the header and row numbers while virtualizing the whole scrollable dataset', async ({ page }) => {
  const rows = Array.from({ length: 20_000 }, (_, index) => [
    `Record ${index + 1}`, `Team ${index % 4}`, 'City', 'Active', 'A long value'.repeat(8), 'Extra', 'Extra',
  ]);
  await mount(page, csv(rows, ',', [...headers, 'More', 'Last']));
  await expect(page.locator('#record-count')).toHaveText('20,000 of 20,000 records');
  const header = page.locator('#table-head th').nth(1);
  const before = await header.boundingBox();
  expect(before).not.toBeNull();
  await expect.poll(() => page.locator('.data-row').count()).toBeLessThan(100);
  await page.locator('#table-scroll').evaluate(area => {
    area.scrollTop = 500_000;
    area.scrollLeft = 350;
  });
  await expect.poll(() => page.locator('.data-row').first().locator('td').first().textContent()).not.toBe('Record 1');
  const after = await header.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(after?.height).toBe(44);
  const rowBox = await page.locator('.data-row').first().boundingBox();
  expect(rowBox?.height).toBe(32);
  const gutter = await page.locator('.data-row .row-number').first().boundingBox();
  const scrollBox = await page.locator('#table-scroll').boundingBox();
  expect(Math.abs((gutter?.x ?? 0) - (scrollBox?.x ?? 0) - 1)).toBeLessThanOrEqual(1);
  await page.locator('#table-scroll').evaluate(area => { area.scrollTop = area.scrollHeight; });
  await expect(page.locator('.data-row').last().locator('td').first()).toHaveText('Record 20000');
  await expect(page.locator('.data-row').last().locator('.row-number')).toHaveText('20,000');
  await expect.poll(() => page.locator('.data-row').count()).toBeLessThan(100);
});

test('source changes preserve selections, including values temporarily absent from the file', async ({ page }) => {
  await mount(page);
  await selectOnly(page, 1, ['Engineering']);
  await sendFile(page, csv([...records, ['Iris', 'Engineering', 'Tokyo', 'Active', 'New']]), undefined, 2);
  await expect(page.locator('#record-count')).toHaveText('4 of 9 records');
  await sendFile(page, csv([['Only', 'Sales', 'Berlin', 'Active', '']]), undefined, 3);
  await expect(page.locator('#record-count')).toHaveText('0 of 1 records');
  await page.locator('#table-head .filter-button').nth(1).click();
  await expect(page.getByRole('checkbox', { name: 'Engineering', exact: true })).toBeChecked();
  await expect(page.locator('.unavailable-value .value-count')).toHaveText('0');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await sendFile(page, csv(), undefined, 4);
  await expect(page.locator('#record-count')).toHaveText('3 of 8 records');
  await sendFile(page, csv(records, ',', ['Name', 'Team', 'City', 'Status', 'Notes']), undefined, 5);
  await expect(page.locator('#record-count')).toHaveText('8 of 8 records');
  await expect(page.locator('#notice')).toContainText('column headers changed');
  await expect(page.locator('.filter-button.is-active')).toHaveCount(0);
});

test('restores per-editor filter and delimiter settings after webview recreation', async ({ page }) => {
  const saved: ViewState = {
    version: 1,
    options: { delimiter: ';', hasHeader: true },
    headers,
    filters: { 1: ['Engineering'], 2: ['Berlin'] },
    scrollTop: 0,
    scrollLeft: 0,
  };
  await mount(page, csv(records, ';'), saved);
  await expect(page.locator('#record-count')).toHaveText('1 of 8 records');
  await expect(page.locator('#delimiter')).toHaveValue(';');
  await expect(page.locator('.data-row td').first()).toHaveText('Carla');
  const ready = await page.evaluate(() => window.__csvMessages.find(message => message.type === 'ready'));
  expect(ready).toEqual({ type: 'ready', options: saved.options });
  expect(await page.evaluate(() => window.__csvState)).toMatchObject({ filters: saved.filters });
});

test('reports parse failures rather than stale counts, then recovers on a source edit', async ({ page }) => {
  await mount(page);
  await sendFile(page, 'Name,Team\n"Unclosed,Engineering', undefined, 2);
  await expect(page.locator('#error-banner')).toBeVisible();
  await expect(page.locator('#record-count')).toHaveText('Unable to read CSV');
  await expect(page.locator('#table-scroll')).not.toBeVisible();
  await sendFile(page, csv(), undefined, 3);
  await expect(page.locator('#error-banner')).not.toBeVisible();
  await expect(page.locator('#record-count')).toHaveText('8 of 8 records');
  await sendFile(page, '', undefined, 4);
  await expect(page.locator('#empty-file')).toBeVisible();
  await expect(page.locator('#record-count')).toHaveText('0 of 0 records');
});

test('header and delimiter overrides request reparsing without modifying the source', async ({ page }) => {
  await mount(page);
  await selectOnly(page, 1, ['Engineering']);
  await page.getByRole('checkbox', { name: 'First row is header', exact: true }).uncheck();
  await expect.poll(() => page.evaluate(() => window.__csvMessages.at(-1))).toEqual({
    type: 'configure',
    options: { delimiter: 'auto', hasHeader: false },
  });
  await sendFile(page, csv(), { delimiter: 'auto', hasHeader: false });
  await expect(page.locator('#record-count')).toHaveText('9 of 9 records');
  await expect(page.locator('.column-label').first()).toHaveText('Column 1');
  await expect(page.locator('.data-row td').first()).toHaveText('Name');
  await page.locator('#delimiter').selectOption(';');
  await expect.poll(() => page.evaluate(() => window.__csvMessages.at(-1))).toEqual({
    type: 'configure',
    options: { delimiter: ';', hasHeader: false },
  });
  await sendFile(page, csv(records, ';'), { delimiter: ';', hasHeader: false });
  await expect(page.locator('#record-count')).toHaveText('9 of 9 records');
});

test('large option lists support incremental loading and searching every value', async ({ page }) => {
  const rows = Array.from({ length: 800 }, (_, index) => [`Value ${String(index + 1).padStart(4, '0')}`]);
  await mount(page, csv(rows, ',', ['Value']));
  await page.locator('#table-head .filter-button').first().click();
  await expect(page.locator('.value-option')).toHaveCount(500);
  await page.getByRole('button', { name: 'Show next 300 values', exact: true }).click();
  await expect(page.locator('.value-option')).toHaveCount(800);
  await page.locator('#select-all-values').uncheck();
  await page.getByRole('searchbox', { name: 'Search filter values' }).fill('0750');
  await expect(page.locator('.value-option')).toHaveCount(1);
  await page.getByRole('checkbox', { name: 'Value 0750', exact: true }).check();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('#record-count')).toHaveText('1 of 800 records');
  await expect(page.locator('.data-row td').first()).toHaveText('Value 0750');
});

test('treats markup-like values and headers as text, including in filter menus', async ({ page }) => {
  const value = '<img src=x onerror="window.__injected = true">';
  await mount(page, csv([[value, '__proto__']], ',', ['<b>Name</b>', 'Value']));
  await expect(page.locator('.column-label').first()).toHaveText('<b>Name</b>');
  await expect(page.locator('.data-row td').first()).toHaveText(value);
  await page.locator('#table-head .filter-button').first().click();
  await expect(page.locator('.value-label')).toHaveText(value);
  await expect(page.locator('img, b')).toHaveCount(0);
  expect(await page.evaluate(() => '__injected' in window)).toBe(false);
});

test('keeps distinct column backgrounds in light and high-contrast themes', async ({ page }) => {
  await mount(page);
  for (const theme of ['vscode-light', 'vscode-high-contrast-light']) {
    await page.evaluate(className => {
      document.body.className = className;
      document.documentElement.style.setProperty('--vscode-editor-background', '#ffffff');
      document.documentElement.style.setProperty('--vscode-editor-foreground', '#222222');
      document.documentElement.style.setProperty('--vscode-panel-border', '#dddddd');
      document.documentElement.style.setProperty('--vscode-contrastBorder', '#000000');
    }, theme);
    const colors = await page.locator('.data-row').first().locator('td').evaluateAll(cells => (
      cells.map(cell => getComputedStyle(cell).backgroundColor)
    ));
    expect(new Set(colors).size).toBe(headers.length);
    await expect(page.locator('#record-count')).toHaveText('8 of 8 records');
  }
});

test.describe('optional local-file validation', () => {
  test('browses and filters a supplied CSV without changing its contents', async ({ page }) => {
    const path = process.env.CSV_VALIDATION_FILE;
    test.skip(!path, 'Set CSV_VALIDATION_FILE to validate a local dataset.');
    if (!path) {
      return;
    }
    test.setTimeout(60_000);
    const source = await readFile(path, 'utf8');
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const parsed = parseCsv(source, { delimiter: 'auto', hasHeader: true });
    expect(parsed.diagnostics).toHaveLength(0);
    expect(parsed.rows.length).toBeGreaterThan(100);
    const candidates = parsed.headers.map((_, column) => ({
      column,
      values: getColumnValues(parsed.rows, column),
    }));
    const first = candidates.find(candidate => candidate.values.length >= 3 && candidate.values.length <= 100);
    if (!first) {
      throw new Error('Local-file validation requires a column with 3 to 100 distinct values.');
    }
    const selectedValues = [...first.values].sort((left, right) => right.count - left.count)
      .slice(0, 2).map(item => item.value);
    const firstFilter: ColumnFilters = { [first.column]: selectedValues };
    const firstExpected = parsed.rows.reduce<number[]>((indices, row, index) => {
      if (selectedValues.includes(row[first.column] ?? '')) {
        indices.push(index);
      }
      return indices;
    }, []);
    const second = candidates.filter(candidate => candidate.column !== first.column
      && candidate.values.length >= 2 && candidate.values.length <= 100)
      .map(candidate => ({
        column: candidate.column,
        values: getColumnValues(parsed.rows, candidate.column, firstFilter),
      }))
      .find(candidate => candidate.values.length >= 2);
    const secondValue = second
      ? [...second.values].sort((left, right) => right.count - left.count)[0]?.value
      : undefined;
    if (!second || secondValue === undefined) {
      throw new Error('Local-file validation requires another column that narrows the first filter.');
    }
    const combined: ColumnFilters = { ...firstFilter, [second.column]: [secondValue] };
    const combinedExpected = firstExpected.filter(index => parsed.rows[index]?.[second.column] === secondValue);
    expect(firstExpected.length).toBeGreaterThan(0);
    expect(firstExpected.length).toBeLessThan(parsed.rows.length);
    expect(combinedExpected.length).toBeGreaterThan(0);
    expect(combinedExpected.length).toBeLessThan(firstExpected.length);
    expect(matchingRowIndices(parsed.rows, combined)).toEqual(combinedExpected);

    await mount(page, source);
    const count = (matches: number): string => `${matches.toLocaleString('en-US')} of ${parsed.rows.length.toLocaleString('en-US')} records`;
    await expect(page.locator('#record-count')).toHaveText(count(parsed.rows.length));
    await expect(page.locator('#table-head .column-label')).toHaveCount(parsed.headers.length);
    const header = page.locator('#table-head th').nth(1);
    const beforeScroll = await header.boundingBox();
    await page.locator('#table-scroll').evaluate(area => {
      area.scrollTop = area.scrollHeight;
      area.scrollLeft = Math.min(1000, area.scrollWidth - area.clientWidth);
    });
    await expect(page.locator('.data-row').last().locator('.row-number')).toHaveText(parsed.rows.length.toLocaleString('en-US'));
    const afterScroll = await header.boundingBox();
    expect(beforeScroll).not.toBeNull();
    expect(afterScroll).not.toBeNull();
    expect(Math.abs((afterScroll?.y ?? 0) - (beforeScroll?.y ?? 0))).toBeLessThanOrEqual(1);
    expect(await page.locator('.data-row').count()).toBeLessThan(100);
    await selectOnly(page, first.column, selectedValues);
    await expect(page.locator('#record-count')).toHaveText(count(firstExpected.length));
    await selectOnly(page, second.column, [secondValue]);
    await expect(page.locator('#record-count')).toHaveText(count(combinedExpected.length));
    await expect(page.locator('#filter-summary')).toHaveText('2 column filters active');
    const visibleRecords = await page.locator('.data-row .row-number').allTextContents();
    const expectedVisible = combinedExpected.slice(0, visibleRecords.length).map(index => (index + 1).toLocaleString('en-US'));
    expect(visibleRecords).toEqual(expectedVisible);
    await page.getByRole('button', { name: 'Clear all filters', exact: true }).click();
    await expect(page.locator('#record-count')).toHaveText(count(parsed.rows.length));
    expect(createHash('sha256').update(await readFile(path, 'utf8')).digest('hex')).toBe(sourceHash);
    console.log(`Local dataset: ${parsed.rows.length} records, ${parsed.headers.length} columns; `
      + `two selected values match ${firstExpected.length}, combined column filters match ${combinedExpected.length}.`);
  });
});
