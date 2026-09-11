import type { ColumnFilters, CsvOptions, DelimiterOption } from './csv';

export interface ViewState {
  version: 1;
  options: CsvOptions;
  filters: ColumnFilters;
  headers: string[];
  scrollTop: number;
  scrollLeft: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isDelimiterOption(value: unknown): value is DelimiterOption {
  return value === 'auto' || value === ',' || value === ';' || value === '\t' || value === '|';
}

export function isCsvOptions(value: unknown): value is CsvOptions {
  return isRecord(value) && isDelimiterOption(value.delimiter) && typeof value.hasHeader === 'boolean';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

export function restoreViewState(value: unknown): ViewState | undefined {
  if (!isRecord(value) || value.version !== 1 || !isCsvOptions(value.options)
    || !isRecord(value.filters) || !isStringArray(value.headers)
    || typeof value.scrollTop !== 'number' || !Number.isFinite(value.scrollTop) || value.scrollTop < 0
    || typeof value.scrollLeft !== 'number' || !Number.isFinite(value.scrollLeft) || value.scrollLeft < 0) {
    return undefined;
  }

  const filters: ColumnFilters = {};
  for (const [key, values] of Object.entries(value.filters)) {
    const column = Number(key);
    if (!/^(0|[1-9]\d*)$/.test(key) || !Number.isSafeInteger(column)
      || column >= value.headers.length || !isStringArray(values)) {
      return undefined;
    }
    filters[column] = [...new Set(values)];
  }

  return {
    version: 1,
    options: { ...value.options },
    filters,
    headers: [...value.headers],
    scrollTop: value.scrollTop,
    scrollLeft: value.scrollLeft,
  };
}

export function sameHeaders(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((header, index) => header === right[index]);
}
