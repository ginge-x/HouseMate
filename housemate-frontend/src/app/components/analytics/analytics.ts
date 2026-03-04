import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription, finalize, timeout } from 'rxjs';
import { AnalyticsService, SpendingResponse } from '../../core/services/analytics.service';

type MonthlySpending = SpendingResponse['by_month'][number];
type MemberShare = SpendingResponse['by_share'][number];
type DatePreset = '30d' | '90d' | 'ytd' | 'custom';

@Component({
  selector: 'app-analytics',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './analytics.html'
})
export class Analytics implements OnInit, OnDestroy {
  loading = true;
  error = '';

  from = '';
  to = '';
  status: 'all' | 'open' | 'paid' = 'all';
  date_field: 'created_at' | 'due_date' = 'created_at';

  data: SpendingResponse | null = null;
  autoRefresh = true;
  lastUpdatedAt: string | null = null;
  datePreset: DatePreset = '90d';

  private requestSub: Subscription | null = null;
  private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private filterDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshRequestId = 0;

  constructor(private analytics: AnalyticsService, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    // Default to last 90 days 
    this.applyDatePreset('90d', false);

    this.refresh();
    this.startAutoRefresh();
  }

  ngOnDestroy(): void {
    this.requestSub?.unsubscribe();
    this.requestSub = null;
    this.clearAutoRefresh();
    this.clearFilterDebounce();
  }

  refresh(): void {
    if (this.from && this.to && this.from > this.to) {
      this.error = 'From date must be on or before To date.';
      this.loading = false;
      this.cdr.detectChanges();
      return;
    }

    // bump request id so stale responses cant overwrite fresh data
    const requestId = ++this.refreshRequestId;
    this.requestSub?.unsubscribe();
    this.requestSub = null;

    this.loading = true;
    this.error = '';
    this.cdr.detectChanges();

    this.requestSub = this.analytics
      .spending({ from: this.from, to: this.to, status: this.status, date_field: this.date_field })
      .pipe(
        timeout(10000),
        finalize(() => {
          if (requestId !== this.refreshRequestId) return;
          this.loading = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (res) => {
          if (requestId !== this.refreshRequestId) return;
          this.data = res;
          this.lastUpdatedAt = new Date().toISOString();
          this.cdr.detectChanges();
        },
        error: (err) => {
          if (requestId !== this.refreshRequestId) return;
          this.error = err?.error?.error || err?.error?.message || err?.message || 'Failed to load analytics';
          this.cdr.detectChanges();
        },
      });
  }

  onFiltersChanged(): void {
    this.datePreset = 'custom';
    this.clearFilterDebounce();
    // small debounce to avoid spamming requests while typing dates
    this.filterDebounceTimer = setTimeout(() => this.refresh(), 350);
  }

  applyDatePreset(preset: Exclude<DatePreset, 'custom'>, refreshNow = true): void {
    const today = new Date();
    let from = new Date(today);

    if (preset === '30d') {
      from.setDate(today.getDate() - 30);
    } else if (preset === '90d') {
      from.setDate(today.getDate() - 90);
    } else {
      from = new Date(today.getFullYear(), 0, 1);
    }

    this.datePreset = preset;
    this.from = this.toYmd(from);
    this.to = this.toYmd(today);

    if (refreshNow) this.refresh();
  }

  setAutoRefresh(next: boolean): void {
    this.autoRefresh = !!next;
    if (this.autoRefresh) {
      this.startAutoRefresh();
      this.refresh();
      return;
    }
    this.clearAutoRefresh();
  }

  lastUpdatedLabel(): string {
    if (!this.lastUpdatedAt) return 'Never';
    return new Date(this.lastUpdatedAt).toLocaleString();
  }

  maxMonthTotal(): number {
    const rows = this.data?.by_month ?? [];
    if (!rows.length) return 0;
    return Math.max(...rows.map((m) => Number(m.total || 0)));
  }

  monthBarWidth(month: MonthlySpending): number {
    const max = this.maxMonthTotal();
    if (max <= 0) return 0;
    const pct = (Number(month.total || 0) / max) * 100;
    return Math.max(2, Math.min(100, pct));
  }

  paidPct(month: MonthlySpending): number {
    const total = Number(month.total || 0);
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, (Number(month.paid || 0) / total) * 100));
  }

  openPct(month: MonthlySpending): number {
    const total = Number(month.total || 0);
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, (Number(month.open || 0) / total) * 100));
  }

  maxShareOwed(): number {
    const rows = this.data?.by_share ?? [];
    if (!rows.length) return 0;
    return Math.max(...rows.map((s) => Number(s.owed || 0)));
  }

  shareBarWidth(share: MemberShare): number {
    const max = this.maxShareOwed();
    if (max <= 0) return 0;
    const pct = (Number(share.owed || 0) / max) * 100;
    return Math.max(2, Math.min(100, pct));
  }

  sharePaidPct(share: MemberShare): number {
    const total = Number(share.owed || 0);
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, (Number(share.paid || 0) / total) * 100));
  }

  shareUnpaidPct(share: MemberShare): number {
    const total = Number(share.owed || 0);
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, (Number(share.unpaid || 0) / total) * 100));
  }

  money(n: number | null | undefined): string {
    const v = typeof n === 'number' ? n : 0;
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(v);
  }

  private toYmd(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private startAutoRefresh(): void {
    this.clearAutoRefresh();
    if (!this.autoRefresh) return;
    // only poll when idle so do not overlap with active loads
    this.autoRefreshTimer = setInterval(() => {
      if (this.loading) return;
      this.refresh();
    }, 30000);
  }

  private clearAutoRefresh(): void {
    if (!this.autoRefreshTimer) return;
    clearInterval(this.autoRefreshTimer);
    this.autoRefreshTimer = null;
  }

  private clearFilterDebounce(): void {
    if (!this.filterDebounceTimer) return;
    clearTimeout(this.filterDebounceTimer);
    this.filterDebounceTimer = null;
  }
}
