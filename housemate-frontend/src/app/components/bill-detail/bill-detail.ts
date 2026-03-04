import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription, finalize, timeout } from 'rxjs';

import { Bill, BillSplit, BillsService } from '../../core/services/bills.service';

@Component({
  selector: 'app-bill-detail',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './bill-detail.html',
})
export class BillDetail implements OnInit, OnDestroy {
  loading = true;
  updating = false;
  error = '';

  bill: Bill | null = null;
  private loadWatchdog: ReturnType<typeof setTimeout> | null = null;
  private routeSub: Subscription | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private billsService: BillsService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    // support in-place navigation between /bills/:billId routes
    this.routeSub = this.route.paramMap.subscribe((params) => {
      const billId = params.get('billId');
      if (!billId) {
        this.loading = false;
        this.error = 'Invalid bill id';
        this.cdr.detectChanges();
        return;
      }

      this.loadBill(billId);
    });
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
    this.clearLoadWatchdog();
  }

  loadBill(billId: string): void {
    this.loading = true;
    this.error = '';
    // watchdog gives a friendly timeout if request never resolves
    this.startLoadWatchdog();
    this.cdr.detectChanges();

    this.billsService
      .getBill(billId)
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
          this.bill = res?.bill ?? null;
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.clearLoadWatchdog();
          this.error = this.extractError(err, 'Failed to load bill');
          this.cdr.detectChanges();
        },
      });
  }

  togglePaid(): void {
    if (!this.bill || this.bill.you_paid === null || this.updating) {
      return;
    }
    if (this.bill.archived) {
      this.error = 'Cannot change payment status on archived bills. Unarchive first.';
      this.cdr.detectChanges();
      return;
    }

    const currentlyPaid = !!this.bill.you_paid;
    this.updating = true;
    this.billsService
      .setPaid(this.bill.bill_id, !currentlyPaid)
      .pipe(
        finalize(() => {
          this.updating = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (res) => {
          this.bill = res?.bill ?? this.bill;
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.error = this.extractError(err, 'Failed to update payment status');
          this.cdr.detectChanges();
        },
      });
  }

  canArchive(bill: Bill): boolean {
    return bill.status === 'paid' && !bill.archived;
  }

  canDelete(bill: Bill): boolean {
    return bill.status === 'paid' || !!bill.archived;
  }

  toggleArchive(): void {
    if (!this.bill || this.updating) return;
    const archiving = !this.bill.archived;
    if (archiving && this.bill.status !== 'paid') {
      this.error = 'Only paid bills can be archived.';
      this.cdr.detectChanges();
      return;
    }
    const ok = confirm(`${archiving ? 'Archive' : 'Unarchive'} "${this.bill.title}"?`);
    if (!ok) return;

    this.updating = true;
    this.billsService
      .setArchived(this.bill.bill_id, archiving)
      .pipe(
        finalize(() => {
          this.updating = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (res) => {
          this.bill = res?.bill ?? this.bill;
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.error = this.extractError(err, `Failed to ${archiving ? 'archive' : 'unarchive'} bill`);
          this.cdr.detectChanges();
        },
      });
  }

  deleteBill(): void {
    if (!this.bill || this.updating) return;
    if (!this.canDelete(this.bill)) {
      this.error = 'Only paid or archived bills can be deleted.';
      this.cdr.detectChanges();
      return;
    }
    const ok = confirm(`Delete "${this.bill.title}"?`);
    if (!ok) return;

    this.updating = true;
    this.billsService
      .deleteBill(this.bill.bill_id)
      .pipe(
        finalize(() => {
          this.updating = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: () => this.router.navigate(['/bills']),
        error: (err) => {
          this.error = this.extractError(err, 'Failed to delete bill');
          this.cdr.detectChanges();
        },
      });
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

  backToBills(): void {
    this.router.navigate(['/bills']);
  }

  private startLoadWatchdog(): void {
    this.clearLoadWatchdog();
    this.loadWatchdog = setTimeout(() => {
      if (!this.loading) {
        return;
      }

      this.loading = false;
      this.error = 'Bill request timed out. Please try again.';
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
