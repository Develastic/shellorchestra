// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { DesktopAppSandbox } from '../app-framework/sandbox';
import { LogsPayload } from './model';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';

export class LogsAppService {
  readonly serverID: string;
  private readonly sandbox: DesktopAppSandbox;
  constructor(serverID: string, sandbox: DesktopAppSandbox) { this.serverID = serverID; this.sandbox = sandbox; this.sandbox.assertServerID(serverID); }
  async load(args: { source?: 'file' | 'system' | 'container'; path?: string; query?: string; unit?: string; priority?: string; since?: string; until?: string; limit?: number; follow?: boolean; cursor?: string; liveLimit?: number; liveMaxBytes?: number; containerID?: string; containerEngine?: string }): Promise<LogsPayload> {
    const params = new URLSearchParams({
      server_id: this.serverID,
      source: args.source ?? '',
      path: args.path ?? '',
      query: args.query ?? '',
      unit: args.unit ?? '',
      priority: args.priority ?? '',
      since: args.since ?? '',
      until: args.until ?? '',
      limit: String(args.limit ?? 200),
      follow: args.follow ? 'true' : '',
      cursor: args.cursor ?? '',
      live_limit: String(args.liveLimit ?? 5000),
      live_max_bytes: String(args.liveMaxBytes ?? 1048576),
      container_id: args.containerID ?? '',
      container_engine: args.containerEngine ?? '',
      stream_format: 'row_events',
    });
    const response = await this.sandbox.fetch(`/api/logs/stream?${params.toString()}`, { method: 'GET', requiredCapability: 'logs' });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not stream logs from this server.'));
    return LogsPayload.fromUnknown(await readLogsStream(response));
  }
}

type LogsStreamEvent = {
  event?: string;
  data?: unknown;
  error?: string;
};

async function readLogsStream(response: Response): Promise<unknown> {
  let result: unknown;
  const payload: Record<string, unknown> = {
    generated_at: '',
    platform: 'unknown',
    source: 'unknown',
    path: '',
    format: 'unknown',
    entries: [],
  };
  const rows: unknown[] = [];
  const client = new RemoteStreamClient(response, {
    onEvent: (event: RemoteStreamEvent) => {
      if (event.event === 'result') {
        const logsEvent = event as LogsStreamEvent;
        const data = logsEvent.data && typeof logsEvent.data === 'object' ? logsEvent.data as { result?: unknown } : {};
        result = data.result ?? {};
        return;
      }
      if (event.event === 'meta' || event.event === 'done') {
        Object.assign(payload, flattenLogsStreamEvent(event as LogsStreamEvent));
        return;
      }
      if (event.event === 'row') {
        const data = (event as LogsStreamEvent).data;
        if (data && typeof data === 'object') rows.push(data);
      }
    },
  });
  await client.readNDJSON();
  if (result !== undefined) return result;
  payload.entries = rows;
  if (rows.length === 0 && !payload.generated_at) throw new Error('ShellOrchestra logs stream did not return a result.');
  payload.raw_text = rows.map((row) => row && typeof row === 'object' && 'message' in row ? String((row as { message?: unknown }).message ?? '') : '').filter(Boolean).join('\n');
  return payload;
}

function flattenLogsStreamEvent(event: LogsStreamEvent): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'event' || key === 'transport' || key === 'entries') continue;
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
