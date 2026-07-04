// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export const debugSupportCompiled = import.meta.env.VITE_SHELLORCHESTRA_DEBUG_SUPPORT === 'true';
export const frontendBuildVersion = import.meta.env.VITE_SHELLORCHESTRA_VERSION ?? '0.0.0';
