import assert from 'node:assert/strict';
import test from 'node:test';
import { isCsvOptions, isDelimiterOption, restoreViewState, sameHeaders } from '../src/viewState';

const saved = () => ({
  version: 1,
  options: { delimiter: 'auto', hasHeader: true },
  headers: ['Name', 'Team'],
  filters: { 1: ['Engineering', 'Support', 'Engineering'] },
  scrollTop: 512,
  scrollLeft: 120,
});

test('restores options, exact filter values, and scroll position without sharing mutable arrays', () => {
  const input = saved();
  const state = restoreViewState(input);
  assert.ok(state);
  assert.deepEqual(state.filters, { 1: ['Engineering', 'Support'] });
  assert.equal(state.scrollTop, 512);
  assert.equal(state.scrollLeft, 120);
  input.headers[0] = 'Changed';
  input.filters[1].push('Other');
  assert.deepEqual(state.headers, ['Name', 'Team']);
  assert.deepEqual(state.filters[1], ['Engineering', 'Support']);
});

test('preserves a deliberately empty selection', () => {
  assert.deepEqual(restoreViewState({ ...saved(), filters: { 0: [] } })?.filters, { 0: [] });
});

test('rejects malformed or unsupported saved state', () => {
  const invalid: unknown[] = [
    undefined,
    null,
    [],
    {},
    { ...saved(), version: 2 },
    { ...saved(), options: { delimiter: ':', hasHeader: true } },
    { ...saved(), options: { delimiter: ',', hasHeader: 'yes' } },
    { ...saved(), filters: [] },
    { ...saved(), filters: { '-1': ['A'] } },
    { ...saved(), filters: { '1e0': ['A'] } },
    { ...saved(), filters: { '01': ['A'] } },
    { ...saved(), filters: { 2: ['A'] } },
    { ...saved(), filters: { 0: [7] } },
    { ...saved(), filters: { 0: null } },
    { ...saved(), filters: JSON.parse('{"__proto__":["A"]}') },
    { ...saved(), headers: ['Name', 7] },
    { ...saved(), scrollTop: -1 },
    { ...saved(), scrollTop: Infinity },
    { ...saved(), scrollLeft: NaN },
    { ...saved(), scrollLeft: '10' },
  ];
  for (const value of invalid) {
    assert.equal(restoreViewState(value), undefined);
  }
});

test('validates delimiter and header options at the message boundary', () => {
  for (const delimiter of ['auto', ',', ';', '\t', '|']) {
    assert.equal(isDelimiterOption(delimiter), true);
    assert.equal(isCsvOptions({ delimiter, hasHeader: false }), true);
  }
  assert.equal(isDelimiterOption('tab'), false);
  assert.equal(isDelimiterOption(null), false);
  assert.equal(isCsvOptions({ delimiter: ',', hasHeader: 1 }), false);
  assert.equal(isCsvOptions([]), false);
});

test('schema comparison is ordered and preserves duplicate header identities by position', () => {
  assert.equal(sameHeaders(['Name', 'Name'], ['Name', 'Name']), true);
  assert.equal(sameHeaders(['Name', 'Team'], ['Team', 'Name']), false);
  assert.equal(sameHeaders(['Name'], ['Name', 'Team']), false);
  assert.equal(sameHeaders([], []), true);
});
