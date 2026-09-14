import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebviewHtml } from '../src/webviewHtml';

test('uses only local assets with a nonce-restricted script policy', () => {
  const html = createWebviewHtml({
    scriptUri: 'https://csv.test/webview.js',
    styleUri: 'https://csv.test/webview.css',
    cspSource: "'self'",
    nonce: 'testnonce',
  });
  assert.match(html, /<title>CSVScope<\/title>/);
  assert.match(html, /<h1 id="file-name">CSVScope<\/h1>/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /base-uri 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /script-src 'nonce-testnonce'/);
  assert.match(html, /<script nonce="testnonce" src="https:\/\/csv.test\/webview.js"><\/script>/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
  assert.match(html, /id="record-count" role="status" aria-live="polite"/);
  assert.match(html, /<dialog id="filter-dialog" aria-labelledby="filter-title"/);
});

test('escapes attribute values in the generated document', () => {
  const html = createWebviewHtml({
    scriptUri: 'https://csv.test/a?x="><img src=x>&y=1',
    styleUri: 'https://csv.test/style.css?a=1&b=2',
    cspSource: "'self'",
    nonce: 'test"value',
  });
  assert.match(html, /x=&quot;&gt;&lt;img src=x&gt;&amp;y=1/);
  assert.match(html, /style.css\?a=1&amp;b=2/);
  assert.doesNotMatch(html, /<img src=x>/);
});
