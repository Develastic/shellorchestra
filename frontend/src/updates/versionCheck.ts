// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { apiFetch } from '../api/client';

export type VersionCheckStatus = 'disabled' | 'not_configured' | 'ok' | 'error';
export type InstallMethod = 'official' | 'manual' | 'windows_app' | 'unknown';

export type VersionCheckResult = {
  status: VersionCheckStatus;
  current_version: string;
  current_edition: string;
  channel: string;
  latest_version?: string;
  update_available: boolean;
  critical: boolean;
  minimum_supported?: string;
  release_notes_url?: string;
  one_click_available: boolean;
  manual_upgrade_required: boolean;
  install_method: InstallMethod;
  manual_upgrade_command?: string;
  manual_upgrade_url?: string;
  message: string;
  checked_at: string;
  artifacts?: string[];
};

export type UpgradeStartResult = {
  status: string;
  job_id?: string;
  message: string;
  target_version?: string;
};

export type UpgradeJobResult = {
  id: string;
  status: 'queued' | 'running' | 'applying' | 'completed' | 'failed' | string;
  message: string;
  channel: string;
  target_version: string;
  started_at: string;
  completed_at?: string;
  error?: string;
  log_tail?: string;
};

export async function getVersionCheck(): Promise<VersionCheckResult> {
  const response = await apiFetch('/api/system/version-check');
  if (!response.ok) throw new Error(await responseErrorMessage(response, 'Cannot check for ShellOrchestra updates.'));
  return (await response.json()) as VersionCheckResult;
}

export async function startUpgrade(): Promise<UpgradeStartResult> {
  const response = await apiFetch('/api/system/upgrade', { method: 'POST' });
  if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not start the upgrade.'));
  return (await response.json()) as UpgradeStartResult;
}

export async function getUpgradeJob(jobID: string): Promise<UpgradeJobResult> {
  const response = await apiFetch(`/api/system/upgrade/jobs/${encodeURIComponent(jobID)}`);
  if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not load upgrade progress.'));
  return (await response.json()) as UpgradeJobResult;
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: string; message?: string };
    return body.error || body.message || fallback;
  } catch {
    return fallback;
  }
}
