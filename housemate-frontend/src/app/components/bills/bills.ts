import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { finalize, timeout } from 'rxjs';

import { BillsService, Bill, BillSplit, CreateBillPayload, Recurrence } from '../../core/services/bills.service';
import { HouseholdService, HouseholdMember } from '../../core/services/household.service';

type CustomSplitRow = {
  user_id: string;
  label: string;
  amount_owed: number | null;
};

type BillRecurrenceMode = 'none' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly';

@Component({
  selector: 'app-bills',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './bills.html',
})
export class Bills implements OnInit, OnDestroy {
  loading = true;
  error = '';
  includeArchived = false;

  bills: Bill[] = [];
  updatingBillIds = new Set<string>();
  private loadWatchdog: ReturnType<typeof setTimeout> | null = null;

  // members (for custom split)
  membersLoading = false;
  membersError = '';
  members: HouseholdMember[] = [];

  // create form
  creating = false;
  createError = '';
  title = '';
  amount: number | null = null;
  due_date = ''; // YYYY-MM-DD

  //recurrence
  recurrenceMode: BillRecurrenceMode = 'none';
  recurrenceInterval = 1;        // used for weekly/monthly/quarterly
  reminderDaysBefore = 3;        // bills default

  splitType: 'equal' | 'custom' = 'equal';
  customSplits: CustomSplitRow[] = [];

  constructor(
    private billsService: BillsService,
    private householdService: HouseholdService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadMembers();
    this.refresh();
  }

  ngOnDestroy(): void {
    this.clearLoadWatchdog();
  }

