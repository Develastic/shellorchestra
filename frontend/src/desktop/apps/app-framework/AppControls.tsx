// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { CSSProperties, ElementType, ReactNode } from 'react';
import Button, { type ButtonProps } from '@mui/material/Button';
import IconButton, { type IconButtonProps } from '@mui/material/IconButton';
import TextField, { type TextFieldProps } from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import type { MenuProps } from '@mui/material/Menu';
import type { SelectProps } from '@mui/material/Select';
import type { SxProps, Theme } from '@mui/material/styles';
import { CommittedNumberTextField, type CommittedNumberTextFieldProps } from '../../../components/CommittedNumberTextField';

export const desktopControlHeightVariable = '--shellorchestra-desktop-control-height';
export const desktopWindowPaddingVariable = '--shellorchestra-desktop-window-padding';
export const desktopToolbarPaddingXVariable = '--shellorchestra-desktop-toolbar-padding-x';
export const desktopToolbarPaddingYVariable = '--shellorchestra-desktop-toolbar-padding-y';
export const desktopControlHeightFallback = 40;
export const desktopWindowPaddingFallback = 12;
export const desktopToolbarPaddingXFallback = 12;
export const desktopToolbarPaddingYFallback = 6;

export type DesktopAppButtonProps = ButtonProps & {
  component?: ElementType;
};

type DesktopAppButtonStyle = CSSProperties & Record<`--${string}`, string | number>;

export function DesktopAppButton({ sx, size: _size, style, ...props }: DesktopAppButtonProps) {
  const activeContainedTone = !props.disabled && props.variant === 'contained' ? desktopContainedButtonTone(props.color) : null;
  const activeContainedStyle: DesktopAppButtonStyle | undefined = activeContainedTone
    ? {
        '--shellorchestra-contained-button-bg': activeContainedTone.background,
        '--shellorchestra-contained-button-hover-bg': activeContainedTone.hoverBackground,
        '--shellorchestra-contained-button-color': activeContainedTone.color,
        backgroundColor: 'var(--shellorchestra-contained-button-bg)',
        borderColor: 'var(--shellorchestra-contained-button-bg)',
        boxShadow: activeContainedTone.boxShadow,
        color: 'var(--shellorchestra-contained-button-color)',
        fontWeight: 900,
      }
    : undefined;
  const disabledContainedSx: SxProps<Theme> | undefined = props.disabled && props.variant === 'contained'
      ? {
        '--variant-containedBg': 'rgba(27, 33, 26, 0.86)',
        '--variant-containedColor': 'rgba(222, 229, 217, 0.32)',
        backgroundColor: 'rgba(27, 33, 26, 0.86) !important',
        borderColor: 'rgba(132, 150, 126, 0.24) !important',
        boxShadow: 'none !important',
        color: 'rgba(222, 229, 217, 0.32) !important',
        cursor: 'not-allowed',
        opacity: 1,
      }
    : undefined;
  const disabledContainedStyle = props.disabled && props.variant === 'contained'
      ? {
        '--variant-containedBg': 'rgba(27, 33, 26, 0.86)',
        '--variant-containedColor': 'rgba(222, 229, 217, 0.32)',
        backgroundColor: 'rgba(27, 33, 26, 0.86)',
        borderColor: 'rgba(132, 150, 126, 0.24)',
        boxShadow: 'none',
        color: 'rgba(222, 229, 217, 0.32)',
        cursor: 'not-allowed',
        opacity: 1,
      }
    : undefined;
  return (
    <Button
      size="small"
      {...props}
      style={{ ...style, ...activeContainedStyle, ...disabledContainedStyle }}
      sx={composeSx(
        {
          minHeight: desktopControlHeightCSS(),
          height: desktopControlHeightCSS(),
          px: 1.25,
          py: 0,
          lineHeight: 1,
          alignItems: 'center',
          whiteSpace: 'nowrap',
          '&&.Mui-disabled': {
            borderColor: 'rgba(132, 150, 126, 0.24)',
            color: 'rgba(222, 229, 217, 0.32)',
            cursor: 'not-allowed',
            opacity: 1,
            transition: 'none',
          },
          '&&.MuiButton-contained:not(.Mui-disabled)': {
            fontWeight: 900,
            boxShadow: '0 0 10px rgba(114, 255, 112, 0.16)',
            '&:hover': {
              '--shellorchestra-contained-button-bg': 'var(--shellorchestra-contained-button-hover-bg)',
              boxShadow: '0 0 14px rgba(114, 255, 112, 0.22)',
            },
          },
          '&&.MuiButton-contained.MuiButton-colorSecondary:not(.Mui-disabled), &&.MuiButton-containedSecondary:not(.Mui-disabled)': {
            fontWeight: 900,
            '&:hover': {
              '--shellorchestra-contained-button-bg': 'var(--shellorchestra-contained-button-hover-bg)',
            },
          },
          '&&.MuiButton-contained.MuiButton-colorWarning:not(.Mui-disabled), &&.MuiButton-containedWarning:not(.Mui-disabled)': {
            fontWeight: 900,
            '&:hover': {
              '--shellorchestra-contained-button-bg': 'var(--shellorchestra-contained-button-hover-bg)',
            },
          },
          '&&.MuiButton-contained.MuiButton-colorError:not(.Mui-disabled), &&.MuiButton-containedError:not(.Mui-disabled)': {
            fontWeight: 900,
            '&:hover': {
              '--shellorchestra-contained-button-bg': 'var(--shellorchestra-contained-button-hover-bg)',
            },
          },
          '&&.MuiButton-contained.Mui-disabled, &&.MuiButton-containedPrimary.Mui-disabled, &&.MuiButton-containedWarning.Mui-disabled': {
            '--variant-containedBg': 'rgba(27, 33, 26, 0.86)',
            '--variant-containedColor': 'rgba(222, 229, 217, 0.32)',
            backgroundColor: 'rgba(27, 33, 26, 0.86) !important',
            borderColor: 'rgba(132, 150, 126, 0.24) !important',
            color: 'rgba(222, 229, 217, 0.32) !important',
            boxShadow: 'none',
            transition: 'none',
          },
        },
        sx,
        disabledContainedSx,
      )}
    />
  );
}

