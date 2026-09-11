import {
  getColumnValues,
  matchingRowIndices,
  type CsvData,
  type Delimiter,
  type ValueCount,
} from '../csv';
import type { HostMessage, WebviewMessage } from '../protocol';
import { isDelimiterOption, restoreViewState, sameHeaders, type ViewState } from '../viewState';

interface VsCodeApi {
  getState(): unknown;
  setState(state: ViewState): void;
  postMessage(message: WebviewMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface FilterDraft {
  column: number;
  allValues: ValueCount[];
  choices: ValueCount[];
  matchingChoices: ValueCount[];
  selected: Set<string>;
  limit: number;
}

const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 44;
const OVERSCAN = 12;
const VALUE_BATCH = 500;
const COLOR_COUNT = 8;
const numberFormat = new Intl.NumberFormat();
const collator = new Intl.Collator(undefined, { numeric: true });
const delimiterNames: Record<Delimiter, string> = {
  ',': 'Comma',
  ';': 'Semicolon',
  '\t': 'Tab',
  '|': 'Pipe',
};

function element<T extends HTMLElement>(id: string, constructor: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof constructor)) {
    throw new Error(`Missing table interface element: ${id}`);
  }
  return found;
}

const vscode = acquireVsCodeApi();
const saved = vscode.getState();
const restored = restoreViewState(saved);
if (saved !== undefined && saved !== null && restored === undefined) {
  console.warn('Ignored invalid or unsupported saved CSV table state.');
}
const state: ViewState = restored ?? {
  version: 1,
  options: { delimiter: 'auto', hasHeader: true },
  filters: {},
  headers: [],
  scrollTop: 0,
  scrollLeft: 0,
};

const fileName = element('file-name', HTMLHeadingElement);
const documentMeta = element('document-meta', HTMLParagraphElement);
const clearFiltersButton = element('clear-filters', HTMLButtonElement);
const openSourceButton = element('open-source', HTMLButtonElement);
const delimiterSelect = element('delimiter', HTMLSelectElement);
const hasHeaderInput = element('has-header', HTMLInputElement);
const recordCount = element('record-count', HTMLElement);
const filterSummary = element('filter-summary', HTMLSpanElement);
const notice = element('notice', HTMLDivElement);
const diagnostics = element('diagnostics', HTMLDetailsElement);
const diagnosticSummary = element('diagnostic-summary', HTMLElement);
const diagnosticList = element('diagnostic-list', HTMLUListElement);
const errorBanner = element('error-banner', HTMLDivElement);
const tableRegion = element('table-region', HTMLElement);
const emptyFile = element('empty-file', HTMLDivElement);
const scrollArea = element('table-scroll', HTMLDivElement);
const table = element('csv-table', HTMLTableElement);
const columnWidths = element('column-widths', HTMLTableColElement);
const tableHead = element('table-head', HTMLTableSectionElement);
const tableBody = element('table-body', HTMLTableSectionElement);
const dialog = element('filter-dialog', HTMLDialogElement);
const filterTitle = element('filter-title', HTMLHeadingElement);
const valueSearch = element('value-search', HTMLInputElement);
const selectAll = element('select-all-values', HTMLInputElement);
const selectAllLabel = element('select-all-label', HTMLSpanElement);
const filterValues = element('filter-values', HTMLDivElement);
const optionSummary = element('option-summary', HTMLSpanElement);
const showMoreButton = element('show-more-values', HTMLButtonElement);
const clearColumnButton = element('clear-column', HTMLButtonElement);
const cancelButton = element('cancel-filter', HTMLButtonElement);
const applyButton = element('apply-filter', HTMLButtonElement);

let data: CsvData | undefined;
let matching: number[] = [];
let draft: FilterDraft | undefined;
let lastStart = -1;
let lastEnd = -1;
let scrollFrame: number | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const filterButtons = new Map<number, HTMLButtonElement>();
const globalValues = new Map<number, ValueCount[]>();

function saveState(): void {
  vscode.setState(state);
}

function activeFilterCount(): number {
  return Object.values(state.filters).filter(values => values !== undefined).length;
}

function showNotice(message: string): void {
  notice.textContent = message;
  notice.hidden = false;
}

