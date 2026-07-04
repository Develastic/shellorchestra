// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { DesktopAppSandbox } from '../app-framework/sandbox';
import { ConnectionWatchPayload } from './model';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';

export class ConnectionWatchService {
  readonly serverID: string;
  private readonly sandbox: DesktopAppSandbox;
  constructor(serverID: string, sandbox: DesktopAppSandbox) { this.serverID = serverID; this.sandbox = sandbox; this.sandbox.assertServerID(serverID); }
  async load(onProgress?: (payload: unknown) => void): Promise<ConnectionWatchPayload> {
    const response = await this.sandbox.fetch('/api/desktop-apps/connection_watch/data-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: this.serverID, args: { connection_watch_stream_format: 'row_events' }, confirmed: false }),
      requiredCapability: 'connections',
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not stream live connection data from this server.'));
    return ConnectionWatchPayload.fromUnknown(await readConnectionWatchStream(response, onProgress));
  }
}

type ConnectionWatchStreamEvent = {
  event?: string;
  data?: unknown;
  error?: string;
};

async function readConnectionWatchStream(response: Response, onProgress?: (payload: unknown) => void): Promise<unknown> {
  let result: unknown;
  const payload: Record<string, unknown> = {
    generated_at: '',
    platform: '',
    source: 'connection_watch_data',
    connections: [],
  };
  const rows: unknown[] = [];
  const emitProgress = () => {
    onProgress?.({ ...payload, connections: [...rows] });
  };
  const client = new RemoteStreamClient(response, {
    onEvent: (event: RemoteStreamEvent) => {
      if (event.event === 'result') {
        const data = event.data && typeof event.data === 'object' ? event.data as { result?: unknown } : {};
        result = data.result ?? {};
        return;
      }
      if (event.event === 'meta' || event.event === 'done') {
        Object.assign(payload, flattenConnectionWatchStreamEvent(event as ConnectionWatchStreamEvent));
        emitProgress();
        return;
      }
      if (event.event === 'row') {
        const data = (event as ConnectionWatchStreamEvent).data;
        if (data && typeof data === 'object') rows.push(data);
        if (rows.length === 1 || rows.length % 12 === 0) emitProgress();
      }
    },
  });
  await client.readNDJSON();
  if (result !== undefined) return result;
  payload.connections = rows;
  emitProgress();
  return payload;
}

function flattenConnectionWatchStreamEvent(event: ConnectionWatchStreamEvent): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'event' || key === 'transport' || key === 'connections') continue;
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
