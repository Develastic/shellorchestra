// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { DesktopAppSandbox } from '../app-framework/sandbox';
import { DisksPayload } from './model';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';

export class DisksService {
  readonly serverID: string;
  private readonly sandbox: DesktopAppSandbox;

  constructor(serverID: string, sandbox: DesktopAppSandbox) {
    this.serverID = serverID;
    this.sandbox = sandbox;
    this.sandbox.assertServerID(serverID);
  }

  async load(): Promise<DisksPayload> {
    const response = await this.sandbox.fetch('/api/desktop-apps/disks/data-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: this.serverID, args: { disks_stream_format: 'row_events' }, confirmed: false }),
      requiredCapability: 'disks',
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not stream disk inventory from this server.'));
    return new DisksPayload(await readDisksStream(response));
  }
}

type DisksStreamEvent = {
  event?: string;
  data?: unknown;
  error?: string;
};

async function readDisksStream(response: Response): Promise<unknown> {
  let result: unknown;
  const payload: Record<string, unknown> = {
    ok: true,
    action: 'list',
    platform: '',
    source: 'disks_data',
    generated_at: '',
    rows: [],
    lvm_rows: [],
    lvm_available: false,
  };
  const rows: unknown[] = [];
  const lvmRows: unknown[] = [];
  const client = new RemoteStreamClient(response, {
    onEvent: (event: RemoteStreamEvent) => {
      if (event.event === 'result') {
        const data = event.data && typeof event.data === 'object' ? event.data as { result?: unknown } : {};
        result = data.result ?? {};
        return;
      }
      if (event.event === 'meta' || event.event === 'done') {
        Object.assign(payload, flattenDisksStreamEvent(event as DisksStreamEvent));
        return;
      }
      if (event.event === 'row') {
        const row = normalizeDisksRow((event as DisksStreamEvent).data);
        if (row.kind === 'lvm') lvmRows.push(row.item);
        else if (row.kind === 'disk') rows.push(row.item);
      }
    },
  });
  await client.readNDJSON();
  if (result !== undefined) return result;
  payload.rows = rows;
  payload.lvm_rows = lvmRows;
  payload.lvm_available = payload.lvm_available === true || lvmRows.length > 0;
  return payload;
}

function normalizeDisksRow(value: unknown): { kind: 'disk' | 'lvm'; item: unknown } {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const kind = data.kind === 'lvm' ? 'lvm' : 'disk';
  return { kind, item: data.item && typeof data.item === 'object' ? data.item : data };
}

function flattenDisksStreamEvent(event: DisksStreamEvent): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'event' || key === 'transport' || key === 'rows' || key === 'lvm_rows') continue;
    result[key] = value;
  }
  return result;
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const payload = await response.clone().json().catch(() => ({})) as { error?: string };
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  const text = await response.clone().text().catch(() => '');
  return text.trim() || fallback;
}
