// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package httpapi

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	"shellorchestra/backend/internal/domain"
	"shellorchestra/backend/internal/store"
)

const batchScriptSchedulerDeviceID = "system-batch-script-scheduler"

func (a *App) StartBatchScriptScheduler(ctx context.Context) {
	if a.deps.Store == nil || a.deps.Worker == nil {
		return
	}
	go func() {
		timer := time.NewTimer(10 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				a.runBatchScriptScheduleTick(ctx)
				timer.Reset(a.batchScriptSchedulerTick(ctx))
			}
		}
	}()
}

func (a *App) runBatchScriptScheduleTick(ctx context.Context) {
	if a.deps.Audit == nil {
		log.Printf("batch script scheduler: audit log is not configured; scheduled scripts are disabled")
		return
	}
	templates, err := a.deps.Store.ListBatchScriptTemplates(ctx)
	if err != nil {
		log.Printf("batch script scheduler: load templates failed: %v", err)
		return
	}
	now := time.Now().UTC()
	for _, template := range templates {
		if !batchScriptScheduleConfigured(template) {
			continue
		}
		due, state := a.batchScriptScheduleDue(ctx, template, now)
		if !due {
			continue
		}
		if batchScriptScheduleMissed(template, state, now) {
			state = nextBatchScriptScheduleState(template, state, now, "", "missed_run_policy_skip")
			state.MissedRunCount++
			if err := a.deps.Store.UpsertBatchScriptScheduleState(ctx, state); err != nil {
				log.Printf("batch script scheduler: template %s persist missed schedule failed: %v", template.ID, err)
				continue
			}
			if _, err := a.appendBatchScriptAuditEvent(ctx, batchScriptAuditInput{
				EventType:           "batch_script.schedule.missed",
				Operation:           "schedule_missed",
				Template:            template,
				Trigger:             "schedule",
				RequestedByDeviceID: batchScriptSchedulerDeviceID,
				NoopReason:          "missed_run_policy_skip",
				NextRunAt:           state.NextRunAt,
			}); err != nil {
				log.Printf("batch script scheduler: template %s audit missed schedule failed: %v", template.ID, err)
			}
			continue
		}
		run, targets, dispatchCount, err := a.startBatchScriptRun(ctx, template, "schedule", batchScriptSchedulerDeviceID, "")
		if err != nil {
			log.Printf("batch script scheduler: template %s start failed: %v", template.ID, err)
			state = nextBatchScriptScheduleState(template, state, now, "", "start_failed")
			if err := a.deps.Store.UpsertBatchScriptScheduleState(ctx, state); err != nil {
				log.Printf("batch script scheduler: template %s persist start failure failed: %v", template.ID, err)
			}
			if _, auditErr := a.appendBatchScriptAuditEvent(ctx, batchScriptAuditInput{
				EventType:           "batch_script.schedule.start_failed",
				Operation:           "schedule_start_failed",
				Template:            template,
				Trigger:             "schedule",
				RequestedByDeviceID: batchScriptSchedulerDeviceID,
				NoopReason:          err.Error(),
				NextRunAt:           state.NextRunAt,
			}); auditErr != nil {
				log.Printf("batch script scheduler: template %s audit start failure failed: %v", template.ID, auditErr)
			}
			continue
		}
		if dispatchCount == 0 {
			log.Printf("batch script scheduler: template %s has no ready targets (%d skipped)", template.ID, len(targets))
			state = nextBatchScriptScheduleState(template, state, now, "", "no_ready_targets")
			if err := a.deps.Store.UpsertBatchScriptScheduleState(ctx, state); err != nil {
				log.Printf("batch script scheduler: template %s persist no-ready schedule failed: %v", template.ID, err)
			}
			if _, err := a.appendBatchScriptAuditEvent(ctx, batchScriptAuditInput{
				EventType:           "batch_script.schedule.no_ready_targets",
				Operation:           "schedule_no_ready_targets",
				Template:            template,
				Trigger:             "schedule",
				RequestedByDeviceID: batchScriptSchedulerDeviceID,
				NoopReason:          "no_ready_targets",
				TargetCount:         len(targets),
				DispatchCount:       dispatchCount,
				TargetIDs:           batchScriptTargetIDs(targets),
				NextRunAt:           state.NextRunAt,
			}); err != nil {
				log.Printf("batch script scheduler: template %s audit no-ready schedule failed: %v", template.ID, err)
			}
			continue
		}
		state = nextBatchScriptScheduleState(template, state, now, run.ID, "")
		if err := a.deps.Store.UpsertBatchScriptScheduleState(ctx, state); err != nil {
			log.Printf("batch script scheduler: template %s persist next run failed: %v", template.ID, err)
		}
		if _, err := a.appendBatchScriptAuditEvent(ctx, batchScriptAuditInput{
			EventType:           "batch_script.schedule.started",
			Operation:           "schedule_started",
			Template:            template,
			Run:                 run,
			Trigger:             "schedule",
			RequestedByDeviceID: batchScriptSchedulerDeviceID,
			TargetCount:         len(targets),
			DispatchCount:       dispatchCount,
			TargetIDs:           batchScriptTargetIDs(targets),
			NextRunAt:           state.NextRunAt,
		}); err != nil {
			log.Printf("batch script scheduler: template %s audit start failed: %v", template.ID, err)
		}
		log.Printf("batch script scheduler: started run %s for template %s (%d targets)", run.ID, template.ID, dispatchCount)
	}
}

