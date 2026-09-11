import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CsvParseError,
  getColumnValues,
  matchingRowIndices,
  parseCsv,
  type ColumnFilters,
  type Delimiter,
} from '../src/csv';

test('comma and a header row are the defaults', () => {
  assert.deepEqual(parseCsv('name,city\nAda,London\nGrace,New York'), {
    headers: ['name', 'city'],
    rows: [['Ada', 'London'], ['Grace', 'New York']],
    delimiter: ',',
    lineEnding: '\n',
    diagnostics: [],
  });
  assert.deepEqual(parseCsv('name;city\nAda;London').rows, [['Ada;London']]);
});

test('empty and BOM-only input have no columns or records', () => {
  for (const source of ['', '\uFEFF']) {
    for (const hasHeader of [true, false]) {
      assert.deepEqual(parseCsv(source, { hasHeader }), {
        headers: [],
        rows: [],
        delimiter: ',',
        lineEnding: '\n',
        diagnostics: [],
      });
    }
  }
  assert.equal(parseCsv('', { delimiter: 'auto' }).delimiter, ',');
  assert.equal(parseCsv('', { delimiter: '\t' }).delimiter, '\t');
});

test('only the leading BOM is removed, and Unicode cell content is preserved', () => {
  const result = parseCsv('\uFEFFname,value\n猫,😀\nAda,\uFEFFdata');
  assert.deepEqual(result.headers, ['name', 'value']);
  assert.deepEqual(result.rows, [['猫', '😀'], ['Ada', '\uFEFFdata']]);
});

