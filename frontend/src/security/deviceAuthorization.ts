// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { startRegistration, WebAuthnAbortService } from '@simplewebauthn/browser';
import { loadDeviceShare, saveDeviceShareAndUnlock, syncDeviceShareFromServer, type RuntimeUnlockDebugOptions } from './deviceShareVault';
import { type DeviceKind as LocalDeviceKind } from './localDevice';
import { ensureDeviceSigningKeyRegistered, signRequestInit } from './requestSigning';
import { decryptDeviceShare, ensureDeviceEnvelopeKey, encryptDeviceShareForPublicKey } from './deviceEnvelopeVault';

const csrfCookieName = 'shellorchestra_csrf';
const csrfHeaderName = 'X-ShellOrchestra-CSRF';
const webAuthnTimeoutMs = 120_000;

export type DeviceKind = LocalDeviceKind;

export type DeviceAuthorizationRequest = {
  id: string;
  label: string;
  kind: DeviceKind;
  verification_code: string;
  envelope_public_key_spki_b64: string;
  state: 'pending' | 'approved' | 'denied';
  created_at: string;
  expires_at: string;
};

export type DeviceRequestCreated = {
  request_id: string;
  poll_token: string;
  verification_code: string;
  state: 'pending';
  expires_at: string;
};

export type DeviceRequestStatus = {
  request_id: string;
  state: 'pending' | 'approved' | 'denied';
  verification_code: string;
  encrypted_device_share_b64?: string | null;
  device_id?: string | null;
  label?: string | null;
  kind?: DeviceKind | null;
  credential_id?: string | null;
  expires_at: string;
};

type BeginPasskeyResponse = {
  ceremony_id: string;
  options: unknown;
  expires_at: string;
};

type APIError = { error?: string };

function emitDeviceAuthorizationDebug(debug: RuntimeUnlockDebugOptions | undefined, step: string, message: string, details?: Record<string, unknown>) {
  if (!debug?.enabled) return;
  debug.onEvent?.({ at: new Date().toISOString(), step, message, details });
}

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

async function requestJSON<TResponse>(url: string, init?: RequestInit): Promise<TResponse> {
  const headers = new Headers(init?.headers);
  const csrfToken = readCookie(csrfCookieName);
  if (csrfToken && (init?.method ?? 'GET').toUpperCase() !== 'GET') {
    headers.set(csrfHeaderName, decodeURIComponent(csrfToken));
  }
  const signedInit = await signRequestInit(url, {
    ...init,
    credentials: 'include',
    headers,
  });
  const response = await fetch(url, signedInit);
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as APIError;
    throw new Error(typeof payload.error === 'string' ? payload.error : `Request failed: ${response.status}`);
  }
  if (response.status === 204) {
    return undefined as TResponse;
  }
  return response.json() as Promise<TResponse>;
}

async function postJSON<TResponse>(url: string, body?: unknown): Promise<TResponse> {
  return requestJSON<TResponse>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function unwrapPublicKeyOptions(options: unknown): unknown {
  if (options && typeof options === 'object' && 'publicKey' in options) {
    return (options as { publicKey: unknown }).publicKey;
  }
  return options;
}

async function withWebAuthnTimeout<T>(operation: Promise<T>, action: string): Promise<T> {
  let timeoutID: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutID = setTimeout(() => {
      WebAuthnAbortService.cancelCeremony();
      reject(new Error(`${action} did not complete within two minutes. If no browser passkey prompt appeared, retry in a regular browser profile with passkey support.`));
    }, webAuthnTimeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutID !== undefined) {
      clearTimeout(timeoutID);
    }
  }
}

function requireAuthorizationCrypto() {
  if (!('indexedDB' in window) || !window.indexedDB) {
    throw new Error('Device authorization needs browser storage. Enable site storage and retry.');
  }
  if (!window.crypto?.subtle) {
    throw new Error('Device authorization needs WebCrypto. Open ShellOrchestra over trusted HTTPS and retry.');
  }
}

