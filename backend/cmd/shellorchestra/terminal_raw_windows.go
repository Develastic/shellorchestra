// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

//go:build windows

package main

import "fmt"

func enterRawTerminalMode(fd int) (func(), error) {
	return nil, fmt.Errorf("terminal proxy raw console mode is not implemented for Windows app builds yet")
}
