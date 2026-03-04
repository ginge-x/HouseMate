import { ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';

import { ChatService, ChatMessage } from '../../core/services/chat.service';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat.html',
})
export class Chat implements OnInit, OnDestroy {
  loading = true;
  error = '';

  sending = false;
  draft = '';

  messages: ChatMessage[] = [];
  pollHandle: ReturnType<typeof setInterval> | null = null;

  @ViewChild('scrollBox') scrollBox?: ElementRef<HTMLDivElement>;

  constructor(
    private chat: ChatService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadInitial();

    // lightweight polling keeps chat up to date without websockets
    this.pollHandle = setInterval(() => this.pollNew(), 2000);
  }

  ngOnDestroy(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private lastTimestamp(): string | null {
    const last = this.messages[this.messages.length - 1];
    return last?.created_at ?? null;
  }

  loadInitial(): void {
    this.loading = true;
    this.error = '';

    this.chat
      .listMessages(null, 50)
      .pipe(
        finalize(() => {
          this.loading = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (res) => {
          this.messages = res.messages ?? [];
          this.scrollToBottom();
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.error = this.extractError(err, 'Failed to load chat');
          this.cdr.detectChanges();
        },
      });
  }

  private pollNew(): void {
    if (this.loading) return;

    const after = this.lastTimestamp();
    this.chat.listMessages(after, 50).subscribe({
      next: (res) => {
        const incoming = res.messages ?? [];
        if (!incoming.length) return;

        // de-dupe by id in case poll window overlaps
        const existing = new Set(this.messages.map((m) => m.message_id));
        const fresh = incoming.filter((m) => !existing.has(m.message_id));

        if (fresh.length) {
          this.messages = [...this.messages, ...fresh];
          this.scrollToBottom();
          this.cdr.detectChanges();
        }
      },
      error: () => {
      },
    });
  }

  send(): void {
    const text = this.draft.trim();
    if (!text) return;

    this.sending = true;
    this.error = '';

    this.chat
      .sendMessage(text)
      .pipe(
        finalize(() => {
          this.sending = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (res) => {
          this.draft = '';
          this.messages = [...this.messages, res.message];
          this.scrollToBottom();
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.error = this.extractError(err, 'Failed to send message');
          this.cdr.detectChanges();
        },
      });
  }

  private scrollToBottom(): void {
    // wait one tick so DOM has rendered newest message first
    setTimeout(() => {
      const el = this.scrollBox?.nativeElement;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    }, 0);
  }

  labelDate(iso: string | null): string {
    if (!iso) return '';
    const t = iso.split('T')[1] || '';
    return t.slice(0, 5);
  }

  private extractError(err: unknown, fallback: string): string {
    const httpErr = err as { error?: any; message?: string; status?: number };
    const payload = httpErr?.error;
    const msg = payload?.error || payload?.message || httpErr?.message || fallback;
    return httpErr?.status ? `(${httpErr.status}) ${msg}` : msg;
  }
}
