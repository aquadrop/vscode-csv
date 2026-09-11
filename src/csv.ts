export type Delimiter = ',' | ';' | '\t' | '|';
export type DelimiterOption = 'auto' | Delimiter;

export interface CsvOptions {
  delimiter: DelimiterOption;
  hasHeader: boolean;
}

export interface CsvDiagnostic {
  line: number;
  message: string;
}

export interface CsvData {
  headers: string[];
  rows: string[][];
  delimiter: Delimiter;
  lineEnding: '\r\n' | '\n' | '\r';
  diagnostics: CsvDiagnostic[];
}

export type ColumnFilters = Partial<Record<number, readonly string[]>>;

export interface ValueCount {
  value: string;
  count: number;
}

export class CsvParseError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(`${message} (line ${line}, column ${column}).`);
    this.name = 'CsvParseError';
    this.line = line;
    this.column = column;
  }
}

type FieldState = 'start' | 'unquoted' | 'quoted' | 'closed';

interface RawRecord {
  values: string[];
  line: number;
}

interface DelimiterSample {
  delimiter: Delimiter;
  frequencies: Map<number, number>;
  currentCount: number;
  modeCount: number;
  modeFrequency: number;
  separatedRecords: number;
  totalSeparators: number;
  decimalSeparators: number;
  state: Exclude<FieldState, 'quoted'>;
  validQuotes: boolean;
}

const delimiters: readonly Delimiter[] = [',', ';', '\t', '|'];
const diagnosticLimit = 50;
const valueCollator = new Intl.Collator(undefined, { numeric: true });

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function compareSamples(left: DelimiterSample, right: DelimiterSample): number {
  const leftDecimal = left.delimiter === ',' && left.decimalSeparators === left.totalSeparators;
  const rightDecimal = right.delimiter === ',' && right.decimalSeparators === right.totalSeparators;

  return left.modeFrequency - right.modeFrequency
    || left.separatedRecords - right.separatedRecords
    || Number(left.validQuotes) - Number(right.validQuotes)
    // Equally consistent separators surrounding decimal commas favor the other delimiter.
    || Number(rightDecimal) - Number(leftDecimal)
    || left.modeCount - right.modeCount;
}

function detectDelimiter(text: string): Delimiter {
  const samples: DelimiterSample[] = delimiters.map((delimiter) => ({
    delimiter,
    frequencies: new Map<number, number>(),
    currentCount: 0,
    modeCount: 0,
    modeFrequency: 0,
    separatedRecords: 0,
    totalSeparators: 0,
    decimalSeparators: 0,
    state: 'start',
    validQuotes: true,
  }));
  let quoted = false;

  const finishRecord = (): void => {
    for (const sample of samples) {
      if (sample.currentCount > 0) {
        sample.separatedRecords++;
        const frequency = (sample.frequencies.get(sample.currentCount) ?? 0) + 1;
        sample.frequencies.set(sample.currentCount, frequency);
        if (frequency > sample.modeFrequency
          || (frequency === sample.modeFrequency && sample.currentCount > sample.modeCount)) {
          sample.modeFrequency = frequency;
          sample.modeCount = sample.currentCount;
        }
      }
      sample.currentCount = 0;
      sample.state = 'start';
    }
  };

  for (let index = 0; index < text.length; index++) {
    const character = text.charAt(index);
    if (character === '"') {
      if (quoted && text.charAt(index + 1) === '"') {
        index++;
        continue;
      }
      if (quoted) {
        for (const sample of samples) {
          sample.state = 'closed';
        }
      } else {
        for (const sample of samples) {
          if (sample.state !== 'start') {
            sample.validQuotes = false;
          }
        }
      }
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }
    if (character === '\r' || character === '\n') {
      finishRecord();
      if (character === '\r' && text.charAt(index + 1) === '\n') {
        index++;
      }
      continue;
    }
    for (const sample of samples) {
      if (character === sample.delimiter) {
        sample.currentCount++;
        sample.totalSeparators++;
        sample.state = 'start';
        if (character === ',' && isDigit(text.charCodeAt(index - 1))
          && isDigit(text.charCodeAt(index + 1))) {
          sample.decimalSeparators++;
        }
      } else if (sample.state === 'closed') {
        if (character !== ' ' && character !== '\t') {
          sample.validQuotes = false;
        }
      } else {
        sample.state = 'unquoted';
      }
    }
  }
  finishRecord();

  let best: DelimiterSample | undefined;
  for (const sample of samples) {
    if (sample.totalSeparators > 0 && (!best || compareSamples(sample, best) > 0)) {
      best = sample;
    }
  }
  return best?.delimiter ?? ',';
}

