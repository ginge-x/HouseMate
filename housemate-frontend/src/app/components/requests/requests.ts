import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';

import { RequestsService, RequestSummary, RequestDetail } from '../../core/services/requests.service';

@Component({
  selector: 'app-requests',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './requests.html',
})
export class Requests implements OnInit {
  loading = true;
  error = '';

  creating = false;
  createError = '';
  title = '';
  body = '';

  filter: 'all' | 'open' | 'done' = 'all';

  requests: RequestSummary[] = [];

  expandedId: string | null = null;
  detailLoading = false;
  detailError = '';
  detail: RequestDetail | null = null;

  commentDraft = '';

  constructor(
    private requestsService: RequestsService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading = true;
    this.error = '';

    this.requestsService
      .list(this.filter)
      .pipe(
        finalize(() => {
          this.loading = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (res) => {
          this.requests = res?.requests ?? [];
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.error = this.extractError(err, 'Failed to load requests');
          this.cdr.detectChanges();
        },
      });
  }

  setFilter(next: 'all' | 'open' | 'done'): void {
    this.filter = next;
    // reset expanded state because list contents may change with new filter
    this.expandedId = null;
    this.detail = null;
    this.refresh();
  }

  create(): void {
    this.createError = '';
    const title = this.title.trim();
    const body = this.body.trim();

    if (!title) return void (this.createError = 'Title is required');
    if (!body) return void (this.createError = 'Body is required');

    this.creating = true;
    this.requestsService
      .create({ title, body })
      .pipe(
        finalize(() => {
          this.creating = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: () => {
          this.title = '';
          this.body = '';
          this.refresh();
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.createError = this.extractError(err, 'Failed to create request');
          this.cdr.detectChanges();
        },
      });
  }

  toggleExpand(req: RequestSummary): void {
    if (this.expandedId === req.request_id) {
      this.expandedId = null;
      this.detail = null;
      this.commentDraft = '';
      return;
    }

    this.expandedId = req.request_id;
    // lazy load detail only for the opened request
    this.loadDetail(req.request_id);
  }

  loadDetail(requestId: string): void {
    this.detailLoading = true;
    this.detailError = '';
    this.detail = null;
    this.commentDraft = '';

    this.requestsService
      .get(requestId)
      .pipe(
        finalize(() => {
          this.detailLoading = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (res) => {
          this.detail = res.request;
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.detailError = this.extractError(err, 'Failed to load request details');
          this.cdr.detectChanges();
        },
      });
  }

  toggleStatus(req: RequestSummary): void {
    if (!req.can_edit) return;
    const next = req.status === 'done' ? 'open' : 'done';

    this.requestsService.update(req.request_id, { status: next as 'open' | 'done' }).subscribe({
      next: () => {
        this.refresh();
        if (this.expandedId === req.request_id) this.loadDetail(req.request_id);
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.error = this.extractError(err, 'Failed to update status');
        this.cdr.detectChanges();
      },
    });
  }

  deleteRequest(req: RequestSummary): void {
    if (!req.can_delete) return;
    const ok = confirm(`Delete "${req.title}"?`);
    if (!ok) return;

    this.requestsService.remove(req.request_id).subscribe({
      next: () => {
        if (this.expandedId === req.request_id) {
          this.expandedId = null;
          this.detail = null;
        }
        this.refresh();
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.error = this.extractError(err, 'Failed to delete request');
        this.cdr.detectChanges();
      },
    });
  }

  addComment(): void {
    if (!this.detail || !this.expandedId) return;
    const body = this.commentDraft.trim();
    if (!body) return;

    this.requestsService.addComment(this.expandedId, body).subscribe({
      next: () => {
        this.commentDraft = '';
        // refresh detail + list so comment counts and last activity stay in sync
        this.loadDetail(this.expandedId!);
        this.refresh();
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.detailError = this.extractError(err, 'Failed to add comment');
        this.cdr.detectChanges();
      },
    });
  }

  deleteComment(commentId: string): void {
    if (!this.detail || !this.expandedId) return;
    const ok = confirm('Delete this comment?');
    if (!ok) return;

    this.requestsService.deleteComment(this.expandedId, commentId).subscribe({
      next: () => {
        this.loadDetail(this.expandedId!);
        this.refresh();
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.detailError = this.extractError(err, 'Failed to delete comment');
        this.cdr.detectChanges();
      },
    });
  }

  labelDate(iso: string | null): string {
    if (!iso) return '';
    return iso.slice(0, 10);
  }

  private extractError(err: unknown, fallback: string): string {
    const httpErr = err as { error?: any; message?: string; status?: number };
    const payload = httpErr?.error;
    const msg = payload?.error || payload?.message || httpErr?.message || fallback;
    return httpErr?.status ? `(${httpErr.status}) ${msg}` : msg;
  }
}
