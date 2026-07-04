// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { api } from '../api/client';
import { ensureDeviceSigningKeyRegistered } from './requestSigning';

export type AddressAssessment = {
  canUsePasskeys: boolean;
  title: string;
  summary: string;
  details: string[];
};

const privateIPv4Ranges = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./,
];

function isIPAddress(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isPrivateIPv4(hostname: string): boolean {
  return privateIPv4Ranges.some((pattern) => pattern.test(hostname));
}

export function assessPasskeyAddress(locationLike: Location = window.location): AddressAssessment {
  const hostname = locationLike.hostname.toLowerCase();
  const details: string[] = [];

  if (!window.isSecureContext) {
    details.push('This browser does not treat the current page as a secure context. Passkeys require HTTPS with a certificate trusted by the browser, except for localhost developer testing.');
  }
  if (locationLike.protocol !== 'https:' && !isLocalhost(hostname)) {
    details.push('The current address uses plain HTTP. Passkeys are not available on plain HTTP for LAN IPs or normal hostnames.');
  }
  if (isLocalhost(hostname)) {
    details.push('Localhost is accepted by browsers only for developer testing on the same machine. A phone cannot open your desktop localhost address from the QR code.');
  }
  if (isIPAddress(hostname)) {
    details.push('The current host is an IP address. Passkeys are bound to a website name, so private IP access should use LAN-only one-time-code sign-in instead.');
  } else if (isPrivateIPv4(hostname)) {
    details.push('The current host is a private LAN address. Use LAN-only mode unless this address has a trusted HTTPS certificate and a stable local DNS name.');
  }

  if (details.length === 0) {
    return {
      canUsePasskeys: true,
      title: 'This address can use passkeys.',
      summary: 'ShellOrchestra can show a phone pairing QR code for passkey setup.',
      details: ['The page is running in a secure browser context and is not a localhost/private-IP pairing URL.'],
    };
  }

  return {
    canUsePasskeys: false,
    title: 'THIS ADDRESS CANNOT USE PASSKEYS.',
    summary: 'Choose LAN-only setup here. ShellOrchestra will use an authenticator app code plus an admin passphrase instead of passkeys.',
    details,
  };
}

type APIError = { error?: string };

async function postJSON<TResponse>(url: string, body: unknown): Promise<TResponse> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as APIError;
    throw new Error(typeof payload.error === 'string' ? payload.error : `Request failed: ${response.status}`);
  }
  return response.json() as Promise<TResponse>;
}

export type LANSetupBeginResponse = {
  secret: string;
  otpauth_url: string;
  expires_at: string;
};

export type LANAuthResponse = {
  principal: { device_id: string; label: string; kind: 'phone' | 'desktop' | 'browser'; can_approve_device_requests: boolean };
  lock_state: { locked: boolean; message: string };
  public_key?: string | null;
};

export function bootstrapTokenFromQrURL(qrUrl?: string | null): string {
  if (!qrUrl) return '';
  try {
    const parsed = new URL(qrUrl);
    const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
    return new URLSearchParams(hash).get('token')?.trim() ?? '';
  } catch {
    return '';
  }
}

export async function beginLANOnlySetup(bootstrapToken: string): Promise<LANSetupBeginResponse> {
  return postJSON<LANSetupBeginResponse>('/api/auth/lan/setup/begin', { bootstrap_token: bootstrapToken });
}

export async function finishLANOnlySetup(bootstrapToken: string, passphrase: string, totpCode: string): Promise<LANAuthResponse> {
  const result = await postJSON<LANAuthResponse>('/api/auth/lan/setup/finish', { bootstrap_token: bootstrapToken, passphrase, totp_code: totpCode });
  await ensureDeviceSigningKeyRegistered(result.principal.device_id);
  return result;
}

export async function loginLANOnly(passphrase: string, totpCode: string): Promise<LANAuthResponse> {
  const result = await postJSON<LANAuthResponse>('/api/auth/lan/login', { passphrase, totp_code: totpCode });
  await ensureDeviceSigningKeyRegistered(result.principal.device_id);
  return result;
}

export async function logoutSession() {
  const { error } = await api.POST('/auth/logout');
  if (error) throw new Error('Logout failed');
}
