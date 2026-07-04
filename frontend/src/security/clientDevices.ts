// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { api } from '../api/client';
import { registerDeviceEnvelopeKey } from './deviceEnvelopeVault';
import { publishCurrentDeviceShareIfAvailable } from './deviceShareVault';
import { ensureDeviceSigningKeyRegistered } from './requestSigning';

export type ClientDeviceKind = 'phone' | 'desktop' | 'browser';

export type ClientDeviceKeyStatus =
  | 'current'
  | 'add_again'
  | 'outdated'
  | 'missing'
  | 'not_configured'
  | 'not_required';

export type ClientDeviceKeyDistribution = {
  status: ClientDeviceKeyStatus;
  label: string;
  detail: string;
  device_epoch: number;
  active_epoch: number;
  updated_at?: string | null;
};

export type ClientDevice = {
  device_id: string;
  label: string;
  kind: ClientDeviceKind;
  current_device: boolean;
  can_approve_new_devices: boolean;
  can_revoke: boolean;
  revoke_blocker?: string | null;
  approved_at?: string | null;
  last_login_at?: string | null;
  last_login_ip?: string | null;
  active_session_count: number;
  passkey_ready: boolean;
  request_protection_ready: boolean;
  key_distribution: ClientDeviceKeyDistribution;
};

export type ClientDevicesResponse = {
  devices: ClientDevice[];
  current_device_id: string;
  key_authority_initialized: boolean;
  active_epoch: number;
  auth_mode: 'unset' | 'passkey' | 'lan_totp';
};

export async function listClientDevices(): Promise<ClientDevicesResponse> {
  const { data, error } = await api.GET('/devices');
  if (error || !data) {
    throw new Error('Cannot load client devices.');
  }
  return data as ClientDevicesResponse;
}

export async function revokeClientDevice(deviceID: string): Promise<string> {
  const { data, error } = await api.POST('/devices/{device_id}/revoke', {
    params: { path: { device_id: deviceID } },
  });
  if (error || !data) {
    const message = typeof error === 'object' && error !== null && 'error' in error && typeof error.error === 'string'
      ? error.error
      : 'Cannot revoke this client device.';
    throw new Error(message);
  }
  return data.message;
}

export async function updateCurrentDeviceProtection(): Promise<string> {
  await ensureDeviceSigningKeyRegistered();
  await registerDeviceEnvelopeKey();
  const storedCurrentShare = await publishCurrentDeviceShareIfAvailable();
  if (storedCurrentShare) {
    return 'This trusted device updated itself automatically and saved its encrypted server-access key delivery copy.';
  }
  return 'This trusted device updated browser protection automatically. The next desktop key workflow approved on the primary phone can send this device the current server-access key share.';
}