func batchScriptScheduleConfigured(template domain.BatchScriptTemplate) bool {
	return template.Enabled && template.Schedule.Enabled && template.Schedule.IntervalSeconds > 0
}

func (a *App) batchScriptScheduleDue(ctx context.Context, template domain.BatchScriptTemplate, now time.Time) (bool, domain.BatchScriptScheduleState) {
	interval := time.Duration(template.Schedule.IntervalSeconds) * time.Second
	if interval <= 0 {
		return false, domain.BatchScriptScheduleState{TemplateID: template.ID}
	}
	state, err := a.deps.Store.GetBatchScriptScheduleState(ctx, template.ID)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			log.Printf("batch script scheduler: template %s load schedule state failed: %v", template.ID, err)
			return false, domain.BatchScriptScheduleState{TemplateID: template.ID}
		}
		state = domain.BatchScriptScheduleState{TemplateID: template.ID}
	}
	runs, err := a.deps.Store.ListBatchScriptRuns(ctx, template.ID, 1)
	if err != nil {
		log.Printf("batch script scheduler: template %s load last run failed: %v", template.ID, err)
		return false, state
	}
	if len(runs) > 0 && batchScriptRunBlocksSchedule(runs[0]) {
		return false, state
	}
	if state.NextRunAt == nil {
		next := now
		if len(runs) > 0 && !runs[0].CreatedAt.IsZero() {
			next = runs[0].CreatedAt.Add(interval)
		}
		state.NextRunAt = &next
	}
	return !now.Before(*state.NextRunAt), state
}

func batchScriptLatestRunAllowsSchedule(latest domain.BatchScriptRun, interval time.Duration, now time.Time) bool {
	if interval <= 0 {
		return false
	}
	if batchScriptRunBlocksSchedule(latest) {
		return false
	}
	return now.Sub(latest.CreatedAt) >= interval
}

func batchScriptRunBlocksSchedule(run domain.BatchScriptRun) bool {
	return run.State == domain.BatchScriptRunRunning || run.State == domain.BatchScriptRunQueued
}

func batchScriptScheduleMissed(template domain.BatchScriptTemplate, state domain.BatchScriptScheduleState, now time.Time) bool {
	if template.Schedule.MissedRunPolicy != domain.BatchScriptMissedRunSkip || state.NextRunAt == nil {
		return false
	}
	interval := time.Duration(template.Schedule.IntervalSeconds) * time.Second
	return interval > 0 && now.Sub(*state.NextRunAt) >= interval
}

func nextBatchScriptScheduleState(template domain.BatchScriptTemplate, state domain.BatchScriptScheduleState, now time.Time, runID string, noopReason string) domain.BatchScriptScheduleState {
	interval := time.Duration(template.Schedule.IntervalSeconds) * time.Second
	if interval <= 0 {
		interval = time.Minute
	}
	next := now.Add(interval)
	evaluated := now
	state.TemplateID = template.ID
	state.NextRunAt = &next
	state.LastEvaluatedAt = &evaluated
	state.LastStartedRunID = strings.TrimSpace(runID)
	state.LastNoopReason = strings.TrimSpace(noopReason)
	if state.LastNoopReason != "" {
		state.LastNoopAt = &evaluated
	} else {
		state.LastNoopAt = nil
	}
	state.UpdatedAt = now
	return state
}

func (a *App) batchScriptSchedulerTick(ctx context.Context) time.Duration {
	seconds := a.deps.Config.Runtime.PeriodicScriptTickSeconds
	if a.deps.Store != nil {
		if settings, err := a.deps.Store.GetSSHSecuritySettings(ctx); err == nil && settings.PeriodicScriptTickSeconds > 0 {
			seconds = settings.PeriodicScriptTickSeconds
		}
	}
	if seconds <= 0 {
		seconds = 10
	}
	if seconds > 60 {
		seconds = 60
	}
	return time.Duration(seconds) * time.Second
}
