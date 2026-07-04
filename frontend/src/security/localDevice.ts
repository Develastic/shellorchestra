// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type DeviceKind = 'phone' | 'desktop' | 'browser';

export type LocalPasskeyIdentity = {
  device_id: string;
  label: string;
  kind: DeviceKind;
  credential_id: string;
  updated_at: string;
};

type AuthPayload = {
  principal?: {
    device_id: string;
    label: string;
    kind: DeviceKind;
  } | null;
  credential_id?: string | null;
};

const storageKey = 'shellorchestra.localPasskeyIdentity.v1';

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    mobile?: boolean;
    platform?: string;
    brands?: Array<{ brand: string; version: string }>;
  };
};

export function saveLocalPasskeyIdentity(identity: Omit<LocalPasskeyIdentity, 'updated_at'>) {
  if (!identity.device_id || !identity.credential_id) return;
  const record: LocalPasskeyIdentity = {
    ...identity,
    updated_at: new Date().toISOString(),
  };
  window.localStorage.setItem(storageKey, JSON.stringify(record));
}

export function saveLocalPasskeyIdentityFromAuth(payload: AuthPayload) {
  if (!payload.principal || !payload.credential_id) return;
  saveLocalPasskeyIdentity({
    device_id: payload.principal.device_id,
    label: payload.principal.label,
    kind: payload.principal.kind,
    credential_id: payload.credential_id,
  });
}

export function loadLocalPasskeyIdentity(): LocalPasskeyIdentity | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalPasskeyIdentity>;
    if (!parsed.device_id || !parsed.credential_id || !parsed.label || !parsed.kind) {
      return null;
    }
    return {
      device_id: parsed.device_id,
      credential_id: parsed.credential_id,
      label: parsed.label,
      kind: parsed.kind,
      updated_at: parsed.updated_at ?? '',
    };
  } catch {
    return null;
  }
}

export function passkeyLoginHint(): { device_id: string; credential_id: string } | undefined {
  const identity = loadLocalPasskeyIdentity();
  if (!identity) return undefined;
  return { device_id: identity.device_id, credential_id: identity.credential_id };
}

export function detectDeviceKind(): DeviceKind {
  if (isMobileDevice()) return 'phone';
  return 'desktop';
}

export function suggestedDeviceLabel(): string {
  const browser = browserName();
  const platform = platformName();
  if (platform) {
    return `${browser} on ${platform}`;
  }
  return `${browser} browser`;
}

function isMobileDevice(): boolean {
  const userAgentData = (navigator as NavigatorWithUserAgentData).userAgentData;
  if (typeof userAgentData?.mobile === 'boolean') {
    return userAgentData.mobile;
  }
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function browserName(): string {
  const userAgentData = (navigator as NavigatorWithUserAgentData).userAgentData;
  const brands = userAgentData?.brands?.map((item) => item.brand).filter((brand) => !/not/i.test(brand)) ?? [];
  if (brands.some((brand) => /Chrome/i.test(brand))) return 'Chrome';
  if (brands.some((brand) => /Edge/i.test(brand))) return 'Edge';
  if (brands.some((brand) => /Chromium/i.test(brand))) return 'Chromium';
  const ua = navigator.userAgent;
  if (/Firefox/i.test(ua)) return 'Firefox';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/Chrome|CriOS/i.test(ua)) return 'Chrome';
  if (/Safari/i.test(ua)) return 'Safari';
  return 'This';
}

function platformName(): string {
  const userAgentData = (navigator as NavigatorWithUserAgentData).userAgentData;
  const platform = userAgentData?.platform || navigator.platform || '';
  if (/Win/i.test(platform)) return 'Windows';
  if (/Mac/i.test(platform)) return 'macOS';
  if (/Linux/i.test(platform)) return 'Linux';
  if (/Android/i.test(platform)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(platform)) return 'iOS';
  return platform.trim();
}
