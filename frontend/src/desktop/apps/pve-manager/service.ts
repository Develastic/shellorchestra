// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { DesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopScriptActionService } from '../shared';
import { PVEGuestActionDraft, PVEManagerPayload } from './model';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';

export class PVEManagerService {
  readonly serverID: string;
  private readonly sandbox: DesktopAppSandbox;
  private readonly actions: DesktopScriptActionService;
  constructor(serverID: string, sandbox: DesktopAppSandbox) {
    this.serverID = serverID;
    this.sandbox = sandbox;
    this.sandbox.assertServerID(serverID);
    this.actions = new DesktopScriptActionService('pve_manager', serverID, sandbox, 'script-actions');
  }
  async load(): Promise<PVEManagerPayload> {
    const response = await this.sandbox.fetch('/api/desktop-apps/pve_manager/data-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: this.serverID, args: { pve_manager_stream_format: 'row_events' }, confirmed: false }),
      requiredCapability: 'pve',
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not stream Proxmox VE data from this server.'));
    return PVEManagerPayload.fromUnknown(await readPVEManagerStream(response));
  }
  async act(draft: PVEGuestActionDraft) {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    return this.actions.run(draft.action, draft.toArgs(), true);
  }
}

type PVEManagerStreamEvent = {
  event?: string;
  data?: unknown;
  error?: string;
};

async function readPVEManagerStream(response: Response): Promise<unknown> {
  let result: unknown;
  const payload: Record<string, unknown> = {
    available: false,
    is_pve: false,
    message: '',
    source: 'pvesh',
    node: '',
    generated_at: '',
    resources: [],
    node_status: {},
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
        Object.assign(payload, flattenPVEManagerStreamEvent(event as PVEManagerStreamEvent));
        return;
      }
      if (event.event === 'row') {
        const data = (event as PVEManagerStreamEvent).data;
        if (data && typeof data === 'object') rows.push(data);
      }
    },
  });
  await client.readNDJSON();
  if (result !== undefined) return result;
  payload.resources = rows;
  return payload;
}

function flattenPVEManagerStreamEvent(event: PVEManagerStreamEvent): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'event' || key === 'transport' || key === 'resources') continue;
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
