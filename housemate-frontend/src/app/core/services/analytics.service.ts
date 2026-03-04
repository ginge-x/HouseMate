import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { ApiService } from './api.service';
import { Observable } from 'rxjs';

export type SpendingResponse = {
  from: string | null;
  to: string | null;
  status: 'all' | 'open' | 'paid' | string;
  date_field: 'created_at' | 'due_date' | string;

  totals: {
    count: number;
    total: number;
    paid: number;
    open: number;
  };

  by_month: Array<{ month: string; count: number; total: number; paid: number; open: number }>;
  by_payer: Array<{ user_id: string; email: string | null; count: number; total: number }>;
  by_share: Array<{ user_id: string; email: string | null; bills_count: number; owed: number; paid: number; unpaid: number }>;
};

@Injectable({ providedIn: 'root' })
export class AnalyticsService {
  constructor(private http: HttpClient, private api: ApiService) {}

  spending(params: { from?: string; to?: string; status?: 'all' | 'open' | 'paid'; date_field?: 'created_at' | 'due_date' }): Observable<SpendingResponse> {
    let p = new HttpParams();
    if (params.from) p = p.set('from', params.from);
    if (params.to) p = p.set('to', params.to);
    // keep defaults server-compatible even when caller omits filters
    p = p.set('status', params.status ?? 'all');
    p = p.set('date_field', params.date_field ?? 'created_at');
    return this.http.get<SpendingResponse>(`${this.api.baseUrl}/analytics/spending`, { params: p });
  }
}
