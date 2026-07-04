// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { components } from '../../api/schema';
import type { DesktopAppCapability, DesktopAppSandbox } from './app-framework/sandbox';

export function AppFact({ label, value, action }: { label: string; value: string; action?: ReactNode }) {
  const displayValue = value || '—';
  return (
    <Box sx={{ p: 1, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.46)' }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
        <Typography title={displayValue} sx={{ flex: 1, minWidth: 0, fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayValue}</Typography>
        {action}
      </Box>
    </Box>
  );
}

export function apiErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const candidate = error as { error?: unknown; message?: unknown };
  if (typeof candidate.error === 'string') return candidate.error;
  if (typeof candidate.message === 'string') return candidate.message;
  return '';
}

export function firstText(...values: string[]): string {
  return values.map((value) => value.trim()).find(Boolean) ?? '—';
}

export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function formatBytesCompact(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  const precision = current >= 100 || unit === 0 ? 0 : current >= 10 ? 1 : 2;
  return `${current.toFixed(precision)} ${units[unit]}`;
}

export type ScriptRun = components['schemas']['ScriptRun'];
export type DesktopAppActionResponse = components['schemas']['DesktopAppActionResponse'];

export class DesktopScriptActionService {
  readonly appID: string;
  readonly serverID: string;
  readonly requiredCapability: DesktopAppCapability;
  private readonly sandbox: DesktopAppSandbox;

  constructor(appID: string, serverID: string, sandbox: DesktopAppSandbox, requiredCapability: DesktopAppCapability) {
    this.appID = appID;
    this.serverID = serverID;
    this.sandbox = sandbox;
    this.requiredCapability = requiredCapability;
    this.sandbox.assertServerID(serverID);
    if (this.sandbox.appID !== appID) {
      throw new Error(`Desktop app service ${appID} cannot use sandbox for ${this.sandbox.appID}.`);
    }
  }

  async run(action: string, args: Record<string, string>, confirmed: boolean): Promise<DesktopAppActionResponse> {
    return this.sandbox.runAction(action, args, this.requiredCapability, confirmed);
  }

  async runStatus(runID: string): Promise<ScriptRun> {
    return this.sandbox.runStatus(runID, this.requiredCapability);
  }

  async waitForRun(runID: string, timeoutMs = 60000, pollMs = 900): Promise<ScriptRun> {
    const started = Date.now();
    for (;;) {
      const run = await this.runStatus(runID);
      if (run.state === 'succeeded' || run.state === 'failed') return run;
      if (Date.now() - started > timeoutMs) throw new Error('The server-side operation did not finish in time.');
      await new Promise((resolve) => window.setTimeout(resolve, pollMs));
    }
  }
}
