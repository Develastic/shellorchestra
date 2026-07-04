// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { DesktopScriptActionService } from '../shared';
import type { DesktopAppSandbox } from '../app-framework/sandbox';
import { ProcessKillDraft, ProcessListPayload } from './model';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';

export class ProcessMonitorService {
  readonly serverID: string;
  private readonly actions: DesktopScriptActionService;
  private readonly sandbox: DesktopAppSandbox;

  constructor(serverID: string, sandbox: DesktopAppSandbox) {
    this.serverID = serverID;
    this.sandbox = sandbox;
    this.sandbox.assertServerID(serverID);
    this.actions = new DesktopScriptActionService('process_monitor', serverID, sandbox, 'script-actions');
  }

  async list(limit = 100): Promise<ProcessListPayload> {
    const response = await this.sandbox.fetch('/api/desktop-apps/process_monitor/data-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: this.serverID, args: { process_limit: String(limit), process_stream_format: 'row_events' }, confirmed: false }),
      requiredCapability: 'processes',
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not stream process data from this server.'));
    return ProcessListPayload.fromUnknown(await readProcessListStream(response));
  }

  async kill(draft: ProcessKillDraft) {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    return this.actions.run('kill', draft.toArgs(), true);
  }
}

type ProcessStreamEvent = {
  event?: string;
  data?: unknown;
  error?: string;
};

async function readProcessListStream(response: Response): Promise<unknown> {
  let result: unknown;
  const payload: Record<string, unknown> = {
    generated_at: '',
    platform: 'unknown',
    source: 'unknown',
    processes: [],
  };
  const rows: unknown[] = [];
  const client = new RemoteStreamClient(response, {
    onEvent: (event: RemoteStreamEvent) => {
      if (event.event === 'result') {
        const data = event.data && typeof event.data === 'object' ? event.data as { result?: unknown } : {};
        result = data.result ?? {};
        return;
      }
      if (event.event === 'meta' || event.event === 'done') {
        Object.assign(payload, flattenProcessStreamEvent(event as ProcessStreamEvent));
        return;
      }
      if (event.event === 'row') {
        const data = (event as ProcessStreamEvent).data;
        if (data && typeof data === 'object') rows.push(data);
      }
    },
  });
  await client.readNDJSON();
  if (result !== undefined) return result;
  payload.processes = rows;
  return payload;
}

function flattenProcessStreamEvent(event: ProcessStreamEvent): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'event' || key === 'transport' || key === 'processes') continue;
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