function desktopContainedButtonTone(color: ButtonProps['color'] | undefined) {
  switch (color) {
    case 'secondary':
      return {
        background: '#ffd393',
        hoverBackground: '#ffddaf',
        color: '#281800',
        boxShadow: '0 0 10px rgba(255, 211, 147, 0.14)',
      };
    case 'warning':
      return {
        background: '#ffba43',
        hoverBackground: '#ffd393',
        color: '#281800',
        boxShadow: '0 0 10px rgba(255, 186, 67, 0.16)',
      };
    case 'error':
      return {
        background: '#ffb4ab',
        hoverBackground: '#ffdad6',
        color: '#690005',
        boxShadow: '0 0 10px rgba(255, 180, 171, 0.14)',
      };
    case 'info':
      return {
        background: '#abc7ff',
        hoverBackground: '#d7e2ff',
        color: '#001b3f',
        boxShadow: '0 0 10px rgba(171, 199, 255, 0.14)',
      };
    case 'success':
      return {
        background: '#72ff70',
        hoverBackground: '#ebffe2',
        color: '#002203',
        boxShadow: '0 0 10px rgba(114, 255, 112, 0.16)',
      };
    case 'inherit':
      return {
        background: '#dee5d9',
        hoverBackground: '#f4fbef',
        color: '#0f150e',
        boxShadow: '0 0 10px rgba(222, 229, 217, 0.12)',
      };
    case 'primary':
    default:
      return {
        background: '#00ff41',
        hoverBackground: '#72ff70',
        color: '#002203',
        boxShadow: '0 0 10px rgba(114, 255, 112, 0.16)',
      };
  }
}

export type DesktopAppIconButtonProps = IconButtonProps & {
  tooltip?: ReactNode;
};

type DesktopAppMenuSlot = Record<string, unknown> & { sx?: SxProps<Theme> };

function desktopAppMenuSlotObject(slot: unknown): DesktopAppMenuSlot {
  if (typeof slot !== 'object' || slot === null || Array.isArray(slot)) return {};
  return slot as DesktopAppMenuSlot;
}

function desktopAppMenuSlotSx(slot: unknown): SxProps<Theme> | undefined {
  const slotObject = desktopAppMenuSlotObject(slot);
  return slotObject.sx;
}

export function desktopAppSelectMenuProps(overrides: Partial<MenuProps> = {}): Partial<MenuProps> {
  const rootSlot = overrides.slotProps?.root;
  const paperSlot = overrides.slotProps?.paper;
  return {
    transitionDuration: 0,
    ...overrides,
    slotProps: {
      ...overrides.slotProps,
      root: {
        ...desktopAppMenuSlotObject(rootSlot),
        sx: composeSx(
          {
            zIndex: 9200,
          },
          desktopAppMenuSlotSx(rootSlot),
        ),
      },
      paper: {
        ...desktopAppMenuSlotObject(paperSlot),
        sx: composeSx(
          {
            maxHeight: 'min(44vh, 360px)',
            border: '1px solid',
            borderColor: 'divider',
            bgcolor: '#0f150e',
            backgroundImage: 'none',
            boxShadow: '0 18px 52px rgba(0,0,0,0.62)',
            '& .MuiMenu-list': {
              bgcolor: '#0f150e',
            },
          },
          desktopAppMenuSlotSx(paperSlot),
        ),
      },
    },
  };
}

export function DesktopAppIconButton({ sx, tooltip, size: _size, children, ...props }: DesktopAppIconButtonProps) {
  const button = (
    <IconButton
      size="small"
      {...props}
      sx={composeSx(
        {
          width: desktopControlHeightCSS(),
          height: desktopControlHeightCSS(),
          minWidth: desktopControlHeightCSS(),
          minHeight: desktopControlHeightCSS(),
          borderRadius: 0.75,
        },
        sx,
      )}
    >
      {children}
    </IconButton>
  );
  if (!tooltip) return button;
  return (
    <Tooltip title={tooltip} arrow disableInteractive slotProps={{ tooltip: { sx: { pointerEvents: 'none' } } }}>
      <span>{button}</span>
    </Tooltip>
  );
}

