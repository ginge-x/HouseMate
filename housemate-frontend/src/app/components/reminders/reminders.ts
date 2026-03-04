import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { finalize } from 'rxjs';
import { RemindersService, RemindersResponse } from '../../core/services/reminders.service';

@Component({
  selector: 'app-reminders',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './reminders.html',
})
export class Reminders implements OnInit {
  loading = true;
  error = '';
  data: RemindersResponse | null = null;

  constructor(
    private reminders: RemindersService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading = true;
    this.error = '';
    this.reminders
      // 14-day window to keep reminders useful but still compact
      .get(14)
      .pipe(
        finalize(() => {
          this.loading = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (res) => {
          this.data = res;
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.error = err?.error?.error || err?.message || 'Failed to load reminders';
          this.cdr.detectChanges();
        },
      });
  }
}
