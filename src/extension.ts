import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { parseCsv, type CsvOptions } from './csv';
import type { DocumentInfo, HostMessage } from './protocol';
import { isCsvOptions, isRecord } from './viewState';
import { createWebviewHtml } from './webviewHtml';

const VIEW_TYPE = 'csvFilter.table';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class CsvTableProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
  ) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): void {
    if (token.isCancellationRequested) {
      return;
    }

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };

    let options: CsvOptions = { delimiter: 'auto', hasHeader: true };
    let ready = false;
    let disposed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const documentInfo = (): DocumentInfo => ({
      name: document.uri.path.split('/').pop() || 'Untitled CSV',
      uri: document.uri.toString(),
      version: document.version,
    });

    const send = async (message: HostMessage): Promise<void> => {
      if (disposed) {
        return;
      }
      try {
        await panel.webview.postMessage(message);
      } catch (error: unknown) {
        if (!disposed) {
          this.output.appendLine(`Could not update the CSV table: ${errorText(error)}`);
        }
      }
    };

    const showError = async (error: unknown): Promise<void> => {
      const message = errorText(error);
      this.output.appendLine(`${document.uri.toString()}: ${message}`);
      await send({ type: 'error', document: documentInfo(), message, options });
    };

    const refresh = async (): Promise<void> => {
      if (!ready || disposed) {
        return;
      }
      try {
        const configuration = vscode.workspace.getConfiguration('csvFilter', document.uri);
        const sizeLimit = configuration.get<unknown>('maxFileSizeMB', 20);
        if (typeof sizeLimit !== 'number' || !Number.isFinite(sizeLimit) || sizeLimit < 1 || sizeLimit > 100) {
          throw new Error('csvFilter.maxFileSizeMB must be a number between 1 and 100.');
        }
        const text = document.getText();
        const size = Buffer.byteLength(text, 'utf8');
        if (size > sizeLimit * 1024 * 1024) {
          throw new Error(
            `This file is ${(size / 1024 / 1024).toFixed(1)} MiB, above the ${sizeLimit} MiB table limit. `
            + 'Open source to read it as text, or increase csvFilter.maxFileSizeMB in Settings. '
            + 'The table holds the decoded file in memory.',
          );
        }
        const data = parseCsv(text, options);
        await send({ type: 'data', document: documentInfo(), data, options });
      } catch (error: unknown) {
        await showError(error);
      }
    };

    const listeners: vscode.Disposable[] = [
      panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (!isRecord(message)) {
          this.output.appendLine('Ignored an invalid CSV table message.');
          return;
        }
        try {
          switch (message.type) {
            case 'ready': {
              ready = true;
              if (message.options !== undefined && !isCsvOptions(message.options)) {
                throw new Error('The table supplied invalid saved CSV options.');
              }
              const configuration = vscode.workspace.getConfiguration('csvFilter', document.uri);
              const defaults = {
                delimiter: configuration.get<unknown>('delimiter', 'auto'),
                hasHeader: configuration.get<unknown>('hasHeader', true),
              };
              if (message.options === undefined && !isCsvOptions(defaults)) {
                throw new Error('Invalid csvFilter.delimiter or csvFilter.hasHeader setting.');
              }
              if (isCsvOptions(message.options)) {
                options = message.options;
              } else if (isCsvOptions(defaults)) {
                options = defaults;
              }
              await refresh();
              break;
            }
            case 'configure':
              if (!isCsvOptions(message.options)) {
                throw new Error('The table supplied invalid CSV options.');
              }
              options = message.options;
              await refresh();
              break;
            case 'openSource':
              await vscode.commands.executeCommand(
                'vscode.openWith', document.uri, 'default', vscode.ViewColumn.Beside,
              );
              break;
            default:
              this.output.appendLine('Ignored an unknown CSV table message.');
          }
        } catch (error: unknown) {
          await showError(error);
        }
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document !== document) {
          return;
        }
        if (refreshTimer !== undefined) {
          clearTimeout(refreshTimer);
        }
        refreshTimer = setTimeout(() => {
          refreshTimer = undefined;
          void refresh();
        }, 200);
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('csvFilter.maxFileSizeMB', document.uri)) {
          void refresh();
        }
      }),
    ];

    panel.onDidDispose(() => {
      disposed = true;
      if (refreshTimer !== undefined) {
        clearTimeout(refreshTimer);
      }
      for (const listener of listeners) {
        listener.dispose();
      }
    });

    panel.webview.html = createWebviewHtml({
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.css')).toString(),
      cspSource: panel.webview.cspSource,
      nonce: randomBytes(16).toString('hex'),
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('CSVScope');
  context.subscriptions.push(
    output,
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      new CsvTableProvider(context.extensionUri, output),
      { supportsMultipleEditorsPerDocument: true },
    ),
    vscode.commands.registerCommand('csvFilter.openTable', async (uri?: vscode.Uri) => {
      try {
        let target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) {
          const selected = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'CSV and TSV files': ['csv', 'tsv'] },
            openLabel: 'Open CSV table',
          });
          target = selected?.[0];
        }
        if (target) {
          await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
        }
      } catch (error: unknown) {
        const message = `Could not open the CSV table: ${errorText(error)}`;
        output.appendLine(message);
        await vscode.window.showErrorMessage(message);
      }
    }),
  );
}
