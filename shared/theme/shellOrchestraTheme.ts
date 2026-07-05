// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export const shellOrchestraColors = {
  terminalGreen: '#00ff41',
  terminalGreenLight: '#72ff70',
  terminalGreenDark: '#00b82d',
  terminalGreenContrast: '#002203',
  surface: '#0f150e',
  surfaceDim: '#0a1009',
  surfaceContainer: '#1b211a',
  surfaceContainerHigh: '#252c24',
  surfaceVariant: '#30372f',
  outlineVariant: '#3b4b37',
  textPrimary: '#dee5d9',
  textSecondary: '#b9ccb2',
  secondary: '#ffd393',
  secondaryLight: '#ffddaf',
  secondaryDark: '#fdaf00',
  secondaryContrast: '#281800',
  error: '#ffb4ab',
  errorDark: '#93000a',
  errorContrast: '#690005',
  warning: '#ffba43',
  info: '#abc7ff',
  infoContrast: '#001b3f',
} as const;

export const shellOrchestraFonts = {
  appFontFamily: ['"Segoe UI"', 'Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Helvetica Neue"', 'Arial', 'sans-serif'].join(','),
  marketingFontFamily: 'var(--font-ui), "Segoe UI", Inter, system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif',
  monoFontFamily: ['"Iosevka"', '"Iosevka Term"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'].join(','),
  marketingMonoFontFamily: 'var(--font-mono), "Iosevka", "Iosevka Term", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;

export const shellOrchestraAppThemeOptions = {
  palette: {
    mode: 'dark',
    primary: {
      main: shellOrchestraColors.terminalGreen,
      light: shellOrchestraColors.terminalGreenLight,
      dark: shellOrchestraColors.terminalGreenDark,
      contrastText: shellOrchestraColors.terminalGreenContrast,
    },
    secondary: {
      main: shellOrchestraColors.secondary,
      light: shellOrchestraColors.secondaryLight,
      dark: shellOrchestraColors.secondaryDark,
      contrastText: shellOrchestraColors.secondaryContrast,
    },
    error: {
      main: shellOrchestraColors.error,
      dark: shellOrchestraColors.errorDark,
      contrastText: shellOrchestraColors.errorContrast,
    },
    warning: {
      main: shellOrchestraColors.warning,
      contrastText: shellOrchestraColors.secondaryContrast,
    },
    info: {
      main: shellOrchestraColors.info,
      contrastText: shellOrchestraColors.infoContrast,
    },
    success: {
      main: shellOrchestraColors.terminalGreen,
      contrastText: shellOrchestraColors.terminalGreenContrast,
    },
    background: {
      default: shellOrchestraColors.surface,
      paper: shellOrchestraColors.surfaceContainer,
    },
    text: {
      primary: shellOrchestraColors.textPrimary,
      secondary: shellOrchestraColors.textSecondary,
    },
    divider: shellOrchestraColors.outlineVariant,
  },
  shape: { borderRadius: 4 },
  typography: {
    fontFamily: shellOrchestraFonts.appFontFamily,
    h4: {
      fontWeight: 800,
      letterSpacing: '-0.02em',
    },
    h5: {
      fontWeight: 800,
      letterSpacing: '-0.01em',
    },
    h6: {
      fontWeight: 800,
    },
    button: {
      fontFamily: shellOrchestraFonts.appFontFamily,
      fontWeight: 800,
      letterSpacing: '0.015em',
      textTransform: 'none',
      fontSize: '0.86rem',
    },
    caption: {
      fontFamily: shellOrchestraFonts.monoFontFamily,
      letterSpacing: '0.06em',
    },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        ':root': {
          colorScheme: 'dark',
          '--font-mono': shellOrchestraFonts.monoFontFamily,
        },
        '*': {
          boxSizing: 'border-box',
        },
        '::selection': {
          backgroundColor: shellOrchestraColors.terminalGreen,
          color: shellOrchestraColors.terminalGreenContrast,
        },
        body: {
          minHeight: '100vh',
          background: shellOrchestraColors.surface,
          color: shellOrchestraColors.textPrimary,
          scrollbarGutter: 'stable',
        },
        '#root': {
          minHeight: '100vh',
        },
        '::-webkit-scrollbar': {
          width: 8,
          height: 8,
        },
        '::-webkit-scrollbar-track': {
          background: shellOrchestraColors.surface,
        },
        '::-webkit-scrollbar-thumb': {
          background: shellOrchestraColors.surfaceVariant,
          borderRadius: 4,
        },
        '::-webkit-scrollbar-thumb:hover': {
          background: '#84967e',
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: shellOrchestraColors.surfaceContainerHigh,
          borderBottom: `1px solid ${shellOrchestraColors.outlineVariant}`,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: shellOrchestraColors.surfaceContainer,
          borderColor: shellOrchestraColors.outlineVariant,
        },
      },
    },
    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
      styleOverrides: {
        root: {
          borderRadius: 2,
          minHeight: 40,
          paddingTop: 8,
          paddingBottom: 8,
        },
        sizeSmall: {
          minHeight: 32,
          paddingTop: 5,
          paddingBottom: 5,
        },
      },
    },
    MuiPopover: {
      defaultProps: {
        disableScrollLock: true,
      },
    },
    MuiMenu: {
      defaultProps: {
        disableScrollLock: true,
      },
    },
    MuiTextField: {
      defaultProps: {
        size: 'small',
      },
      styleOverrides: {
        root: {
          '&:hover .MuiInputLabel-root:not(.Mui-error)': {
            color: `${shellOrchestraColors.terminalGreen} !important`,
          },
        },
      },
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          '&.MuiInputLabel-shrink': {
            backgroundColor: 'transparent',
            paddingInline: 0,
            marginLeft: 0,
            zIndex: 1,
          },
          '.MuiFormControl-root:hover &': {
            color: `${shellOrchestraColors.terminalGreen} !important`,
          },
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: shellOrchestraColors.surfaceContainerHigh,
          borderRadius: 2,
          minHeight: 40,
          '& fieldset': {
            borderColor: shellOrchestraColors.outlineVariant,
          },
          '&:hover .MuiOutlinedInput-notchedOutline': {
            borderColor: `${shellOrchestraColors.outlineVariant} !important`,
          },
          '&:hover fieldset': {
            borderColor: `${shellOrchestraColors.outlineVariant} !important`,
          },
          '&.Mui-focused fieldset': {
            borderColor: shellOrchestraColors.terminalGreen,
          },
          '&.Mui-focused:hover .MuiOutlinedInput-notchedOutline': {
            borderColor: shellOrchestraColors.terminalGreen,
          },
          '& .MuiOutlinedInput-notchedOutline legend > span': {
            paddingLeft: 8,
            paddingRight: 12,
          },
        },
        input: {
          paddingTop: 10,
          paddingBottom: 10,
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderColor: 'rgba(59, 75, 55, 0.72)',
        },
        head: {
          fontFamily: shellOrchestraFonts.monoFontFamily,
          fontSize: '0.68rem',
          fontWeight: 800,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: shellOrchestraColors.textSecondary,
          backgroundColor: shellOrchestraColors.surfaceContainerHigh,
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 2,
          fontFamily: shellOrchestraFonts.monoFontFamily,
          fontWeight: 800,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        },
      },
    },
  },
};

export const shellOrchestraMarketingThemeOptions = {
  palette: {
    mode: 'dark',
    background: {
      default: shellOrchestraColors.surface,
      paper: '#171d16',
    },
    primary: {
      main: shellOrchestraColors.terminalGreen,
      contrastText: shellOrchestraColors.terminalGreenContrast,
    },
    secondary: {
      main: shellOrchestraColors.secondary,
      contrastText: shellOrchestraColors.secondaryContrast,
    },
    text: {
      primary: shellOrchestraColors.textPrimary,
      secondary: shellOrchestraColors.textSecondary,
    },
    divider: shellOrchestraColors.outlineVariant,
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: shellOrchestraFonts.marketingFontFamily,
    h1: { fontWeight: 700, letterSpacing: '-0.055em' },
    h2: { fontWeight: 700, letterSpacing: '-0.04em' },
    h3: { fontWeight: 700, letterSpacing: '-0.03em' },
    button: {
      fontFamily: shellOrchestraFonts.marketingFontFamily,
      fontWeight: 800,
      letterSpacing: '0.015em',
    },
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
        },
      },
    },
  },
};
