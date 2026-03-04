import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { finalize, timeout } from 'rxjs';

import { ChoresService, Chore, Recurrence } from '../../core/services/chores.service';
import { HouseholdService } from '../../core/services/household.service';

type Member = { user_id: string; email: string; role: string };
type ChoreRecurrenceMode = 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly';

@Component({
  selector: 'app-chores',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chores.html',
})
export class Chores implements OnInit, OnDestroy {
  loading = true;
  error = '';
  includeArchived = false;

  chores: Chore[] = [];
  members: Member[] = [];
  updatingChoreIds = new Set<string>();
  private loadWatchdog: ReturnType<typeof setTimeout> | null = null;

  creating = false;
  createError = '';
  showCreateForm = false;

  title = '';
  due_date = '';
  assigned_to: 'auto' | string = 'auto';

  recurrenceMode: ChoreRecurrenceMode = 'none';
  recurrenceInterval = 1;  // used for daily/weekly/monthly (biweekly is fixed 2 weeks)
  reminderDaysBefore = 1;  // chores default

  viewFilter: 'all' | 'open' | 'completed' = 'all';
  assignedFilter = 'all';

  constructor(
    private choresService: ChoresService,
    private householdService: HouseholdService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.loadMembers();
    this.refresh();
  }

  ngOnDestroy(): void {
    this.clearLoadWatchdog();
  }

  loadMembers(): void {
    this.householdService.getMembers().subscribe({
      next: (res) => {
        this.members = res.members ?? [];
        this.cdr.detectChanges();
      },
      error: () => {
        // chores page still works without member list, custom labels fall back
        this.members = [];
        this.cdr.detectChanges();
      },
    });
  }

  refresh(): void {
    this.loading = true;
    this.error = '';
    this.startLoadWatchdog();
    this.cdr.detectChanges();

    this.choresService
      .list(this.includeArchived)
      .pipe(
        timeout(10000),
        finalize(() => {
          this.loading = false;
          this.cdr.detectChanges();
        }),
      )
      .subscribe({
        next: (res) => {
          this.clearLoadWatchdog();
          this.chores = res.chores ?? [];
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.clearLoadWatchdog();
          this.error = this.extractError(err, 'Failed to load chores');
          this.cdr.detectChanges();
        },
      });
  }

  toggleCreateForm(): void {
    this.showCreateForm = !this.showCreateForm;
    this.createError = '';
    if (!this.showCreateForm) {
      this.resetCreateForm();
    }
  }

  cancelCreate(): void {
    this.showCreateForm = false;
    this.createError = '';
    this.resetCreateForm();
  }

  onRecurrenceChange(next: ChoreRecurrenceMode): void {
    this.recurrenceMode = next;

    if (next === 'none') {
      this.recurrenceInterval = 1;
      return;
    }

    if (next === 'biweekly') {
      this.recurrenceInterval = 2;
      return;
    }

    if (!this.recurrenceInterval || this.recurrenceInterval < 1) this.recurrenceInterval = 1;
  }

  recurrenceUnitLabel(): string {
    if (this.recurrenceMode === 'daily') return 'day(s)';
    if (this.recurrenceMode === 'weekly') return 'week(s)';
    if (this.recurrenceMode === 'monthly') return 'month(s)';
    return '';
  }

  buildRecurrence(): Recurrence | null {
    if (this.recurrenceMode === 'none') return null;
    if (this.recurrenceMode === 'biweekly') return { freq: 'weekly', interval: 2 };
    return { freq: this.recurrenceMode, interval: Math.max(1, Number(this.recurrenceInterval || 1)) };
  }

  frequencyLabel(chore: Chore): string {
    const r = chore.recurrence;
    if (!r) return 'One-off';

    const freq = (r.freq || '').toLowerCase();
    const interval = Number(r.interval || 1);

    if (freq === 'weekly' && interval === 2) return 'Biweekly';
    if (freq === 'daily') return interval === 1 ? 'Daily' : `Every ${interval} days`;
    if (freq === 'weekly') return interval === 1 ? 'Weekly' : `Every ${interval} weeks`;
    if (freq === 'monthly') return interval === 1 ? 'Monthly' : `Every ${interval} months`;
    return `${r.freq} (x${interval})`;
  }

