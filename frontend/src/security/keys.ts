// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { api } from '../api/client';
import { encryptDeviceShareForPublicKey } from './deviceEnvelopeVault';
import { saveDeviceShareAndUnlock } from './deviceShareVault';

export type KeyDevice = {
  device_id: string;
  label: string;
  kind: 'phone' | 'desktop' | 'browser';
  signer_epoch: number;
  envelope_key_available: boolean;
  envelope_public_key_spki_b64?: string | null;
};

export type InstallCommandTarget = {
  id: string;
  label: string;
  platform: string;
  remote_shell: 'posix' | 'powershell';
  local_command: string;
  authorized_key_line?: string;
};

export type InstallerMetadata = {
  script_url: string;
  expected_sha256_url: string;
  source_url: string;
};

export type KeysStatus = {
  initialized: boolean;
  auth_mode: 'passkey' | 'lan_totp' | 'unset';
  label?: string | null;
  public_key?: string | null;
  classic_public_key?: string | null;
  active_epoch: number;
  cert_ttl_minutes: number;
  install_command?: string | null;
  installer: InstallerMetadata;
  install_targets: InstallCommandTarget[];
  classic_install_targets: InstallCommandTarget[];
  current_device_id: string;
  current_device_kind: 'phone' | 'desktop' | 'browser';
  desktop_setup_allowed: boolean;
  windows_desktop_server?: boolean;
  local_protected_key_available?: boolean;
  devices: KeyDevice[];
};

export type KeysCreateResult = {
  initialized: boolean;
  auth_mode: 'passkey' | 'lan_totp';
  label?: string | null;
  public_key: string;
  classic_public_key: string;
  active_epoch: number;
  device_share_b64?: string | null;
  install_command: string;
  installer: InstallerMetadata;
  install_targets: InstallCommandTarget[];
  classic_install_targets: InstallCommandTarget[];
  windows_desktop_server?: boolean;
  local_protected_key_available?: boolean;
  devices: KeyDevice[];
};

export type KeysCreateInput = {
  label?: string;
  public_key?: string;
  private_key?: string;
  passphrase?: string;
  rotate_confirmed?: boolean;
  approval_id?: string;
  approval_poll_token?: string;
};

export type KeyChangeApprovalState = 'pending' | 'approved' | 'consumed' | 'denied';

export type KeyChangeApprovalBegin = {
  request_id: string;
  poll_token: string;
  verification_code: string;
  approve_url: string;
  state: KeyChangeApprovalState;
  expires_at: string;
};

export type KeyChangeApprovalStatus = {
  request_id: string;
  verification_code: string;
  state: KeyChangeApprovalState;
  approved_by_device_id?: string | null;
  expires_at: string;
};

export async function getKeysStatus(): Promise<KeysStatus> {
  const { data, error } = await api.GET('/keys/status');
  if (error || !data) {
    throw new Error('Cannot load server access keys.');
  }
  return data as KeysStatus;
}

export async function createKeys(input: KeysCreateInput): Promise<KeysCreateResult> {
  const { data, error } = await api.POST('/keys/create', { body: input });
  if (error || !data) {
    throw new Error('Cannot create server access keys.');
  }
  return data as KeysCreateResult;
}

export async function beginKeyChangeApproval(): Promise<KeyChangeApprovalBegin> {
  const { data, error } = await api.POST('/keys/change-approvals');
  if (error || !data) {
    throw new Error('Cannot start phone approval for this server-access key change.');
  }
  return data as KeyChangeApprovalBegin;
}

export async function getKeyChangeApprovalStatus(requestID: string, pollToken: string): Promise<KeyChangeApprovalStatus> {
  const { data, error } = await api.POST('/keys/change-approvals/{request_id}/status', {
    params: { path: { request_id: requestID } },
    body: { poll_token: pollToken },
  });
  if (error || !data) {
    throw new Error('Cannot check phone approval status. Start the key workflow again if this request expired.');
  }
  return data as KeyChangeApprovalStatus;
}

export async function approveKeyChange(requestID: string): Promise<KeyChangeApprovalStatus> {
  const { data, error } = await api.POST('/keys/change-approvals/{request_id}/approve', {
    params: { path: { request_id: requestID } },
  });
  if (error || !data) {
    throw new Error('Cannot approve this server-access key change. Use the primary approval phone and retry from the desktop Keys page.');
  }
  return data as KeyChangeApprovalStatus;
}

export async function storeDeviceShares(shares: { device_id: string; epoch: number; encrypted_device_share_b64: string }[]): Promise<void> {
  if (shares.length === 0) return;
  const { error } = await api.POST('/keys/device-shares', { body: { shares } });
  if (error) {
    throw new Error('Cannot store encrypted device key shares.');
  }
}

export async function saveAndDistributeDeviceShare(result: KeysCreateResult): Promise<string> {
  if (!result.device_share_b64) {
    return 'Server access key was created. LAN-only unlock uses the admin passphrase and authenticator code.';
  }
  const unlock = await saveDeviceShareAndUnlock(result.device_share_b64);
  const shares = [];
  for (const device of result.devices) {
    if (!device.envelope_public_key_spki_b64) continue;
    shares.push({
      device_id: device.device_id,
      epoch: result.active_epoch,
      encrypted_device_share_b64: await encryptDeviceShareForPublicKey(result.device_share_b64, device.envelope_public_key_spki_b64),
    });
  }
  await storeDeviceShares(shares);
  return `${unlock.message} Encrypted key shares were prepared for ${shares.length} authorized device${shares.length === 1 ? '' : 's'}.`;
}
