// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { UISettings } from './uiSettings';

export function browserLocale(): string {
  return navigator.languages?.[0] || navigator.language || Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function effectiveLocale(settings?: UISettings | null): string {
  return settings?.locale_override?.trim() || browserLocale();
}

export function effectiveTimeZone(settings?: UISettings | null): string {
  return settings?.timezone_override?.trim() || browserTimeZone();
}

export function formatLocalDateTime(value: string | null | undefined, settings?: UISettings | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const locale = effectiveLocale(settings);
  const timeZone = effectiveTimeZone(settings);
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(date);
  }
}

export function validateLocaleOverride(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    Intl.DateTimeFormat.supportedLocalesOf([trimmed]);
    new Intl.DateTimeFormat(trimmed).format(new Date());
    return null;
  } catch {
    return 'Use a browser locale tag such as en-US, uk-UA, de-DE, or leave this field empty.';
  }
}

export function validateTimeZoneOverride(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: trimmed }).format(new Date());
    return null;
  } catch {
    return 'Use an IANA timezone such as Europe/Kyiv, America/New_York, UTC, or leave this field empty.';
  }
}