function syncOptions(): void {
  delimiterSelect.value = state.options.delimiter;
  hasHeaderInput.checked = state.options.hasHeader;
}

function columnClass(index: number): string {
  return `column-${index % COLOR_COUNT}`;
}

function renderHeader(): void {
  if (!data) {
    return;
  }
  filterButtons.clear();
  const columns = document.createDocumentFragment();
  const rowNumberColumn = document.createElement('col');
  rowNumberColumn.style.width = '64px';
  columns.append(rowNumberColumn);
  const headerRow = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'row-number corner';
  corner.scope = 'col';
  corner.textContent = '#';
  corner.title = 'Original record number, excluding the header';
  headerRow.append(corner);
  let width = 64;

  data.headers.forEach((header, index) => {
    const columnWidth = Math.min(300, Math.max(170, header.length * 8 + 52));
    width += columnWidth;
    const col = document.createElement('col');
    col.style.width = `${columnWidth}px`;
    columns.append(col);

    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.className = columnClass(index);
    const contents = document.createElement('div');
    contents.className = 'column-heading';
    const label = document.createElement('span');
    label.className = 'column-label';
    label.textContent = header;
    label.title = header;
    const button = document.createElement('button');
    const active = state.filters[index] !== undefined;
    button.type = 'button';
    button.className = `filter-button${active ? ' is-active' : ''}`;
    button.setAttribute('aria-label', `Filter ${header} (column ${index + 1})${active ? ', active' : ''}`);
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.title = active ? 'Filter is active. Click to change selected values.' : 'Filter this column';
    const icon = document.createElement('span');
    icon.className = 'filter-symbol';
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    button.addEventListener('click', () => openFilter(index));
    filterButtons.set(index, button);
    contents.append(label, button);
    cell.append(contents);
    headerRow.append(cell);
  });

  columnWidths.replaceChildren(columns);
  tableHead.replaceChildren(headerRow);
  table.style.width = `${width}px`;
  table.setAttribute('aria-colcount', String(data.headers.length + 1));
}

function spacer(height: number, columns: number): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.className = 'virtual-spacer';
  row.setAttribute('aria-hidden', 'true');
  const cell = document.createElement('td');
  cell.colSpan = columns;
  cell.style.height = `${height}px`;
  row.append(cell);
  return row;
}

