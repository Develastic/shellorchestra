// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { DesktopAppSandbox } from '../app-framework/sandbox';

export type SafeDocumentWarning = {
  code?: string;
  severity?: string;
  message?: string;
  path?: string;
};

export type SafeDocumentResponse = {
  ok?: boolean;
  path?: string;
  document?: {
    version?: number;
    source_kind?: string;
    title?: string;
    warnings?: SafeDocumentWarning[];
    blocks?: unknown[];
    truncated?: boolean;
  };
  html?: string;
  text?: string;
  start_block?: number;
  block_limit?: number;
  has_more?: boolean;
  transport?: {
    remote_compression?: string;
    decoded_bytes?: number;
    chunks?: number;
  };
};

export class DocumentViewerService {
  readonly serverID: string;
  private readonly sandbox: DesktopAppSandbox;

  constructor(serverID: string, sandbox: DesktopAppSandbox) {
    this.serverID = serverID;
    this.sandbox = sandbox;
    this.sandbox.assertServerID(serverID);
  }

  async load(path: string, startBlock: number, blockLimit: number, maxBytes: number): Promise<SafeDocumentResponse> {
    const query = new URLSearchParams({
      server_id: this.serverID,
      path,
      start_block: String(Math.max(0, Math.floor(startBlock))),
      block_limit: String(Math.max(1, Math.floor(blockLimit))),
      max_bytes: String(Math.max(1, Math.floor(maxBytes))),
    });
    const response = await this.sandbox.fetch(`/api/safe-content/document?${query.toString()}`, { method: 'GET', requiredCapability: 'safe-preview' });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not load this safe document.'));
    return response.json() as Promise<SafeDocumentResponse>;
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
