// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { startAuthentication, startRegistration, WebAuthnAbortService } from '@simplewebauthn/browser';
import { passkeyLoginHint, saveLocalPasskeyIdentityFromAuth } from './localDevice';
import { ensureDeviceSigningKeyRegistered } from './requestSigning';
import { ensureDeviceEnvelopeKey, registerDeviceEnvelopeKey } from './deviceEnvelopeVault';

export type BeginPasskeyResponse = {
  ceremony_id: string;
  options: unknown;
  expires_at: string;
};

export type PasskeyFinishResponse = {
  principal: { device_id: string; label: string; kind: 'phone' | 'desktop' | 'browser'; can_approve_device_requests: boolean };
  credential_id?: string | null;
  device_share_b64?: string | null;
  public_key?: string | null;
};

const csrfCookieName = 'shellorchestra_csrf';
const csrfHeaderName = 'X-ShellOrchestra-CSRF';
const webAuthnTimeoutMs = 120_000;

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

async function postJSON<TResponse>(url: string, body?: unknown): Promise<TResponse> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const csrfToken = readCookie(csrfCookieName);
  if (csrfToken) {
    headers.set(csrfHeaderName, decodeURIComponent(csrfToken));
  }
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(typeof payload.error === 'string' ? payload.error : `Request failed: ${response.status}`);
  }
  return response.json() as Promise<TResponse>;
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
      reject(new Error(`${action} did not complete within two minutes. If no browser passkey prompt appeared, retry in a regular Chrome window with phone/QR passkey support.`));
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

export async function registerPasskey(label: string, kind: 'phone' | 'desktop' | 'browser', bootstrapToken?: string) {
  const envelopePublicKeySPKIB64 = await ensureDeviceEnvelopeKey();
  const begin = await postJSON<BeginPasskeyResponse>('/api/auth/passkey/register/begin', { label, kind, bootstrap_token: bootstrapToken, envelope_public_key_spki_b64: envelopePublicKeySPKIB64 });
  const attestation = await withWebAuthnTimeout(
    startRegistration({ optionsJSON: unwrapPublicKeyOptions(begin.options) as never }),
    'Passkey registration',
  );
  const result = await postJSON<PasskeyFinishResponse>(`/api/auth/passkey/register/finish?ceremony_id=${encodeURIComponent(begin.ceremony_id)}`, attestation);
  saveLocalPasskeyIdentityFromAuth(result);
  await ensureDeviceSigningKeyRegistered(result.principal.device_id);
  return result;
}

export async function loginWithPasskey() {
  const begin = await postJSON<BeginPasskeyResponse>('/api/auth/passkey/login/begin', passkeyLoginHint());
  const assertion = await withWebAuthnTimeout(
    startAuthentication({ optionsJSON: unwrapPublicKeyOptions(begin.options) as never }),
    'Passkey sign in',
  );
  const result = await postJSON<PasskeyFinishResponse>(`/api/auth/passkey/login/finish?ceremony_id=${encodeURIComponent(begin.ceremony_id)}`, assertion);
  saveLocalPasskeyIdentityFromAuth(result);
  await ensureDeviceSigningKeyRegistered(result.principal.device_id);
  await registerDeviceEnvelopeKey();
  return result;
}