export async function requestDeviceAuthorization(label: string, kind: DeviceKind): Promise<DeviceRequestCreated> {
  requireAuthorizationCrypto();
  const envelopePublicKeySPKIB64 = await ensureDeviceEnvelopeKey();
  const begin = await postJSON<BeginPasskeyResponse>('/api/auth/device-requests/register/begin', {
    label,
    kind,
    envelope_public_key_spki_b64: envelopePublicKeySPKIB64,
  });
  const attestation = await withWebAuthnTimeout(
    startRegistration({ optionsJSON: unwrapPublicKeyOptions(begin.options) as never }),
    'New-device passkey registration',
  );
  const created = await postJSON<DeviceRequestCreated>(`/api/auth/device-requests/register/finish?ceremony_id=${encodeURIComponent(begin.ceremony_id)}`, attestation);
  return created;
}

export async function getDeviceAuthorizationStatus(requestID: string, pollToken: string): Promise<DeviceRequestStatus> {
  return postJSON<DeviceRequestStatus>(`/api/auth/device-requests/${encodeURIComponent(requestID)}/status`, { poll_token: pollToken });
}

export async function acceptApprovedDeviceRequest(requestID: string, encryptedDeviceShareB64: string, debug?: RuntimeUnlockDebugOptions) {
  emitDeviceAuthorizationDebug(debug, 'device-authorization.accept.start', 'Processing an approved device authorization response in this browser.');
  await ensureDeviceSigningKeyRegistered();
  void requestID;
  if (encryptedDeviceShareB64.trim() === '') {
    emitDeviceAuthorizationDebug(debug, 'device-authorization.accept.no-share', 'The approval response did not include a server-access key share.');
    return {
      unlocked: false,
      message: 'This device is authorized. Server access keys are not initialized yet; open Keys from a desktop browser to finish setup.',
    };
  }
  try {
    const deviceShare = await decryptDeviceShare(encryptedDeviceShareB64);
    emitDeviceAuthorizationDebug(debug, 'device-authorization.accept.decrypt.ok', 'This browser decrypted the delivered server-access key share.');
    return saveDeviceShareAndUnlock(deviceShare, debug);
  } catch (error) {
    emitDeviceAuthorizationDebug(debug, 'device-authorization.accept.decrypt.failed', 'This browser could not decrypt the delivered server-access key share.', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

export async function listDeviceAuthorizationRequests(): Promise<DeviceAuthorizationRequest[]> {
  const payload = await requestJSON<{ requests: DeviceAuthorizationRequest[] }>('/api/device-requests');
  return payload.requests;
}

export async function approveDeviceAuthorizationRequest(request: DeviceAuthorizationRequest, debug?: RuntimeUnlockDebugOptions): Promise<DeviceAuthorizationRequest> {
  emitDeviceAuthorizationDebug(debug, 'device-authorization.approve.start', 'Approving a new device request and preparing encrypted server-access key delivery.', { requestKind: request.kind });
  const deviceShare = await loadDeviceShare(debug) ?? await syncDeviceShareFromServer(debug);
  if (!deviceShare) {
    emitDeviceAuthorizationDebug(debug, 'device-authorization.approve.no-share', 'This approval device has no current server-access key share to deliver.');
    return postJSON<DeviceAuthorizationRequest>(`/api/device-requests/${encodeURIComponent(request.id)}/approve`, {
      encrypted_device_share_b64: '',
    });
  }
  const encryptedShare = await encryptDeviceShareForPublicKey(deviceShare, request.envelope_public_key_spki_b64);
  emitDeviceAuthorizationDebug(debug, 'device-authorization.approve.encrypt.ok', 'Encrypted the current server-access key share for the new device.');
  const approved = await postJSON<DeviceAuthorizationRequest>(`/api/device-requests/${encodeURIComponent(request.id)}/approve`, {
    encrypted_device_share_b64: encryptedShare,
  });
  emitDeviceAuthorizationDebug(debug, 'device-authorization.approve.saved', 'The backend accepted the device approval with encrypted key delivery.');
  return approved;
}

export async function denyDeviceAuthorizationRequest(requestID: string): Promise<void> {
  await postJSON<void>(`/api/device-requests/${encodeURIComponent(requestID)}/deny`);
}