test('quoted separators, escaped quotes, and quoted empty fields are decoded', () => {
  const result = parseCsv('name,note,empty\n"Doe, Ada","She said ""hello"".",""\n"""","a,b",');
  assert.deepEqual(result.rows, [
    ['Doe, Ada', 'She said "hello".', ''],
    ['"', 'a,b', ''],
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test('quoted multiline fields preserve CRLF, LF, and CR verbatim', () => {
  const result = parseCsv('name,note\r\nAda,"first\r\nsecond\nthird\rfourth"\r\nGrace,done\r\n');
  assert.equal(result.lineEnding, '\r\n');
  assert.deepEqual(result.rows, [
    ['Ada', 'first\r\nsecond\nthird\rfourth'],
    ['Grace', 'done'],
  ]);
});

test('line-ending metadata uses the first record ending, not a quoted newline', () => {
  assert.equal(parseCsv('"a\r\nb",c\nx,y').lineEnding, '\n');
  assert.equal(parseCsv('"a\r\nb",c').lineEnding, '\n');
  assert.equal(parseCsv('a,b\rc,d\ne,f\r\ng,h').lineEnding, '\r');
});

for (const ending of ['\r\n', '\n', '\r'] as const) {
  test(`record ending ${JSON.stringify(ending)} does not create a phantom record`, () => {
    const result = parseCsv(`name,value${ending}Ada,1${ending}`);
    assert.equal(result.lineEnding, ending);
    assert.deepEqual(result.rows, [['Ada', '1']]);
    assert.deepEqual(parseCsv(`name${ending}${ending}`).rows, [['']]);
    assert.deepEqual(parseCsv(ending, { hasHeader: false }).rows, [['']]);
    assert.deepEqual(parseCsv(`${ending}${ending}`, { hasHeader: false }).rows, [[''], ['']]);
  });
}

test('actual blank records, trailing empty fields, and whitespace-only records survive', () => {
  const result = parseCsv('a,b\n\n1,\n  \n2,3\n\n');
  assert.deepEqual(result.rows, [
    ['', ''],
    ['1', ''],
    ['  ', ''],
    ['2', '3'],
    ['', ''],
  ]);
  assert.deepEqual(parseCsv('""', { hasHeader: false }).rows, [['']]);
  assert.deepEqual(parseCsv(',', { hasHeader: false }).rows, [['', '']]);
  assert.deepEqual(parseCsv('   ', { hasHeader: false }).rows, [['   ']]);
});

test('blank first records do not erase later columns', () => {
  const result = parseCsv('\nAda,London,1\nGrace,New York,2');
  assert.deepEqual(result.headers, ['Column 1', 'Column 2', 'Column 3']);
  assert.deepEqual(result.rows, [['Ada', 'London', '1'], ['Grace', 'New York', '2']]);
  assert.equal(result.diagnostics[0]?.line, 1);
  const auto = parseCsv('\nAda;London;1\nGrace;Paris;2', { delimiter: 'auto' });
  assert.equal(auto.delimiter, ';');
  assert.equal(auto.headers.length, 3);
});

test('headers are trimmed without changing duplicate labels or cell whitespace', () => {
  const result = parseCsv(' name ,name, ,\n  Ada  , Ada ," inner ",\tvalue\t');
  assert.deepEqual(result.headers, ['name', 'name', 'Column 3', 'Column 4']);
  assert.deepEqual(result.rows, [['  Ada  ', ' Ada ', ' inner ', '\tvalue\t']]);
});

test('spaces and tabs after closing quotes are tolerated but are not cell data', () => {
  const result = parseCsv('a,b\n" inner " \t,"value"\t \n"x" ,y');
  assert.deepEqual(result.rows, [[' inner ', 'value'], ['x', 'y']]);
  assert.deepEqual(parseCsv('"a"\t"b"\n"x"\t"y"', { delimiter: '\t' }).rows, [['x', 'y']]);
});

test('header-only input retains its columns, with or without a final ending', () => {
  for (const source of [' name , ,name', ' name , ,name\r\n']) {
    const result = parseCsv(source);
    assert.deepEqual(result.headers, ['name', 'Column 2', 'name']);
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.diagnostics, []);
  }
});

test('no-header mode generates names from the maximum width and keeps the first record', () => {
  const result = parseCsv('Ada,London\nGrace,New York,2\nLin', { hasHeader: false });
  assert.deepEqual(result.headers, ['Column 1', 'Column 2', 'Column 3']);
  assert.deepEqual(result.rows, [['Ada', 'London', ''], ['Grace', 'New York', '2'], ['Lin', '', '']]);
  assert.deepEqual(result.diagnostics.map(({ line }) => line), [1, 3]);
});

test('ragged rows preserve extra fields, pad missing cells, and generate missing headers', () => {
  const result = parseCsv('first,second\n1,2,3,4\n5\n6,7,8');
  assert.deepEqual(result.headers, ['first', 'second', 'Column 3', 'Column 4']);
  assert.deepEqual(result.rows, [
    ['1', '2', '3', '4'],
    ['5', '', '', ''],
    ['6', '7', '8', ''],
  ]);
  assert.deepEqual(result.diagnostics.map(({ line }) => line), [1, 3, 4]);
  assert.match(result.diagnostics[0]?.message ?? '', /2.*4/);
});

test('ragged diagnostics refer to physical record-start lines across quoted newlines', () => {
  const result = parseCsv('a,b,c\r\n"first\r\nsecond",x\r\ny');
  assert.deepEqual(result.rows, [['first\r\nsecond', 'x', ''], ['y', '', '']]);
  assert.deepEqual(result.diagnostics.map(({ line }) => line), [2, 4]);
});

test('ragged diagnostics are capped with an explicit count of omitted records', () => {
  const result = parseCsv(`a,b,c\n${Array.from({ length: 200 }, () => 'x').join('\n')}`);
  assert.equal(result.rows.length, 200);
  assert.equal(result.diagnostics.length, 51);
  assert.deepEqual(result.diagnostics.at(-1), {
    line: 52,
    message: 'Omitted diagnostics for 150 additional ragged records.',
  });
  assert.deepEqual(result.rows.at(-1), ['x', '', '']);
});

const supportedDelimiters: readonly Delimiter[] = [',', ';', '\t', '|'];
for (const delimiter of supportedDelimiters) {
  test(`explicit ${JSON.stringify(delimiter)} delimiter is honored`, () => {
    const result = parseCsv(`name${delimiter}note\nAda${delimiter}"x,y;z\tw|q"`, { delimiter });
    assert.equal(result.delimiter, delimiter);
    assert.deepEqual(result.rows, [['Ada', 'x,y;z\tw|q']]);
    assert.deepEqual(result.diagnostics, []);
  });

  test(`auto detects ${JSON.stringify(delimiter)} without counting quoted separators`, () => {
    const source = `name${delimiter}note\nAda${delimiter}"x,y;z\tw|q\n""quoted"",;|\t"\n`
      + `Grace${delimiter}"one,two;three\tfour|five"\n`;
    const result = parseCsv(source, { delimiter: 'auto' });
    assert.equal(result.delimiter, delimiter);
    assert.deepEqual(result.headers, ['name', 'note']);
    assert.deepEqual(result.rows, [
      ['Ada', 'x,y;z\tw|q\n"quoted",;|\t'],
      ['Grace', 'one,two;three\tfour|five'],
    ]);
  });
}

test('auto detection prioritizes delimiter consistency over numerous incidental commas', () => {
  const result = parseCsv('name;note\nAda;one,two,three,four\nGrace;one,two\nLin;one', {
    delimiter: 'auto',
  });
  assert.equal(result.delimiter, ';');
  assert.deepEqual(result.rows, [
    ['Ada', 'one,two,three,four'],
    ['Grace', 'one,two'],
    ['Lin', 'one'],
  ]);
});

test('auto detection handles decimal commas with and without a header', () => {
  const headed = parseCsv('item;price\napple;1,23\npear;4,56', { delimiter: 'auto' });
  assert.equal(headed.delimiter, ';');
  assert.deepEqual(headed.rows, [['apple', '1,23'], ['pear', '4,56']]);
  for (const delimiter of [';', '\t', '|'] as const) {
    const result = parseCsv(`apple${delimiter}1,23\npear${delimiter}4,56`, {
      delimiter: 'auto',
      hasHeader: false,
    });
    assert.equal(result.delimiter, delimiter);
    assert.deepEqual(result.rows, [['apple', '1,23'], ['pear', '4,56']]);
  }
  assert.equal(parseCsv('1,2\n3,4', { delimiter: 'auto', hasHeader: false }).delimiter, ',');
});

test('auto detection uses quote boundaries to resolve otherwise equal candidates', () => {
  const result = parseCsv('h1,h2;h3\nv1,v2;"v3"', { delimiter: 'auto' });
  assert.equal(result.delimiter, ';');
  assert.deepEqual(result.rows, [['v1,v2', 'v3']]);
});

test('auto falls back to comma for delimiter-free input and equally supported ties', () => {
  assert.equal(parseCsv('name\nAda\nGrace', { delimiter: 'auto' }).delimiter, ',');
  assert.equal(parseCsv('"one;two|three"', { delimiter: 'auto' }).delimiter, ',');
  assert.equal(parseCsv('a,b;c\nx,y;z', { delimiter: 'auto' }).delimiter, ',');
  assert.equal(parseCsv('a,b;c\nx,y;z', { delimiter: ';' }).delimiter, ';');
});

const malformedCases = [
  { source: 'a,b\n1,"unfinished', line: 2, column: 3, message: /Unterminated quoted field/ },
  { source: '"first\r\nsecond', line: 1, column: 1, message: /Unterminated quoted field/ },
  { source: 'a,b\n1,"unfinished""', line: 2, column: 3, message: /Unterminated quoted field/ },
  { source: 'a,b\n1,"closed"x', line: 2, column: 11, message: /after closing quote/ },
  { source: 'a,b\n1,"closed" \tx', line: 2, column: 13, message: /after closing quote/ },
  { source: 'a,b\r\n1,"first\r\nsecond"x', line: 3, column: 8, message: /after closing quote/ },
  { source: 'a,b\n1,ba"d', line: 2, column: 5, message: /quote in unquoted field/ },
  { source: 'a,b\n1, "quoted"', line: 2, column: 4, message: /quote in unquoted field/ },
  { source: '"""', line: 1, column: 1, message: /Unterminated quoted field/ },
  { source: '"a" "b"', line: 1, column: 5, message: /after closing quote/ },
] as const;

for (const malformed of malformedCases) {
  test(`malformed quoting throws a positioned CsvParseError: ${JSON.stringify(malformed.source)}`, () => {
    for (const delimiter of [',', 'auto'] as const) {
      assert.throws(() => parseCsv(malformed.source, { delimiter }), (error: unknown) => {
        assert.ok(error instanceof CsvParseError);
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'CsvParseError');
        assert.equal(error.line, malformed.line);
        assert.equal(error.column, malformed.column);
        assert.match(error.message, malformed.message);
        assert.match(error.message, new RegExp(`line ${malformed.line}, column ${malformed.column}`));
        return true;
      });
    }
  });
}

test('a malformed later record throws instead of returning partially parsed rows', () => {
  assert.throws(() => parseCsv('a,b\n1,2\n3,4\n5,"bad'), CsvParseError);
  assert.throws(() => parseCsv('a;b\n1;2\n3;"bad', { delimiter: 'auto' }), CsvParseError);
});

test('auto detection does not hide malformed quoting by choosing an incidental delimiter', () => {
  for (const incidental of [';', '\t', '|'] as const) {
    assert.throws(
      () => parseCsv(`a,b\n1,2\n3,4\n"5"${incidental}6`, { delimiter: 'auto' }),
      CsvParseError,
    );
  }
});

test('long fields with escaped quotes are preserved', () => {
  const content = 'x'.repeat(100_000);
  assert.deepEqual(parseCsv(`value\n"${content}""tail"`).rows, [[`${content}"tail`]]);
});

const filterRows: readonly (readonly string[])[] = [
  ['red', 'small', '1'],
  ['blue', 'large', '2'],
  ['red', 'large', '3'],
  ['green', 'large', '4'],
  ['blue', 'small', '5'],
  ['red', 'large', '6'],
];

test('absent or undefined filters return every source index in order', () => {
  assert.deepEqual(matchingRowIndices(filterRows), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(matchingRowIndices(filterRows, { 0: undefined }), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(matchingRowIndices([]), []);
});

test('selections are OR within one column and AND across columns', () => {
  assert.deepEqual(matchingRowIndices(filterRows, { 0: ['red', 'blue'] }), [0, 1, 2, 4, 5]);
  assert.deepEqual(matchingRowIndices(filterRows, {
    0: ['red', 'blue'],
    1: ['large'],
  }), [1, 2, 5]);
  assert.deepEqual(matchingRowIndices(filterRows, { 0: ['red', 'red'] }), [0, 2, 5]);
  assert.deepEqual(matchingRowIndices(filterRows, { 0: ['purple'] }), []);
});

test('an explicit empty selection matches no rows, unlike a removed filter', () => {
  assert.deepEqual(matchingRowIndices(filterRows, { 0: [] }), []);
  assert.deepEqual(matchingRowIndices(filterRows, { 0: ['red'], 1: [] }), []);
  assert.deepEqual(matchingRowIndices(filterRows, { 0: undefined, 1: ['small'] }), [0, 4]);
});

test('filter matching is exact and case-sensitive, including whitespace and blanks', () => {
  const rows = [['Ada'], ['ada'], [' Ada '], [''], [' '], [], ['\t']];
  assert.deepEqual(matchingRowIndices(rows, { 0: ['Ada'] }), [0]);
  assert.deepEqual(matchingRowIndices(rows, { 0: ['ada', ' Ada '] }), [1, 2]);
  assert.deepEqual(matchingRowIndices(rows, { 0: [''] }), [3, 5]);
  assert.deepEqual(matchingRowIndices(rows, { 0: [' ', '\t'] }), [4, 6]);
  assert.deepEqual(matchingRowIndices(rows, { 2: [''] }), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(matchingRowIndices(rows, { 2: ['not empty'] }), []);
});

test('prototype-like strings are ordinary filter values and count keys', () => {
  const rows = [['__proto__'], ['constructor'], ['toString'], ['__proto__'], ['hasOwnProperty']];
  assert.deepEqual(matchingRowIndices(rows, { 0: ['__proto__', 'constructor'] }), [0, 1, 3]);
  const counts = new Map(getColumnValues(rows, 0).map(({ value, count }) => [value, count]));
  assert.equal(counts.size, 4);
  assert.equal(counts.get('__proto__'), 2);
  assert.equal(counts.get('constructor'), 1);
  assert.equal(counts.get('toString'), 1);
  assert.equal(counts.get('hasOwnProperty'), 1);
});

test('column values are distinct counts sorted with blanks first and natural numeric order', () => {
  assert.deepEqual(getColumnValues([['item10'], ['item2'], [''], ['item1'], ['item2'], []], 0), [
    { value: '', count: 2 },
    { value: 'item1', count: 1 },
    { value: 'item2', count: 2 },
    { value: 'item10', count: 1 },
  ]);
  assert.deepEqual(getColumnValues([], 0), []);
  assert.deepEqual(getColumnValues([['a'], ['b']], 3), [{ value: '', count: 2 }]);
});

test('faceted counts apply all other filters but ignore their own selection', () => {
  const filters: ColumnFilters = { 0: ['red'], 1: ['large'] };
  assert.deepEqual(getColumnValues(filterRows, 0, filters), [
    { value: 'blue', count: 1 },
    { value: 'green', count: 1 },
    { value: 'red', count: 2 },
  ]);
  assert.deepEqual(getColumnValues(filterRows, 1, filters), [
    { value: 'large', count: 2 },
    { value: 'small', count: 1 },
  ]);
  assert.deepEqual(getColumnValues(filterRows, 2, filters), [
    { value: '3', count: 1 },
    { value: '6', count: 1 },
  ]);
});

test('faceted counts ignore even an empty own filter but honor another empty filter', () => {
  assert.deepEqual(getColumnValues(filterRows, 0, { 0: [], 1: ['small'] }), [
    { value: 'blue', count: 1 },
    { value: 'red', count: 1 },
  ]);
  assert.deepEqual(getColumnValues(filterRows, 0, { 0: ['red'], 1: [] }), []);
  assert.deepEqual(getColumnValues(filterRows, 0, { 1: undefined }), getColumnValues(filterRows, 0));
});

test('faceted counts retain exact case, whitespace, and missing-cell blank values', () => {
  const rows = [['', 'yes'], [], [' ', 'yes'], ['A', 'yes'], ['a', 'yes'], ['A', 'no']];
  const values = getColumnValues(rows, 0, { 0: ['ignored'], 1: ['yes', ''] });
  assert.deepEqual(values[0], { value: '', count: 2 });
  const counts = new Map(values.map(({ value, count }) => [value, count]));
  assert.equal(counts.size, 4);
  assert.equal(counts.get(' '), 1);
  assert.equal(counts.get('A'), 1);
  assert.equal(counts.get('a'), 1);
});

test('filtering and value sorting do not mutate rows or selected values', () => {
  const rows = Object.freeze([
    Object.freeze(['b', '2']),
    Object.freeze(['a', '1']),
    Object.freeze(['a', '3']),
  ]);
  const selected = Object.freeze(['b', 'a', 'a']);
  const filters: ColumnFilters = Object.freeze({ 0: selected, 1: undefined });
  const snapshot = JSON.stringify({ rows, filters });
  assert.deepEqual(matchingRowIndices(rows, filters), [0, 1, 2]);
  assert.deepEqual(getColumnValues(rows, 0, filters), [
    { value: 'a', count: 2 },
    { value: 'b', count: 1 },
  ]);
  assert.equal(JSON.stringify({ rows, filters }), snapshot);
  assert.deepEqual(selected, ['b', 'a', 'a']);
});

test('tens of thousands of records parse, filter, and count without losing source order', () => {
  const count = 25_000;
  const source = 'id,group,note,parity\r\n' + Array.from({ length: count }, (_, index) => (
    `${index},Group ${index % 5},"value, ${index}",${index % 2 === 0 ? 'even' : 'odd'}`
  )).join('\r\n') + '\r\n';
  const result = parseCsv(source, { delimiter: 'auto' });
  assert.equal(result.delimiter, ',');
  assert.equal(result.lineEnding, '\r\n');
  assert.deepEqual(result.headers, ['id', 'group', 'note', 'parity']);
  assert.equal(result.rows.length, count);
  assert.deepEqual(result.rows.at(-1), ['24999', 'Group 4', 'value, 24999', 'odd']);
  assert.deepEqual(result.diagnostics, []);
  const filters: ColumnFilters = { 1: ['Group 1', 'Group 3'], 3: ['odd'] };
  const indices = matchingRowIndices(result.rows, filters);
  assert.equal(indices.length, 5_000);
  assert.deepEqual(indices.slice(0, 4), [1, 3, 11, 13]);
  assert.equal(indices.at(-1), 24_993);
  assert.deepEqual(getColumnValues(result.rows, 3, filters), [
    { value: 'even', count: 5_000 },
    { value: 'odd', count: 5_000 },
  ]);
});