function readRecords(text: string, delimiter: Delimiter): {
  records: RawRecord[];
  width: number;
  lineEnding: CsvData['lineEnding'];
} {
  const records: RawRecord[] = [];
  let fields: string[] = [];
  let state: FieldState = 'start';
  let fieldStart = 0;
  let parts: string[] | undefined;
  let quotedValue = '';
  let index = 0;
  let line = 1;
  let column = 1;
  let quoteLine = 1;
  let quoteColumn = 1;
  let recordStart = 0;
  let recordLine = 1;
  let width = 0;
  let lineEnding: CsvData['lineEnding'] | undefined;

  const finishField = (end: number): void => {
    fields.push(state === 'closed' ? quotedValue : text.slice(fieldStart, end));
    state = 'start';
    parts = undefined;
    quotedValue = '';
  };

  const finishRecord = (): void => {
    records.push({ values: fields, line: recordLine });
    width = Math.max(width, fields.length);
    fields = [];
  };

  while (index < text.length) {
    const character = text.charAt(index);
    if (state === 'quoted') {
      if (character === '"') {
        if (text.charAt(index + 1) === '"') {
          parts ??= [];
          parts.push(text.slice(fieldStart, index), '"');
          index += 2;
          column += 2;
          fieldStart = index;
          continue;
        }
        const lastPart = text.slice(fieldStart, index);
        if (parts) {
          parts.push(lastPart);
          quotedValue = parts.join('');
        } else {
          quotedValue = lastPart;
        }
        state = 'closed';
      } else if (character === '\r' || character === '\n') {
        index += character === '\r' && text.charAt(index + 1) === '\n' ? 2 : 1;
        line++;
        column = 1;
        continue;
      }
      index++;
      column++;
      continue;
    }

    if (character === delimiter) {
      finishField(index);
      index++;
      column++;
      fieldStart = index;
      continue;
    }
    if (character === '\r' || character === '\n') {
      const ending = character === '\r' && text.charAt(index + 1) === '\n'
        ? '\r\n' : character;
      lineEnding ??= ending;
      finishField(index);
      finishRecord();
      index += ending.length;
      line++;
      column = 1;
      recordStart = index;
      recordLine = line;
      fieldStart = index;
      continue;
    }
    if (state === 'closed') {
      // Spaces/tabs outside a closing quote are tolerated, not included in the cell.
      if (character !== ' ' && character !== '\t') {
        throw new CsvParseError('Unexpected character after closing quote', line, column);
      }
    } else if (character === '"') {
      if (state !== 'start') {
        throw new CsvParseError('Unexpected quote in unquoted field', line, column);
      }
      state = 'quoted';
      quoteLine = line;
      quoteColumn = column;
      fieldStart = index + 1;
    } else {
      state = 'unquoted';
    }
    index++;
    column++;
  }

  if (state === 'quoted') {
    throw new CsvParseError('Unterminated quoted field', quoteLine, quoteColumn);
  }
  if (recordStart < text.length) {
    finishField(text.length);
    finishRecord();
  }
  return { records, width, lineEnding: lineEnding ?? '\n' };
}

export function parseCsv(text: string, options: Partial<CsvOptions> = {}): CsvData {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const delimiterOption = options.delimiter ?? ',';
  const delimiter = delimiterOption === 'auto' ? detectDelimiter(source) : delimiterOption;
  const hasHeader = options.hasHeader ?? true;
  const { records, width, lineEnding } = readRecords(source, delimiter);
  const header = hasHeader ? records[0]?.values : undefined;
  const headers = Array.from({ length: width }, (_, column) => (
    header?.[column]?.trim() || `Column ${column + 1}`
  ));
  const rows: string[][] = [];
  const diagnostics: CsvDiagnostic[] = [];
  let omittedDiagnostics = 0;
  let firstOmittedLine = 0;

  for (const [index, record] of records.entries()) {
    if (record.values.length < width) {
      if (diagnostics.length < diagnosticLimit) {
        diagnostics.push({
          line: record.line,
          message: `Record has ${record.values.length} fields; table has ${width} columns.`,
        });
      } else {
        if (omittedDiagnostics === 0) {
          firstOmittedLine = record.line;
        }
        omittedDiagnostics++;
      }
    }
    if (!hasHeader || index > 0) {
      while (record.values.length < width) {
        record.values.push('');
      }
      rows.push(record.values);
    }
  }
  if (omittedDiagnostics > 0) {
    diagnostics.push({
      line: firstOmittedLine,
      message: `Omitted diagnostics for ${omittedDiagnostics} additional ragged records.`,
    });
  }
  return { headers, rows, delimiter, lineEnding, diagnostics };
}

interface CompiledFilter {
  column: number;
  values: ReadonlySet<string>;
}

function compileFilters(filters: ColumnFilters, excludedColumn?: number): CompiledFilter[] {
  const compiled: CompiledFilter[] = [];
  for (const key of Object.keys(filters)) {
    const column = Number(key);
    if (!Number.isInteger(column) || column < 0 || column === excludedColumn) {
      continue;
    }
    const values = filters[column];
    if (values !== undefined) {
      compiled.push({ column, values: new Set(values) });
    }
  }
  return compiled;
}

function rowMatches(row: readonly string[], filters: readonly CompiledFilter[]): boolean {
  for (const filter of filters) {
    if (!filter.values.has(row[filter.column] ?? '')) {
      return false;
    }
  }
  return true;
}

export function matchingRowIndices(
  rows: readonly (readonly string[])[],
  filters: ColumnFilters = {},
): number[] {
  const compiled = compileFilters(filters);
  const indices: number[] = [];
  for (const [index, row] of rows.entries()) {
    if (rowMatches(row, compiled)) {
      indices.push(index);
    }
  }
  return indices;
}

export function getColumnValues(
  rows: readonly (readonly string[])[],
  column: number,
  filters: ColumnFilters = {},
): ValueCount[] {
  const compiled = compileFilters(filters, column);
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (rowMatches(row, compiled)) {
      const value = row[column] ?? '';
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return Array.from(counts, ([value, count]) => ({ value, count }))
    .sort((left, right) => {
      if (left.value === '') {
        return right.value === '' ? 0 : -1;
      }
      if (right.value === '') {
        return 1;
      }
      return valueCollator.compare(left.value, right.value);
    });
}
