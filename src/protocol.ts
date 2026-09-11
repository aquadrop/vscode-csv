import type { CsvData, CsvOptions } from './csv';

export interface DocumentInfo {
  name: string;
  uri: string;
  version: number;
}

export type HostMessage =
  | { type: 'data'; document: DocumentInfo; data: CsvData; options: CsvOptions }
  | { type: 'error'; document: DocumentInfo; message: string; options: CsvOptions };

export type WebviewMessage =
  | { type: 'ready'; options?: CsvOptions }
  | { type: 'configure'; options: CsvOptions }
  | { type: 'openSource' };
