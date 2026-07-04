// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { DesktopAppSandbox } from '../app-framework/sandbox';

export type SafeSpreadsheetWarning = {
  code?: string;
  severity?: string;
  message?: string;
  path?: string;
};

export type SafeSpreadsheetSheet = {
  id?: string;
  name?: string;
  row_count?: number;
  column_count?: number;
  warnings?: SafeSpreadsheetWarning[];
  truncated?: boolean;
  header?: SafeSpreadsheetHeader;
  interactive?: SafeSpreadsheetInteractive;
  columns?: SafeSpreadsheetColumn[];
};

export type SafeSpreadsheetHeader = {
  detected?: boolean;
  confidence?: number;
  row_index?: number;
  reason?: string;
};

export type SafeSpreadsheetInteractive = {
  eligible?: boolean;
  disabled_reason?: string;
  max_rows?: number;
  max_columns?: number;
  max_bytes?: number;
};

export type SafeSpreadsheetColumn = {
  index?: number;
  label?: string;
  inferred_type?: string;
  confidence?: number;
};

export type SafeSpreadsheetWorkbookResponse = {
  ok?: boolean;
  path?: string;
  workbook?: {
    version?: number;
    source_kind?: string;
    warnings?: SafeSpreadsheetWarning[];
    sheets?: SafeSpreadsheetSheet[];
    truncated?: boolean;
  };
  transport?: SafeSpreadsheetTransport;
};

export type SafeSpreadsheetCell = {
  type?: string;
  value?: string;
  display?: string;
  number_value?: number;
  boolean_value?: boolean;
  date_value?: string;
  flags?: string[];
};

export type SafeSpreadsheetRowsResponse = {
  ok?: boolean;
  path?: string;
  chunk?: {
    version?: number;
    sheet_id?: string;
    start_row?: number;
    rows?: SafeSpreadsheetCell[][];
    truncated?: boolean;
  };
  has_more?: boolean;
  transport?: SafeSpreadsheetTransport;
};

export type SafeSpreadsheetTransport = {
  remote_compression?: string;
  decoded_bytes?: number;
  chunks?: number;
  truncated?: boolean;
};

export class SpreadsheetViewerService {
  readonly serverID: string;
  private readonly sandbox: DesktopAppSandbox;

  constructor(serverID: string, sandbox: DesktopAppSandbox) {
    this.serverID = serverID;
    this.sandbox = sandbox;
    this.sandbox.assertServerID(serverID);
  }

  async workbook(path: string, maxBytes: number): Promise<SafeSpreadsheetWorkbookResponse> {
    const query = new URLSearchParams({ server_id: this.serverID, path, max_bytes: String(Math.max(1, Math.floor(maxBytes))) });
    const response = await this.sandbox.fetch(`/api/safe-content/spreadsheet/workbook?${query.toString()}`, { method: 'GET', requiredCapability: 'safe-preview' });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not load this safe workbook.'));
    return response.json() as Promise<SafeSpreadsheetWorkbookResponse>;
  }

  async rows(path: string, sheetID: string, startRow: number, rowLimit: number, maxBytes: number): Promise<SafeSpreadsheetRowsResponse> {
    const query = new URLSearchParams({
      server_id: this.serverID,
      path,
      sheet_id: sheetID,
      start_row: String(Math.max(0, Math.floor(startRow))),
      row_limit: String(Math.max(1, Math.floor(rowLimit))),
      max_bytes: String(Math.max(1, Math.floor(maxBytes))),
    });
    const response = await this.sandbox.fetch(`/api/safe-content/spreadsheet/rows?${query.toString()}`, { method: 'GET', requiredCapability: 'safe-preview' });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not load safe spreadsheet rows.'));
    return response.json() as Promise<SafeSpreadsheetRowsResponse>;
  }
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const text = (await response.text().catch(() => '')).trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
  } catch {
    // Plain text error body.
  }
  return text || fallback;
}