function renderRows(force = false, requestedScrollTop = scrollArea.scrollTop): void {
  if (!data || data.headers.length === 0) {
    return;
  }
  const visibleCount = Math.ceil(scrollArea.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const start = Math.min(
    Math.max(0, matching.length - visibleCount),
    Math.max(0, Math.floor((requestedScrollTop - HEADER_HEIGHT) / ROW_HEIGHT) - OVERSCAN),
  );
  const end = Math.min(matching.length, start + visibleCount);
  if (!force && start === lastStart && end === lastEnd) {
    return;
  }
  lastStart = start;
  lastEnd = end;
  const fragment = document.createDocumentFragment();
  const columns = data.headers.length + 1;

  if (matching.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = columns;
    cell.className = 'empty-records';
    cell.textContent = data.rows.length === 0
      ? 'There are no data records. Turn off "First row is header" if this is a one-record file.'
      : 'No records match these filters. Clear a column filter or use Clear all filters.';
    row.append(cell);
    fragment.append(row);
  } else {
    if (start > 0) {
      fragment.append(spacer(start * ROW_HEIGHT, columns));
    }
    for (let position = start; position < end; position += 1) {
      const sourceIndex = matching[position];
      const values = sourceIndex === undefined ? undefined : data.rows[sourceIndex];
      if (sourceIndex === undefined || values === undefined) {
        throw new Error('The filtered row index is outside the CSV data.');
      }
      const row = document.createElement('tr');
      row.className = 'data-row';
      row.setAttribute('aria-rowindex', String(position + 2));
      const rowNumber = document.createElement('th');
      rowNumber.scope = 'row';
      rowNumber.className = 'row-number';
      rowNumber.textContent = numberFormat.format(sourceIndex + 1);
      rowNumber.title = `Original record ${sourceIndex + 1}`;
      row.append(rowNumber);
      data.headers.forEach((_, index) => {
        const cell = document.createElement('td');
        cell.className = columnClass(index);
        const text = document.createElement('span');
        const value = values[index] ?? '';
        text.className = 'cell-text';
        text.textContent = value;
        text.title = value;
        cell.append(text);
        row.append(cell);
      });
      fragment.append(row);
    }
    if (end < matching.length) {
      fragment.append(spacer((matching.length - end) * ROW_HEIGHT, columns));
    }
  }
  tableBody.replaceChildren(fragment);
}

function updateResults(resetScroll: boolean): void {
  if (!data) {
    return;
  }
  matching = matchingRowIndices(data.rows, state.filters);
  const active = activeFilterCount();
  recordCount.textContent = `${numberFormat.format(matching.length)} of ${numberFormat.format(data.rows.length)} records`;
  filterSummary.textContent = active === 0
    ? 'No filters applied'
    : `${active} column filter${active === 1 ? '' : 's'} active`;
  clearFiltersButton.disabled = active === 0;
  table.setAttribute('aria-rowcount', String(matching.length + 1));
  emptyFile.hidden = data.headers.length !== 0;
  scrollArea.hidden = data.headers.length === 0;
  renderHeader();

  const maximumScrollTop = Math.max(
    0, matching.length * ROW_HEIGHT + HEADER_HEIGHT - scrollArea.clientHeight,
  );
  const desiredTop = resetScroll ? 0 : Math.min(state.scrollTop, maximumScrollTop);
  renderRows(true, desiredTop);
  scrollArea.scrollTop = desiredTop;
  scrollArea.scrollLeft = state.scrollLeft;
  state.scrollTop = scrollArea.scrollTop;
  state.scrollLeft = scrollArea.scrollLeft;
  saveState();
}

function closeFilter(): void {
  draft = undefined;
  if (dialog.open) {
    dialog.close();
  }
  for (const button of filterButtons.values()) {
    button.setAttribute('aria-expanded', 'false');
  }
}

function receiveMessage(message: HostMessage): void {
  closeFilter();
  fileName.textContent = message.document.name;
  fileName.title = message.document.uri;
  state.options = { ...message.options };
  syncOptions();
  tableRegion.setAttribute('aria-busy', 'false');
  globalValues.clear();

  if (message.type === 'error') {
    data = undefined;
    matching = [];
    recordCount.textContent = 'Unable to read CSV';
    filterSummary.textContent = 'Fix the source or change the delimiter to try again.';
    documentMeta.textContent = 'Read-only table view';
    errorBanner.textContent = message.message;
    errorBanner.hidden = false;
    diagnostics.hidden = true;
    scrollArea.hidden = true;
    emptyFile.hidden = true;
    clearFiltersButton.disabled = true;
    return;
  }

  data = message.data;
  errorBanner.hidden = true;
  const schemaChanged = !sameHeaders(state.headers, data.headers);
  if (schemaChanged && activeFilterCount() > 0) {
    state.filters = {};
    showNotice('The column headers changed. Filters were cleared to avoid filtering the wrong columns.');
  }
  state.headers = [...data.headers];
  documentMeta.textContent = `${numberFormat.format(data.headers.length)} columns | ${delimiterNames[data.delimiter]} delimiter`;
  diagnostics.hidden = data.diagnostics.length === 0;
  diagnosticSummary.textContent = `CSV layout notes (${data.diagnostics.length})`;
  diagnosticList.replaceChildren(...data.diagnostics.map(diagnostic => {
    const item = document.createElement('li');
    item.textContent = `Line ${diagnostic.line}: ${diagnostic.message}`;
    return item;
  }));
  updateResults(schemaChanged);
}

function positionDialog(): void {
  if (!draft || !dialog.open) {
    return;
  }
  const button = filterButtons.get(draft.column);
  if (!button) {
    return;
  }
  const anchor = button.getBoundingClientRect();
  const box = dialog.getBoundingClientRect();
  const left = Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8));
  const below = anchor.bottom + 6;
  const top = below + box.height <= window.innerHeight - 8
    ? below
    : Math.max(8, window.innerHeight - box.height - 8);
  dialog.style.left = `${left}px`;
  dialog.style.top = `${top}px`;
}

