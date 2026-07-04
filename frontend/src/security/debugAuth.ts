// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { ensureDeviceSigningKeyRegistered } from './requestSigning';
import { registerDeviceEnvelopeKey } from './deviceEnvelopeVault';
const debugTokenStorageKey = 'shellorchestra.debugAuthToken.v1';

export type DebugLoginResponse = {
  principal: { device_id: string; label: string; kind: 'phone' | 'desktop' | 'browser'; can_approve_device_requests: boolean };
};

type APIError = { error?: string };

export function consumeDebugTokenFromURL(): boolean {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const token = new URLSearchParams(hash).get('token')?.trim();
  if (!token) return false;
  window.localStorage.setItem(debugTokenStorageKey, token);
  window.history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`);
  return true;
}

export function hasStoredDebugToken(): boolean {
  return (window.localStorage.getItem(debugTokenStorageKey)?.trim() ?? '') !== '';
}

export function storedDebugToken(): string {
  return window.localStorage.getItem(debugTokenStorageKey)?.trim() ?? '';
}

export async function debugLoginWithStoredToken(): Promise<DebugLoginResponse> {
  const token = storedDebugToken();
  if (!token) {
    throw new Error('Debug sign-in token is missing from this browser profile. Open the current debug sign-in link again.');
  }
  const response = await fetch('/api/auth/debug/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as APIError;
    throw new Error(typeof payload.error === 'string' ? payload.error : `Debug sign-in failed: ${response.status}`);
  }
  const result = await response.json() as DebugLoginResponse;
  await ensureDeviceSigningKeyRegistered(result.principal.device_id);
  await registerDeviceEnvelopeKey();
  return result;
}
