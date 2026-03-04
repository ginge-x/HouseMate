import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ApiService } from './api.service';
import { Observable } from 'rxjs';

export type RequestSummary = {
  request_id: string;
  household_id: string;
  title: string;
  body: string;
  status: 'open' | 'done' | string;
  created_by: string | null;
  created_by_email: string | null;
  created_at: string | null;
  updated_at: string | null;
  comment_count: number;
  can_edit: boolean;
  can_delete: boolean;
};

export type RequestComment = {
  comment_id: string;
  user_id: string | null;
  email: string | null;
  body: string;
  created_at: string | null;
  can_delete: boolean;
};

export type RequestDetail = RequestSummary & {
  comments: RequestComment[];
};

@Injectable({ providedIn: 'root' })
export class RequestsService {
  constructor(private http: HttpClient, private api: ApiService) {}

  list(status: 'all' | 'open' | 'done' = 'all'): Observable<{ requests: RequestSummary[] }> {
    // list endpoint handles server-side status filtering
    return this.http.get<{ requests: RequestSummary[] }>(`${this.api.baseUrl}/requests?status=${status}`);
  }

  get(requestId: string): Observable<{ request: RequestDetail }> {
    return this.http.get<{ request: RequestDetail }>(`${this.api.baseUrl}/requests/${requestId}`);
  }

  create(payload: { title: string; body: string }): Observable<{ request: RequestSummary }> {
    return this.http.post<{ request: RequestSummary }>(`${this.api.baseUrl}/requests`, payload);
  }

  update(requestId: string, payload: Partial<{ title: string; body: string; status: 'open' | 'done' }>) {
    return this.http.patch<{ request: RequestSummary }>(`${this.api.baseUrl}/requests/${requestId}`, payload);
  }

  remove(requestId: string) {
    return this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/requests/${requestId}`);
  }

  addComment(requestId: string, body: string) {
    return this.http.post<{ ok: boolean; comment_id: string }>(`${this.api.baseUrl}/requests/${requestId}/comments`, { body });
  }

  deleteComment(requestId: string, commentId: string) {
    return this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/requests/${requestId}/comments/${commentId}`);
  }
}