function updateSelectionSummary(): void {
  if (!draft) {
    return;
  }
  const selectedMatches = draft.matchingChoices.filter(item => draft?.selected.has(item.value)).length;
  selectAll.checked = draft.matchingChoices.length > 0 && selectedMatches === draft.matchingChoices.length;
  selectAll.indeterminate = selectedMatches > 0 && selectedMatches < draft.matchingChoices.length;
  selectAll.disabled = draft.allValues.length === 0;
  selectAllLabel.textContent = valueSearch.value.length === 0 ? 'Select all values' : 'Select all search matches';
  const displayed = Math.min(draft.limit, draft.matchingChoices.length);
  optionSummary.textContent = `${numberFormat.format(draft.selected.size)} selected overall. `
    + `Showing ${numberFormat.format(displayed)} of ${numberFormat.format(draft.matchingChoices.length)} values.`;
  showMoreButton.hidden = displayed >= draft.matchingChoices.length;
  showMoreButton.textContent = `Show next ${Math.min(VALUE_BATCH, draft.matchingChoices.length - displayed)} values`;
}

function renderChoices(resetScroll = true): void {
  if (!draft) {
    return;
  }
  const previousTop = filterValues.scrollTop;
  const query = valueSearch.value.toLocaleLowerCase();
  draft.matchingChoices = draft.choices.filter(item => (
    item.value === '' ? '(Blanks)' : item.value
  ).toLocaleLowerCase().includes(query));
  const fragment = document.createDocumentFragment();

  for (const item of draft.matchingChoices.slice(0, draft.limit)) {
    const label = document.createElement('label');
    label.className = `value-option${item.count === 0 ? ' unavailable-value' : ''}`;
    label.title = item.value === '' ? 'Blank cell' : item.value;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = item.value;
    checkbox.checked = draft.selected.has(item.value);
    checkbox.setAttribute('aria-label', item.value === '' ? 'Blank cells'
      : item.value.trim() === '' ? `Whitespace value (${item.value.length} characters)` : item.value);
    checkbox.addEventListener('change', () => {
      if (!draft) {
        return;
      }
      if (checkbox.checked) {
        draft.selected.add(item.value);
      } else {
        draft.selected.delete(item.value);
      }
      updateSelectionSummary();
    });
    const text = document.createElement('span');
    text.className = `value-label${item.value === '' ? ' blank-value' : ''}`;
    text.textContent = item.value === '' ? '(Blanks)' : item.value.trim() === '' ? '(Whitespace)' : item.value;
    const count = document.createElement('span');
    count.className = 'value-count';
    count.textContent = numberFormat.format(item.count);
    count.title = `${item.count} matching records under the other column filters`;
    label.append(checkbox, text, count);
    fragment.append(label);
  }
  if (draft.matchingChoices.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'no-values';
    empty.textContent = query.length > 0
      ? 'No values match your search.'
      : 'No values are available under the other column filters.';
    fragment.append(empty);
  }
  filterValues.replaceChildren(fragment);
  filterValues.scrollTop = resetScroll ? 0 : previousTop;
  updateSelectionSummary();
  positionDialog();
}

function openFilter(column: number): void {
  if (!data) {
    return;
  }
  closeFilter();
  let allValues = globalValues.get(column);
  if (!allValues) {
    allValues = getColumnValues(data.rows, column);
    globalValues.set(column, allValues);
  }
  const filter = state.filters[column];
  const selected = new Set(filter ?? allValues.map(item => item.value));
  const choices = getColumnValues(data.rows, column, state.filters);
  const available = new Set(choices.map(item => item.value));
  if (filter !== undefined) {
    for (const value of selected) {
      if (!available.has(value)) {
        choices.push({ value, count: 0 });
      }
    }
    choices.sort((left, right) => left.value === '' ? (right.value === '' ? 0 : -1)
      : right.value === '' ? 1 : collator.compare(left.value, right.value));
  }
  draft = { column, allValues, choices, matchingChoices: [], selected, limit: VALUE_BATCH };
  filterTitle.textContent = `Filter: ${data.headers[column] ?? `Column ${column + 1}`}`;
  clearColumnButton.disabled = filter === undefined;
  valueSearch.value = '';
  renderChoices();
  dialog.showModal();
  filterButtons.get(column)?.setAttribute('aria-expanded', 'true');
  positionDialog();
  valueSearch.focus();
}

