interface WebviewAssets {
  scriptUri: string;
  styleUri: string;
  cspSource: string;
  nonce: string;
}

function attribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function createWebviewHtml(assets: WebviewAssets): string {
  const policy = `default-src 'none'; base-uri 'none'; form-action 'none'; style-src ${assets.cspSource}; script-src 'nonce-${assets.nonce}';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${attribute(policy)}">
  <link rel="stylesheet" href="${attribute(assets.styleUri)}">
  <title>CSVScope</title>
</head>
<body>
  <header class="toolbar">
    <div class="document-heading">
      <span class="table-mark" aria-hidden="true"></span>
      <div class="document-title">
        <h1 id="file-name">CSVScope</h1>
        <p id="document-meta">Read-only table view</p>
      </div>
    </div>
    <div class="toolbar-actions">
      <button id="clear-filters" type="button" class="secondary" disabled>Clear all filters</button>
      <button id="open-source" type="button" class="secondary" title="Edit the original file in VS Code's text editor">Open source</button>
    </div>
  </header>
  <section class="view-controls" aria-label="CSV options">
    <label class="delimiter-control" for="delimiter">Delimiter
      <select id="delimiter">
        <option value="auto">Auto-detect</option>
        <option value=",">Comma (,)</option>
        <option value=";">Semicolon (;)</option>
        <option value="&#9;">Tab</option>
        <option value="|">Pipe (|)</option>
      </select>
    </label>
    <label class="header-control"><input id="has-header" type="checkbox" checked> First row is header</label>
    <span class="read-only-label">Read-only &middot; filters never change your file</span>
  </section>
  <section class="record-summary" aria-label="Filter results">
    <strong id="record-count" role="status" aria-live="polite" aria-atomic="true">Loading records...</strong>
    <span id="filter-summary">Use a column's filter button to select values.</span>
  </section>
  <div id="notice" class="notice" role="status" hidden></div>
  <details id="diagnostics" class="diagnostics" hidden>
    <summary id="diagnostic-summary"></summary>
    <ul id="diagnostic-list"></ul>
  </details>
  <div id="error-banner" class="error-banner" role="alert" hidden></div>
  <main id="table-region" aria-busy="true">
    <div id="empty-file" class="empty-file" hidden>
      <h2>This file is empty</h2>
      <p>Use Open source to add CSV data. The table will update automatically.</p>
    </div>
    <div id="table-scroll" class="table-scroll" tabindex="0" aria-label="CSV table; scroll to browse records">
      <table id="csv-table" class="csv-table" aria-label="CSV records">
        <colgroup id="column-widths"></colgroup>
        <thead id="table-head"></thead>
        <tbody id="table-body"></tbody>
      </table>
    </div>
  </main>
  <footer class="view-footer">
    Select several values in one column, then filter other columns to narrow the results.
    <span>Hover over a cell to read its full value.</span>
  </footer>
  <dialog id="filter-dialog" aria-labelledby="filter-title" aria-describedby="filter-help">
    <div class="filter-heading">
      <h2 id="filter-title">Filter column</h2>
      <p id="filter-help">Select values to include. Other column filters stay applied.</p>
    </div>
    <div class="filter-search">
      <label for="value-search" class="sr-only">Search filter values</label>
      <input id="value-search" type="search" placeholder="Search values..." autocomplete="off" spellcheck="false">
    </div>
    <label class="select-all-row"><input id="select-all-values" type="checkbox"> <span id="select-all-label">Select all matching values</span></label>
    <div id="filter-values" class="filter-values" role="group" aria-label="Column values"></div>
    <div class="filter-option-summary">
      <span id="option-summary" role="status"></span>
      <button id="show-more-values" type="button" class="text-button" hidden>Show more values</button>
    </div>
    <div class="filter-footer">
      <button id="clear-column" type="button" class="text-button">Clear column filter</button>
      <div class="filter-footer-actions">
        <button id="cancel-filter" type="button" class="secondary">Cancel</button>
        <button id="apply-filter" type="button">Apply</button>
      </div>
    </div>
  </dialog>
  <script nonce="${attribute(assets.nonce)}" src="${attribute(assets.scriptUri)}"></script>
</body>
</html>`;
}