export function DesktopAppTextField({ sx, size: _size, slotProps, ...props }: TextFieldProps) {
  const multiline = Boolean(props.multiline);
  const hasLabel = props.label !== undefined && props.label !== null && props.label !== '';
  const inputLabelSlotProps = (typeof slotProps?.inputLabel === 'function' ? {} : (slotProps?.inputLabel ?? {})) as Record<string, unknown>;
  const selectSlotProps = (typeof slotProps?.select === 'function' ? {} : (slotProps?.select ?? {})) as SelectProps;
  return (
    <TextField
      size="small"
      {...props}
      slotProps={{
        ...slotProps,
        inputLabel: {
          ...inputLabelSlotProps,
          shrink: typeof inputLabelSlotProps.shrink === 'boolean' ? inputLabelSlotProps.shrink : hasLabel,
        },
        ...(props.select
          ? {
              select: {
                ...selectSlotProps,
                MenuProps: desktopAppSelectMenuProps(selectSlotProps.MenuProps),
              },
            }
          : {}),
      }}
      sx={composeSx(
        {
          '& .MuiOutlinedInput-root': multiline
            ? {}
            : {
                minHeight: desktopControlHeightCSS(),
                height: desktopControlHeightCSS(),
                alignItems: 'center',
              },
          '& .MuiInputBase-input': multiline
            ? {}
            : {
                height: 'auto',
                py: 0,
                lineHeight: '1.35 !important',
              },
          '& .MuiInputLabel-root': {
            '&.Mui-focused:not(.Mui-error), &:hover:not(.Mui-error)': {
              color: 'primary.main',
            },
            '&.Mui-error': {
              color: 'error.main',
            },
          },
          '& .MuiOutlinedInput-root.Mui-focused:not(.Mui-error) .MuiOutlinedInput-notchedOutline, & .MuiOutlinedInput-root.Mui-focused:hover:not(.Mui-error) .MuiOutlinedInput-notchedOutline': {
            borderColor: 'primary.main',
          },
          '& .MuiOutlinedInput-root:hover:not(.Mui-focused):not(.Mui-error) .MuiOutlinedInput-notchedOutline': {
            borderColor: 'divider',
          },
          '& .MuiOutlinedInput-notchedOutline legend': hasLabel ? {} : { display: 'none' },
          '& .MuiSelect-select': multiline
            ? {}
            : {
                minHeight: '0 !important',
                display: 'flex',
                alignItems: 'center',
              },
        },
        sx,
      )}
    />
  );
}

export function DesktopAppNumberTextField({ sx, size: _size, slotProps, ...props }: CommittedNumberTextFieldProps) {
  return (
    <CommittedNumberTextField
      size="small"
      {...props}
      slotProps={slotProps}
      sx={composeSx(
        {
          '& .MuiOutlinedInput-root': {
            minHeight: desktopControlHeightCSS(),
            height: desktopControlHeightCSS(),
            alignItems: 'center',
          },
          '& .MuiInputBase-input': {
            height: 'auto',
            py: 0,
            lineHeight: '1.35 !important',
          },
          '& .MuiInputLabel-root': {
            '&.Mui-focused:not(.Mui-error), &:hover:not(.Mui-error)': {
              color: 'primary.main',
            },
            '&.Mui-error': {
              color: 'error.main',
            },
          },
          '& .MuiOutlinedInput-root.Mui-focused:not(.Mui-error) .MuiOutlinedInput-notchedOutline, & .MuiOutlinedInput-root.Mui-focused:hover:not(.Mui-error) .MuiOutlinedInput-notchedOutline': {
            borderColor: 'primary.main',
          },
          '& .MuiOutlinedInput-root:hover:not(.Mui-focused):not(.Mui-error) .MuiOutlinedInput-notchedOutline': {
            borderColor: 'divider',
          },
        },
        sx,
      )}
    />
  );
}

export function desktopControlHeightCSS() {
  return `var(${desktopControlHeightVariable}, ${desktopControlHeightFallback}px)`;
}

export function desktopWindowPaddingCSS() {
  return `var(${desktopWindowPaddingVariable}, ${desktopWindowPaddingFallback}px)`;
}

export function desktopToolbarPaddingXCSS() {
  return `var(${desktopToolbarPaddingXVariable}, ${desktopToolbarPaddingXFallback}px)`;
}

export function desktopToolbarPaddingYCSS() {
  return `var(${desktopToolbarPaddingYVariable}, ${desktopToolbarPaddingYFallback}px)`;
}

function composeSx(base: SxProps<Theme>, ...sxItems: Array<SxProps<Theme> | undefined>): SxProps<Theme> {
  const items = sxItems
    .filter((item): item is SxProps<Theme> => Boolean(item))
    .flatMap((item) => Array.isArray(item) ? item : [item]);
  if (items.length === 0) return base;
  return [base, ...items] as SxProps<Theme>;
}