function applyColumnFilter(clear: boolean): void {
  if (!draft) {
    return;
  }
  const { column, selected, allValues } = draft;
  const everythingSelected = selected.size === allValues.length
    && allValues.every(item => selected.has(item.value));
  if (clear || everythingSelected) {
    delete state.filters[column];
  } else {
    state.filters[column] = [...selected];
  }
  closeFilter();
  notice.hidden = true;
  updateResults(true);
  filterButtons.get(column)?.focus();
}

function configure(): void {
  const delimiter = delimiterSelect.value;
  if (!isDelimiterOption(delimiter)) {
    throw new Error('The selected delimiter is not supported.');
  }
  closeFilter();
  state.options = { delimiter, hasHeader: hasHeaderInput.checked };
  if (activeFilterCount() > 0) {
    showNotice('Filters were cleared because the CSV layout options changed.');
  }
  state.filters = {};
  state.headers = [];
  state.scrollTop = 0;
  state.scrollLeft = 0;
  saveState();
  recordCount.textContent = 'Loading records...';
  tableRegion.setAttribute('aria-busy', 'true');
  vscode.postMessage({ type: 'configure', options: state.options });
}

clearFiltersButton.addEventListener('click', () => {
  state.filters = {};
  notice.hidden = true;
  updateResults(true);
});
openSourceButton.addEventListener('click', () => vscode.postMessage({ type: 'openSource' }));
delimiterSelect.addEventListener('change', configure);
hasHeaderInput.addEventListener('change', configure);
applyButton.addEventListener('click', () => applyColumnFilter(false));
clearColumnButton.addEventListener('click', () => applyColumnFilter(true));
cancelButton.addEventListener('click', closeFilter);
dialog.addEventListener('close', closeFilter);
dialog.addEventListener('click', event => {
  const box = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right
    || event.clientY < box.top || event.clientY > box.bottom)) {
    closeFilter();
  }
});
valueSearch.addEventListener('input', () => {
  if (draft) {
    draft.limit = VALUE_BATCH;
    renderChoices();
  }
});
selectAll.addEventListener('change', () => {
  if (!draft) {
    return;
  }
  if (valueSearch.value.length === 0) {
    draft.selected = selectAll.checked ? new Set(draft.allValues.map(item => item.value)) : new Set();
  } else {
    for (const item of draft.matchingChoices) {
      if (selectAll.checked) {
        draft.selected.add(item.value);
      } else {
        draft.selected.delete(item.value);
      }
    }
  }
  renderChoices(false);
});
showMoreButton.addEventListener('click', () => {
  if (draft) {
    draft.limit += VALUE_BATCH;
    renderChoices(false);
  }
});
scrollArea.addEventListener('scroll', () => {
  if (scrollFrame === undefined) {
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined;
      renderRows();
    });
  }
  state.scrollTop = scrollArea.scrollTop;
  state.scrollLeft = scrollArea.scrollLeft;
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    saveState();
  }, 150);
}, { passive: true });
new ResizeObserver(() => {
  renderRows(true);
  positionDialog();
}).observe(scrollArea);
window.addEventListener('resize', positionDialog);
window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  if (!event.data || (event.data.type !== 'data' && event.data.type !== 'error')) {
    console.warn('Ignored an unknown CSV host message.');
    return;
  }
  receiveMessage(event.data);
});
window.addEventListener('error', event => {
  console.error('CSV table interface error:', event.error ?? event.message);
  errorBanner.textContent = `The table could not be displayed: ${event.message}. Use Open source to access your file.`;
  errorBanner.hidden = false;
  scrollArea.hidden = true;
  tableRegion.setAttribute('aria-busy', 'false');
  recordCount.textContent = 'Unable to display records';
});

syncOptions();
vscode.postMessage(restored ? { type: 'ready', options: restored.options } : { type: 'ready' });
