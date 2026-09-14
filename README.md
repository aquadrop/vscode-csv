# CSVScope

A VS Code extension for browsing CSV and TSV files with Excel-style filtering.

- **Multiple value filters:** select several values in a column, then combine filters across columns.
- **Pinned headers:** column headers stay visible while scrolling vertically. Original record numbers stay pinned on the left.
- **Colored columns:** subtle, repeating column colors distinguish adjacent fields in light, dark, and high-contrast themes.
- **Live record count:** see matching records versus the total, including when no records match.
- **Non-destructive:** filters affect only the view. Open the source alongside the table to edit; the table updates automatically.

## Run locally

Requires desktop VS Code 1.85 or newer and Node.js 20 or newer.

```powershell
npm install
npm run compile
code .
```

If your organization uses an authenticated npm registry, authenticate with its approved credential provider before installing. Local registry configuration in `.npmrc` is excluded from Git and extension packages.

Press **F5** and choose **Run CSVScope**. In the Extension Development Host, open `people.csv` from the included examples folder.

To install into your normal VS Code window:

```powershell
npm run package
code --install-extension .\csv-filter-table-0.1.1.vsix
```

Alternatively, use **Extensions: Install from VSIX...** from the Command Palette. The package command builds the extension but does not publish it. Replace the `local-tools` publisher in `package.json` with your own Marketplace publisher before publishing.

CSVScope keeps the `csv-filter-table` package name and existing `csvFilter.*` command, editor, and setting identifiers for compatibility with existing installations.

## Use the table

Open a `.csv` or `.tsv` file. The extension contributes a default table editor; if another extension or an existing editor association takes precedence, use **Reopen Editor With... > CSVScope** or **CSVScope: Open in Table View**.

1. Click a column's filter button.
2. Uncheck **Select all values**, check the values you want, then click **Apply**.
3. Filter additional columns to narrow the result. Within a column, selected values use **OR**; across columns, filters use **AND**.

For example, selecting `Engineering` and `Support` in Department and `Berlin` in City shows Berlin records belonging to either department.

The checklist shows counts under the *other* column filters. Search narrows the checklist, not the table. **Select all search matches** affects only matching checklist values; selections outside the search are preserved. Large checklists initially show 500 values; search covers every value, and **Show next ... values** reveals more. Blank cells appear as **(Blanks)**. Comparisons are exact and case-sensitive; spaces in cell values are significant.

An empty selection intentionally matches no records. Use **Clear column filter** or **Clear all filters** to restore results. **Cancel**, clicking outside the filter menu, or **Escape** discards unapplied changes.

The toolbar count excludes the header and includes every matching record, not just the rows currently rendered. Row numbers refer to original data-record positions, not physical file lines; quoted multiline fields occupy one record. Hover over a cell to read its full value.

## File formats and settings

Comma, semicolon, tab, and pipe delimiters are supported, including quoted delimiters, escaped quotes, multiline fields, a UTF-8 BOM, and CRLF/LF/CR line endings. Auto-detection is heuristic; choose an explicit **Delimiter** for ambiguous files. Turn off **First row is header** for headerless files.

Missing cells are displayed as blank. Extra fields are retained with generated column names, and inconsistent row widths produce visible layout notes. Malformed quoting produces an explicit error instead of silently dropping records. Use **Open source** to correct the file.

| Setting | Default | Purpose |
| --- | --- | --- |
| `csvFilter.delimiter` | `"auto"` | Initial delimiter for views without saved options. |
| `csvFilter.hasHeader` | `true` | Whether the first record contains column names. |
| `csvFilter.maxFileSizeMB` | `20` | Decoded UTF-8 text size limit in MiB; configurable from 1 to 100. |

Each editor saves its own filters, layout options, and scroll position through VS Code's webview state. Source changes preserve filters when column names and order stay the same, including selections temporarily absent from the data. Changing the header schema or layout options clears filters explicitly to avoid applying them to the wrong columns.

The table is **read-only**, not a spreadsheet editor: it does not change values, rewrite formatting, or evaluate formulas. Files are parsed in memory, while table rows are virtualized for smooth scrolling. It is not a streaming viewer for arbitrarily large files. All CSV processing happens inside VS Code and its webview, with no network requests, remote scripts, or telemetry.

## Development

```powershell
npm run check
npm test
npm run test:ui
```

Unit tests cover parsing, delimiter detection, combined filters, saved state, and HTML generation. Browser tests exercise the actual bundled webview with a mocked VS Code message bridge, including filtering, live updates, record counts, pinned-header geometry, virtualization, and theme colors.

On Windows, browser tests use installed Microsoft Edge. On other platforms, install Playwright's Chromium once with `npx playwright install chromium`. For incremental builds, run `npm run watch` (type-check separately with `npm run check`).

To exercise a large local dataset without adding it to the repository, set `CSV_VALIDATION_FILE` before running the browser tests:

```powershell
$env:CSV_VALIDATION_FILE = 'C:\path\sample.csv'
npm run test:ui
```

This optional check expects more than 100 records and two filterable columns, compares combined filters against independently computed row indices, checks scrolling and header position, and verifies the source file remains unchanged. Screenshots, video, and tracing are disabled for this local-file check.

GitHub Actions runs the same checks and uploads a VSIX build artifact named **CSVScope**. The lockfile pins versions and integrity hashes without private registry URLs; when updating dependencies through a private feed, use `npm install --omit-lockfile-registry-resolved` to keep it portable.

The extension host is in `src\extension.ts`; CSV parsing and filter logic are in `src\csv.ts`; the table interface is in `src\webview\index.ts` and `media\webview.css`.