  loadMembers(): void {
    this.membersLoading = true;
    this.membersError = '';

    this.householdService
      .getMembers()
      .pipe(
        timeout(10000),
        finalize(() => {
          this.membersLoading = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (res) => {
          this.members = (res?.members ?? []).sort((a, b) => (a.email || '').localeCompare(b.email || ''));
          this.rebuildCustomSplitRows();
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.membersError = this.extractError(err, 'Failed to load household members');
          this.cdr.detectChanges();
        },
      });
  }

  refresh(): void {
    this.loading = true;
    this.error = '';
    this.startLoadWatchdog();
    this.cdr.detectChanges();

    this.billsService
      .listBills(this.includeArchived)
      .pipe(
        timeout(10000),
        finalize(() => {
          this.loading = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (res) => {
          this.clearLoadWatchdog();
          this.bills = res?.bills ?? [];
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.clearLoadWatchdog();
          this.error = this.extractError(err, 'Failed to load bills');
          this.cdr.detectChanges();
        },
      });
  }

  onSplitTypeChange(next: 'equal' | 'custom'): void {
    this.splitType = next;

    if (next === 'custom') {
      this.rebuildCustomSplitRows();
      this.fillEqualCustomSplits();
    }
  }

  onRecurrenceChange(next: BillRecurrenceMode): void {
    this.recurrenceMode = next;

    if (next === 'none') {
      this.recurrenceInterval = 1;
      return;
    }

    // biweekly is fixed at 2 weeks
    if (next === 'biweekly') {
      this.recurrenceInterval = 2;
      return;
    }

    // keep interval >= 1
    if (!this.recurrenceInterval || this.recurrenceInterval < 1) this.recurrenceInterval = 1;
  }

  recurrenceUnitLabel(): string {
    if (this.recurrenceMode === 'weekly') return 'week(s)';
    if (this.recurrenceMode === 'monthly') return 'month(s)';
    if (this.recurrenceMode === 'quarterly') return 'quarter(s)';
    return '';
  }

  buildRecurrence(): Recurrence | null {
    if (this.recurrenceMode === 'none') return null;
    if (this.recurrenceMode === 'biweekly') return { freq: 'weekly', interval: 2 };
    return { freq: this.recurrenceMode, interval: Math.max(1, Number(this.recurrenceInterval || 1)) };
  }

  recurrenceLabel(r: Recurrence | null | undefined): string {
    if (!r) return 'One-off';
    const freq = (r.freq || '').toLowerCase();
    const interval = Number(r.interval || 1);

    if (freq === 'weekly' && interval === 2) return 'Biweekly';
    if (freq === 'weekly') return interval === 1 ? 'Weekly' : `Every ${interval} weeks`;
    if (freq === 'monthly') return interval === 1 ? 'Monthly' : `Every ${interval} months`;
    if (freq === 'quarterly') return interval === 1 ? 'Quarterly' : `Every ${interval} quarters`;
    return `${r.freq} (x${interval})`;
  }

  rebuildCustomSplitRows(): void {
    const prev = new Map(this.customSplits.map((r) => [r.user_id, r.amount_owed]));

    this.customSplits = (this.members ?? []).map((m) => ({
      user_id: m.user_id,
      label: m.email || `User ${m.user_id.slice(-6)}`,
      amount_owed: prev.has(m.user_id) ? (prev.get(m.user_id) ?? null) : null,
    }));
  }

  fillEqualCustomSplits(): void {
    if (this.amount === null || Number.isNaN(this.amount) || this.amount <= 0) return;
    if (!this.customSplits.length) return;

    const n = this.customSplits.length;
    const per = this.round2(this.amount / n);

    let running = 0;
    this.customSplits = this.customSplits.map((row, idx) => {
      let owed = per;
      if (idx === n - 1) {
        owed = this.round2(this.amount! - running);
      } else {
        running = this.round2(running + owed);
      }
      return { ...row, amount_owed: owed };
    });

    this.cdr.detectChanges();
  }

  customTotal(): number {
    return this.round2(
      this.customSplits.reduce((total, row) => total + (typeof row.amount_owed === 'number' ? row.amount_owed : 0), 0)
    );
  }

  customDiff(): number {
    const amt = typeof this.amount === 'number' ? this.amount : 0;
    return this.round2(amt - this.customTotal());
  }

  customValid(): boolean {
    if (this.amount === null || Number.isNaN(this.amount) || this.amount <= 0) return false;
    if (!this.customSplits.length) return false;

    const allNumbers = this.customSplits.every(
      (r) => typeof r.amount_owed === 'number' && !Number.isNaN(r.amount_owed) && r.amount_owed >= 0
    );
    if (!allNumbers) return false;

    return this.customDiff() === 0;
  }

  createBill(): void {
    this.createError = '';

    const title = this.title.trim();
    if (!title) {
      this.createError = 'Title is required';
      return;
    }

    if (this.amount === null || Number.isNaN(this.amount) || this.amount <= 0) {
      this.createError = 'Amount must be greater than 0';
      return;
    }

    const due = this.due_date.trim();
    const recurrence = this.buildRecurrence();

    // Require due date for recurring bills
    if (recurrence && !due) {
      this.createError = 'Recurring bills require a due date.';
      return;
    }

    const payload: CreateBillPayload = {
      title,
      amount: this.amount,
      split_type: this.splitType,
      reminder_days_before: Math.max(0, Math.min(60, Number(this.reminderDaysBefore || 0))),
      recurrence: recurrence,
    };

    if (due) payload.due_date = due;

    if (this.splitType === 'custom') {
      if (!this.customSplits.length) {
        this.createError = 'No household members loaded yet.';
        return;
      }

      if (!this.customValid()) {
        const diff = this.customDiff();
        this.createError =
          diff === 0
            ? 'Custom split values are invalid.'
            : `Custom split must total ${this.money(this.amount)} (difference: ${this.money(diff)})`;
        return;
      }

      payload.splits = this.customSplits.map((r) => ({
        user_id: r.user_id,
        amount_owed: Number(r.amount_owed),
      }));
    }

    this.creating = true;
    this.billsService
      .createBill(payload)
      .pipe(
        finalize(() => {
          this.creating = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: () => {
          this.title = '';
          this.amount = null;
          this.due_date = '';
          this.splitType = 'equal';
          this.customSplits = [];

          // reset recurrence fields
          this.recurrenceMode = 'none';
          this.recurrenceInterval = 1;
          this.reminderDaysBefore = 3;

          this.refresh();
        },
        error: (err) => {
          this.createError = this.extractError(err, 'Failed to create bill');
          this.cdr.detectChanges();
        },
      });
  }

  togglePaid(bill: Bill): void {
    if (bill.archived) {
      this.error = 'Cannot change payment status on archived bills. Unarchive first.';
      this.cdr.detectChanges();
      return;
    }

    if (this.updatingBillIds.has(bill.bill_id)) return;
    const currentlyPaid = !!bill.you_paid;
    bill.you_paid = !currentlyPaid;
    this.updatingBillIds.add(bill.bill_id);

    this.billsService
      .setPaid(bill.bill_id, !currentlyPaid)
      .pipe(
        finalize(() => {
          this.updatingBillIds.delete(bill.bill_id);
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: () => this.refresh(),
        error: (err) => {
          bill.you_paid = currentlyPaid;
          this.error = this.extractError(err, 'Failed to update payment status');
          this.cdr.detectChanges();
        },
      });
  }

  toggleIncludeArchived(next: boolean): void {
    this.includeArchived = !!next;
    this.refresh();
  }

  canArchive(bill: Bill): boolean {
    return bill.status === 'paid' && !bill.archived;
  }

  canDelete(bill: Bill): boolean {
    return bill.status === 'paid' || !!bill.archived;
  }

  toggleArchive(bill: Bill): void {
    if (this.updatingBillIds.has(bill.bill_id)) return;

    const archiving = !bill.archived;
    if (archiving && bill.status !== 'paid') {
      this.error = 'Only paid bills can be archived.';
      this.cdr.detectChanges();
      return;
    }

    const ok = confirm(`${archiving ? 'Archive' : 'Unarchive'} "${bill.title}"?`);
    if (!ok) return;

    this.updatingBillIds.add(bill.bill_id);
    this.billsService
      .setArchived(bill.bill_id, archiving)
      .pipe(
        finalize(() => {
          this.updatingBillIds.delete(bill.bill_id);
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: () => this.refresh(),
        error: (err) => {
          this.error = this.extractError(err, `Failed to ${archiving ? 'archive' : 'unarchive'} bill`);
          this.cdr.detectChanges();
        },
      });
  }

  deleteBill(bill: Bill): void {
    if (!this.canDelete(bill)) {
      this.error = 'Only paid or archived bills can be deleted.';
      this.cdr.detectChanges();
      return;
    }
    if (this.updatingBillIds.has(bill.bill_id)) return;

    const ok = confirm(`Delete "${bill.title}"?`);
    if (!ok) return;

    this.updatingBillIds.add(bill.bill_id);
    this.billsService
      .deleteBill(bill.bill_id)
      .pipe(
        finalize(() => {
          this.updatingBillIds.delete(bill.bill_id);
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: () => this.refresh(),
        error: (err) => {
          this.error = this.extractError(err, 'Failed to delete bill');
          this.cdr.detectChanges();
        },
      });
  }

  private startLoadWatchdog(): void {
    this.clearLoadWatchdog();
    this.loadWatchdog = setTimeout(() => {
      if (!this.loading) return;
      this.loading = false;
      this.error = 'Bills request timed out. Please refresh.';
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

  round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  money(n: number | null | undefined): string {
    const v = typeof n === 'number' ? n : 0;
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(v);
  }

  splitLabel(split: BillSplit): string {
    if (split.is_you) return 'You';
    if (split.email) return split.email;
    if (split.user_id) return `User ${split.user_id.slice(-6)}`;
    return 'Unknown member';
  }

  paidCount(bill: Bill): number {
    return bill.splits.filter((split) => split.paid).length;
  }

  outstandingAmount(bill: Bill): number {
    return bill.splits
      .filter((split) => !split.paid)
      .reduce((total, split) => total + split.amount_owed, 0);
  }

  trackByBillId(_: number, b: Bill): string {
    return b.bill_id;
  }
}
