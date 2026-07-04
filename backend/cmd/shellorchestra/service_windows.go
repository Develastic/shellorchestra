// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package main

import (
	"context"
	"log"
	"strings"
	"time"

	"golang.org/x/sys/windows/svc"
)

type shellOrchestraWindowsService struct {
	role string
	run  func(context.Context)
}

func runWindowsServiceIfNeeded(role string, run func(context.Context)) bool {
	isService, err := svc.IsWindowsService()
	if err != nil {
		log.Fatalf("failed to detect Windows service mode: %v", err)
	}
	if !isService {
		return false
	}
	if err := svc.Run(windowsServiceNameForRole(role), shellOrchestraWindowsService{role: role, run: run}); err != nil {
		log.Fatalf("Windows service failed: %v", err)
	}
	return true
}

func windowsServiceNameForRole(role string) string {
	switch strings.TrimSpace(strings.ToLower(role)) {
	case "updater":
		return "ShellOrchestraUpdater"
	case "all":
		return "ShellOrchestraSupervisor"
	default:
		return "ShellOrchestra"
	}
}

func (s shellOrchestraWindowsService) Execute(_ []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		s.run(ctx)
	}()

	const accepted = svc.AcceptStop | svc.AcceptShutdown
	changes <- svc.Status{State: svc.StartPending}
	changes <- svc.Status{State: svc.Running, Accepts: accepted}

	for {
		select {
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				changes <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				cancel()
				select {
				case <-done:
				case <-time.After(30 * time.Second):
				}
				return false, 0
			default:
				// Other control requests are intentionally not supported.
			}
		case <-done:
			return false, 0
		}
	}
}
