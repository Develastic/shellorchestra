// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import TextField, { type TextFieldProps } from '@mui/material/TextField';

export type CommittedNumberTextFieldProps = Omit<TextFieldProps, 'type' | 'value' | 'onChange'> & {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  selectOnFocus?: boolean;
};

export function CommittedNumberTextField({
  value,
  onValueChange,
  min,
  max,
  step = 1,
  integer = true,
  selectOnFocus = true,
  onBlur,
  onFocus,
  onKeyDown,
  slotProps,
  ...props
}: CommittedNumberTextFieldProps) {
  const focusedRef = useRef(false);
  const [draft, setDraft] = useState(formatNumberForInput(value, integer));

  useEffect(() => {
    if (!focusedRef.current) setDraft(formatNumberForInput(value, integer));
  }, [integer, value]);

  const commit = () => {
    const parsed = parseNumberDraft(draft, { integer, min, max });
    if (parsed === null) {
      setDraft(formatNumberForInput(value, integer));
      return;
    }
    const normalized = normalizeNumber(parsed, { integer, min, max });
    setDraft(formatNumberForInput(normalized, integer));
    if (!Object.is(normalized, value)) onValueChange(normalized);
  };

  const htmlInputSlotProps = typeof slotProps?.htmlInput === 'function' ? {} : (slotProps?.htmlInput ?? {});

  return (
    <TextField
      {...props}
      type="text"
      value={draft}
      onChange={(event) => {
        const next = event.target.value;
        if (isAllowedNumberDraft(next, { integer, min })) setDraft(next);
      }}
      onFocus={(event: FocusEvent<HTMLInputElement>) => {
        focusedRef.current = true;
        onFocus?.(event);
        if (!event.defaultPrevented && selectOnFocus) {
          window.setTimeout(() => {
            if (document.activeElement === event.target) event.target.select();
          }, 0);
        }
      }}
      onBlur={(event) => {
        focusedRef.current = false;
        commit();
        onBlur?.(event);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
          (event.target as HTMLInputElement | null)?.blur?.();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(formatNumberForInput(value, integer));
          (event.target as HTMLInputElement | null)?.blur?.();
          return;
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          const direction = event.key === 'ArrowUp' ? 1 : -1;
          const base = parseNumberDraft(draft, { integer, min, max }) ?? value;
          const next = normalizeNumber(base + direction * step, { integer, min, max });
          setDraft(formatNumberForInput(next, integer));
          if (!Object.is(next, value)) onValueChange(next);
          return;
        }
        onKeyDown?.(event);
      }}
      slotProps={{
        ...slotProps,
        htmlInput: {
          ...htmlInputSlotProps,
          inputMode: htmlInputSlotProps.inputMode ?? (integer ? 'numeric' : 'decimal'),
          role: htmlInputSlotProps.role ?? 'spinbutton',
          'aria-valuemin': htmlInputSlotProps['aria-valuemin'] ?? min,
          'aria-valuemax': htmlInputSlotProps['aria-valuemax'] ?? max,
          'aria-valuenow': htmlInputSlotProps['aria-valuenow'] ?? (draft.trim() === '' ? undefined : value),
          min: undefined,
          max: undefined,
          step: undefined,
        },
      }}
    />
  );
}

function isAllowedNumberDraft(value: string, { integer, min }: { integer: boolean; min?: number }) {
  if (value === '') return true;
  const sign = min !== undefined && min >= 0 ? '' : '-?';
  const pattern = integer
    ? new RegExp(`^${sign}\\d*$`)
    : new RegExp(`^${sign}\\d*(?:[.,]\\d*)?$`);
  return pattern.test(value);
}

function parseNumberDraft(value: string, options: { integer: boolean; min?: number; max?: number }): number | null {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '-' || trimmed === ',' || trimmed === '.') return null;
  const normalized = trimmed.replace(',', '.');
  const parsed = options.integer ? Number.parseInt(normalized, 10) : Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return normalizeNumber(parsed, options);
}

function normalizeNumber(value: number, { integer, min, max }: { integer: boolean; min?: number; max?: number }) {
  let next = integer ? Math.round(value) : value;
  if (typeof min === 'number' && Number.isFinite(min)) next = Math.max(min, next);
  if (typeof max === 'number' && Number.isFinite(max)) next = Math.min(max, next);
  return next;
}

function formatNumberForInput(value: number, integer: boolean) {
  if (!Number.isFinite(value)) return '';
  return integer ? String(Math.round(value)) : String(value);
}
