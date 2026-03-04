import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export type Recurrence = {
  freq: string;     // daily | weekly | monthly
  interval: number; // >= 1
};

export type Chore = {
  chore_id: string;
  household_id: string;
  title: string;
  assigned_to: string | null;
  due_date: string | null;
  completed: boolean;
  completed_at: string | null;
  created_by?: string | null;
  archived?: boolean;
  archived_at?: string | null;
  archived_by?: string | null;
  created_at: string | null;

  // optional recurrence metadata for recurring chores
  recurrence?: Recurrence | null;
  reminder_days_before?: number;
};

@Injectable({ providedIn: 'root' })
export class ChoresService {
  constructor(private http: HttpClient, private api: ApiService) {}

  list(includeArchived = false): Observable<{ chores: Chore[] }> {
    // same archived toggle pattern as bills
    const query = includeArchived ? '?include_archived=true' : '';
    return this.http.get<{ chores: Chore[] }>(`${this.api.baseUrl}/chores${query}`);
  }

  create(payload: {
    title: string;
    due_date?: string | null;
    assigned_to?: string | 'auto';

    recurrence?: Recurrence | null;
    reminder_days_before?: number;
  }): Observable<any> {
    return this.http.post(`${this.api.baseUrl}/chores`, payload);
  }

  setComplete(choreId: string, completed: boolean): Observable<any> {
    return this.http.patch(`${this.api.baseUrl}/chores/${choreId}/complete`, { completed });
  }

  assign(choreId: string, assigned_to: string | 'auto'): Observable<any> {
    return this.http.patch(`${this.api.baseUrl}/chores/${choreId}/assign`, { assigned_to });
  }

  delete(choreId: string): Observable<any> {
    return this.http.delete(`${this.api.baseUrl}/chores/${choreId}`);
  }

  setArchived(choreId: string, archived: boolean): Observable<{ chore: Chore }> {
    return this.http.patch<{ chore: Chore }>(`${this.api.baseUrl}/chores/${choreId}/archive`, { archived });
  }
}
