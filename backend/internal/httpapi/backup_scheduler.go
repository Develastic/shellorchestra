// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package httpapi

import (
	"context"
	"fmt"
	"log"
	"time"

	"shellorchestra/backend/internal/domain"
)

const backupSchedulerTick = 30 * time.Second

func (a *App) StartBackupScheduler(ctx context.Context) {
	if a.deps.Store == nil {
		return
	}
	go func() {
		timer := time.NewTimer(15 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				a.runBackupScheduleTick(ctx)
				timer.Reset(backupSchedulerTick)
			}
		}
	}()
}

func (a *App) runBackupScheduleTick(ctx context.Context) {
	tasks, err := a.deps.Store.ListBackupTasks(ctx)
	if err != nil {
		log.Printf("backup scheduler: load tasks failed: %v", err)
		return
	}
	now := time.Now().UTC()
	for _, task := range tasks {
		if !backupScheduleConfigured(task.Schedule) {
			continue
		}
		due, reason := a.backupTaskScheduleDue(ctx, task, now)
		if !due {
			if reason != "" {
				log.Printf("backup scheduler: task %s skipped: %s", task.ID, reason)
			}
			continue
		}
		run, err := a.startBackupTaskRun(ctx, task, "schedule")
		if err != nil {
			log.Printf("backup scheduler: task %s start failed: %v", task.ID, err)
			continue
		}
		log.Printf("backup scheduler: started run %s for task %s", run.ID, task.ID)
	}
}

func backupScheduleConfigured(schedule domain.BackupSchedule) bool {
	return schedule.Enabled && (schedule.Kind == "daily" || schedule.Kind == "weekly" || schedule.Kind == "monthly")
}

func (a *App) backupTaskScheduleDue(ctx context.Context, task domain.BackupTask, now time.Time) (bool, string) {
	runs, err := a.deps.Store.ListBackupRuns(ctx, task.ID, 1)
	if err != nil {
		return false, "latest run lookup failed: " + err.Error()
	}
	if len(runs) > 0 {
		latest := runs[0]
		if latest.State == "running" || latest.State == "queued" {
			return false, "previous run is still active"
		}
	}
	scheduledAt := backupScheduledAtForKind(now, task.Schedule)
	if now.Before(scheduledAt) {
		return false, ""
	}
	if len(runs) > 0 && !runs[0].CreatedAt.Before(scheduledAt) {
		return false, ""
	}
	return true, ""
}

func backupScheduledAt(now time.Time, hour int, minute int) time.Time {
	if hour < 0 {
		hour = 0
	}
	if hour > 23 {
		hour = 23
	}
	if minute < 0 {
		minute = 0
	}
	if minute > 59 {
		minute = 59
	}
	return time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, time.UTC)
}

func backupScheduledAtForKind(now time.Time, schedule domain.BackupSchedule) time.Time {
	switch schedule.Kind {
	case "weekly":
		daysSinceMonday := (int(now.Weekday()) + 6) % 7
		weekStart := now.AddDate(0, 0, -daysSinceMonday)
		return backupScheduledAt(weekStart, schedule.Hour, schedule.Minute)
	case "monthly":
		monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
		return backupScheduledAt(monthStart, schedule.Hour, schedule.Minute)
	default:
		return backupScheduledAt(now, schedule.Hour, schedule.Minute)
	}
}

func (a *App) startBackupTaskRun(ctx context.Context, task domain.BackupTask, trigger string) (domain.BackupRun, error) {
	bucket, err := a.selectBackupBucketForTask(ctx, task)
	if err != nil {
		return domain.BackupRun{}, err
	}
	if bucket.ServerID != task.SourceServerID {
		return domain.BackupRun{}, fmt.Errorf("this version can run a backup only when source and target bucket are on the same server. Cross-server streaming is reserved in the Backup Manager design and will be added without changing task data")
	}
	server, err := a.deps.Store.GetServer(ctx, task.SourceServerID)
	if err != nil {
		return domain.BackupRun{}, err
	}
	run, err := a.deps.Store.CreateBackupRun(ctx, domain.BackupRun{TaskID: task.ID, Trigger: trigger, State: "running"})
	if err != nil {
		return domain.BackupRun{}, err
	}
	go a.executeBackupRun(run, task, bucket, server)
	return run, nil
}

func (a *App) selectBackupBucketForTask(ctx context.Context, task domain.BackupTask) (domain.BackupBucket, error) {
	primary, err := a.deps.Store.GetBackupBucket(ctx, task.TargetBucketID)
	if err != nil {
		if task.FallbackBucketID == "" {
			return domain.BackupBucket{}, err
		}
		return a.deps.Store.GetBackupBucket(ctx, task.FallbackBucketID)
	}
	if backupBucketCanAcceptTask(primary, task) {
		return primary, nil
	}
	if task.FallbackBucketID != "" {
		fallback, fallbackErr := a.deps.Store.GetBackupBucket(ctx, task.FallbackBucketID)
		if fallbackErr == nil && backupBucketCanAcceptTask(fallback, task) {
			return fallback, nil
		}
	}
	return primary, nil
}

func backupBucketCanAcceptTask(bucket domain.BackupBucket, task domain.BackupTask) bool {
	if bucket.ServerID != task.SourceServerID {
		return false
	}
	if task.SourceDiskBytes <= 0 || bucket.FreeBytes <= 0 {
		return true
	}
	return bucket.FreeBytes > task.SourceDiskBytes
}
