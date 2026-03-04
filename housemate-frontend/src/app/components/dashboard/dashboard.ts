import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { catchError, finalize, forkJoin, of, timeout } from 'rxjs';

import { BillsService, Bill } from '../../core/services/bills.service';
import { ChoresService, Chore } from '../../core/services/chores.service';
import { HouseholdService, Household } from '../../core/services/household.service';
import { RemindersService, RemindersResponse } from '../../core/services/reminders.service';
import { AnalyticsService, SpendingResponse } from '../../core/services/analytics.service';

type MonthlySpending = SpendingResponse['by_month'][number];

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './dashboard.html',
})
export class Dashboard implements OnInit, OnDestroy {
  loading = true;
  error = '';
  householdLookupError = '';

  household: Household | null = null;
  bills: Bill[] = [];
  chores: Chore[] = [];
  updatingChoreIds = new Set<string>();
  reminders: RemindersResponse | null = null;
  analyticsPreview: MonthlySpending[] = [];
  analyticsTotals: SpendingResponse['totals'] | null = null;
  private loadWatchdog: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    this.refresh();
  }
  
  ngOnDestroy(): void {
    this.clearLoadWatchdog();
  }

  constructor(
    private billsService: BillsService,
    private choresService: ChoresService,
    private householdService: HouseholdService,
    private remindersService: RemindersService,
    private analyticsService: AnalyticsService,
    private cdr: ChangeDetectorRef,

  ) {}

  refresh(): void {
    this.loading = true;
    this.error = '';
    this.householdLookupError = '';
    this.startLoadWatchdog();
    this.cdr.detectChanges();
    // collect partial-load errors so one failing card does not block the rest
    const errors: string[] = [];

    const bills$ = this.billsService.listBills().pipe(
      timeout(10000),
      catchError((err: unknown) => {
        errors.push(this.extractError(err, 'Failed to load bills'));
        return of({ bills: [] as Bill[] });
      }),
    );

    const chores$ = this.choresService.list().pipe(
      timeout(10000),
      catchError((err: unknown) => {
        errors.push(this.extractError(err, 'Failed to load chores'));
        return of({ chores: [] as Chore[] });
      }),
    );

    const household$ = this.householdService.getMyHouseholdStrict().pipe(
      timeout(10000),
      catchError((err: unknown) => {
        this.householdLookupError = this.extractError(err, 'Failed to load household');
        return of(null);
      }),
    );

    const reminders$ = this.remindersService.get(7).pipe(
      timeout(10000),
      catchError(() => of ({today: '', range_days: 7, bills: [], chores: []} as RemindersResponse)),
    );

    const { from, to } = this.lastDaysRange(90);
    const analytics$ = this.analyticsService.spending({ from, to, status: 'all', date_field: 'created_at' }).pipe(
      timeout(10000),
      catchError(() => of(null as SpendingResponse | null)),
    );

    // run all dashboard calls in parallel and render once
    forkJoin({ bills: bills$, chores: chores$, household: household$, reminders: reminders$, analytics: analytics$ })
      .pipe(
        finalize(() => {
          this.loading = false;
          this.clearLoadWatchdog();
          this.cdr.detectChanges();
        }),
      )
      .subscribe(({ bills, chores, household, reminders, analytics }) => {
        this.bills = bills.bills ?? [];
        this.chores = chores.chores ?? [];
        this.household = household ?? null;
        this.reminders = reminders ?? null;
        // keep chart data sorted and only show a short recent preview
        const byMonth = [...(analytics?.by_month ?? [])].sort((a, b) => a.month.localeCompare(b.month));
        this.analyticsPreview = byMonth.slice(-4);
        this.analyticsTotals = analytics?.totals ?? null;
        this.error = errors.join(' | ');
        this.cdr.detectChanges();
      });
  }

  get outstandingBillsCount(): number {
    return this.bills.filter((b) => b.you_paid === false).length;
  }

  get yourOutstandingTotal(): number {
    return this.bills
      .filter((b) => b.you_paid === false && typeof b.your_share === 'number')
      .reduce((sum, b) => sum + (b.your_share ?? 0), 0);
  }

  get upcomingBills(): Bill[] {
    return this.bills
      .filter((b) => b.status !== 'paid' && !!b.due_date)
      .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
      .slice(0, 3);
  }

  get todaysChores(): Chore[] {
    const today = new Date().toISOString().slice(0, 10);
    const openChores = this.chores.filter((c) => !c.completed);
    const dueToday = openChores.filter((c) => c.due_date === today);
    return (dueToday.length > 0 ? dueToday : openChores).slice(0, 5);
  }

  analyticsMaxMonthTotal(): number {
    if (!this.analyticsPreview.length) {
      return 0;
    }
    return Math.max(...this.analyticsPreview.map((m) => Number(m.total || 0)));
  }

  analyticsMonthBarWidth(month: MonthlySpending): number {
    const max = this.analyticsMaxMonthTotal();
    if (max <= 0) {
      return 0;
    }
    const pct = (Number(month.total || 0) / max) * 100;
    return Math.max(2, Math.min(100, pct));
  }

  analyticsPaidPct(month: MonthlySpending): number {
    const total = Number(month.total || 0);
    if (total <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, (Number(month.paid || 0) / total) * 100));
  }

  analyticsOpenPct(month: MonthlySpending): number {
    const total = Number(month.total || 0);
    if (total <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, (Number(month.open || 0) / total) * 100));
  }

  markDone(chore: Chore): void {
    if (chore.completed || this.updatingChoreIds.has(chore.chore_id)) {
      return;
    }

    const previous = chore.completed;
    chore.completed = true;
    this.updatingChoreIds.add(chore.chore_id);

    this.choresService
      .setComplete(chore.chore_id, true)
      .pipe(
        finalize(() => {
          this.updatingChoreIds.delete(chore.chore_id);
          this.cdr.detectChanges();
        }),
      )
      .subscribe({
        next: () => this.refresh(),
        error: (err: unknown) => {
          chore.completed = previous;
          this.error = this.extractError(err, 'Failed to update chore');
          this.cdr.detectChanges();
        },
      });
  }

  money(value: number): string {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value);
  }

  choreAssignmentLabel(chore: Chore): string {
    if (!chore.assigned_to) {
      return 'Auto';
    }
    return `User ${chore.assigned_to.slice(-6)}`;
  }

  trackByBillId(_: number, bill: Bill): string {
    return bill.bill_id;
  }

  trackByChoreId(_: number, chore: Chore): string {
    return chore.chore_id;
  }

  private startLoadWatchdog(): void {
    this.clearLoadWatchdog();
    this.loadWatchdog = setTimeout(() => {
      if (!this.loading) {
        return;
      }

      this.loading = false;
      this.error = this.error || 'Dashboard request timed out. Please refresh.';
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

  private lastDaysRange(days: number): { from: string; to: string } {
    const toDate = new Date();
    const fromDate = new Date(toDate);
    fromDate.setDate(toDate.getDate() - days);
    return { from: this.toYmd(fromDate), to: this.toYmd(toDate) };
  }

  private toYmd(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}