  createChore(): void {
    this.createError = '';
    const title = this.title.trim();
    if (!title) {
      this.createError = 'Title is required';
      return;
    }

    const due = this.due_date.trim();
    const recurrence = this.buildRecurrence();

    // Require due date for recurring chores
    if (recurrence && !due) {
      this.createError = 'Recurring chores require a due date.';
      return;
    }

    const payload: {
      title: string;
      due_date?: string;
      assigned_to: string | 'auto';
      recurrence?: Recurrence | null;
      reminder_days_before?: number;
    } = {
      title,
      assigned_to: this.assigned_to,
      recurrence,
      reminder_days_before: Math.max(0, Math.min(60, Number(this.reminderDaysBefore || 0))),
    };

    if (due) payload.due_date = due;

    this.creating = true;
    this.choresService
      .create(payload)
      .pipe(
        finalize(() => {
          this.creating = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: () => {
          this.showCreateForm = false;
          this.resetCreateForm();
          this.refresh();
        },
        error: (err) => {
          this.createError = this.extractError(err, 'Failed to create chore');
          this.cdr.detectChanges();
        },
      });
  }

  toggleComplete(chore: Chore): void {
    if (chore.archived) {
      this.error = 'Cannot change completion on archived chores. Unarchive first.';
      this.cdr.detectChanges();
      return;
    }
    if (this.updatingChoreIds.has(chore.chore_id)) return;

    const next = !chore.completed;
    chore.completed = next;
    this.updatingChoreIds.add(chore.chore_id);

    this.choresService
      .setComplete(chore.chore_id, next)
      .pipe(
        finalize(() => {
          this.updatingChoreIds.delete(chore.chore_id);
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: () => this.refresh(),
        error: (err) => {
          chore.completed = !next;
          this.error = this.extractError(err, 'Failed to update chore');
          this.cdr.detectChanges();
        },
      });
  }

  toggleIncludeArchived(next: boolean): void {
    this.includeArchived = !!next;
    this.refresh();
  }

  canArchive(chore: Chore): boolean {
    return !!chore.completed && !chore.archived;
  }

  canDelete(chore: Chore): boolean {
    return !!chore.completed || !!chore.archived;
  }

  toggleArchive(chore: Chore): void {
    if (this.updatingChoreIds.has(chore.chore_id)) return;
    const archiving = !chore.archived;
    if (archiving && !chore.completed) {
      this.error = 'Only completed chores can be archived.';
      this.cdr.detectChanges();
      return;
    }
    const ok = confirm(`${archiving ? 'Archive' : 'Unarchive'} "${chore.title}"?`);
    if (!ok) return;

    this.updatingChoreIds.add(chore.chore_id);
    this.choresService
      .setArchived(chore.chore_id, archiving)
      .pipe(
        finalize(() => {
          this.updatingChoreIds.delete(chore.chore_id);
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: () => this.refresh(),
        error: (err) => {
          this.error = this.extractError(err, `Failed to ${archiving ? 'archive' : 'unarchive'} chore`);
          this.cdr.detectChanges();
        },
      });
  }

  deleteChore(chore: Chore): void {
    if (!this.canDelete(chore)) {
      this.error = 'Only completed or archived chores can be deleted.';
      this.cdr.detectChanges();
      return;
    }
    if (this.updatingChoreIds.has(chore.chore_id)) return;
    const ok = confirm(`Delete "${chore.title}"?`);
    if (!ok) return;

    this.updatingChoreIds.add(chore.chore_id);
    this.choresService
      .delete(chore.chore_id)
      .pipe(
        finalize(() => {
          this.updatingChoreIds.delete(chore.chore_id);
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: () => this.refresh(),
        error: (err) => {
          this.error = this.extractError(err, 'Failed to delete chore');
          this.cdr.detectChanges();
        },
      });
  }

  get visibleChores(): Chore[] {
    let filtered = this.chores;

    // status filter first, then assignment filter
    if (this.viewFilter === 'open') {
      filtered = filtered.filter((c) => !c.completed);
    } else if (this.viewFilter === 'completed') {
      filtered = filtered.filter((c) => c.completed);
    }

    if (this.assignedFilter === 'auto') {
      filtered = filtered.filter((c) => !c.assigned_to);
    } else if (this.assignedFilter !== 'all') {
      filtered = filtered.filter((c) => c.assigned_to === this.assignedFilter);
    }

    return filtered;
  }

  statusLabel(chore: Chore): string {
    return chore.completed ? 'Done' : 'Not done';
  }

  memberLabel(userId: string | null): string {
    if (!userId) return 'Auto';
    const member = this.members.find((m) => m.user_id === userId);
    return member ? member.email || member.user_id : 'Unknown';
  }

  trackById(_: number, chore: Chore): string {
    return chore.chore_id;
  }

  private resetCreateForm(): void {
    this.title = '';
    this.due_date = '';
    this.assigned_to = 'auto';

    // reset recurrence
    this.recurrenceMode = 'none';
    this.recurrenceInterval = 1;
    this.reminderDaysBefore = 1;
  }

  private startLoadWatchdog(): void {
    this.clearLoadWatchdog();
    this.loadWatchdog = setTimeout(() => {
      if (!this.loading) {
        return;
      }

      this.loading = false;
      this.error = 'Chores request timed out. Please refresh.';
      this.cdr.detectChanges();
    }, 12000);
  }

  private clearLoadWatchdog(): void {
    if (this.loadWatchdog) {
      clearTimeout(this.loadWatchdog);
      this.loadWatchdog = null;
    }
  }

  private extractError(err: unknown, fallback: string): string {
    const httpErr = err as {
      error?: { error?: string; message?: string } | string;
      message?: string;
      status?: number;
    };
    const payload = httpErr?.error;
    const payloadMessage = typeof payload === 'string' ? payload : payload?.error || payload?.message;
    const msg = payloadMessage || httpErr?.message || fallback;
    return httpErr?.status ? `(${httpErr.status}) ${msg}` : msg;
  }
}
