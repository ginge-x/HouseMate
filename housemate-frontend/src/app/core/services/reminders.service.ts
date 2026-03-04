import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { ApiService } from './api.service';
import { Observable } from 'rxjs';

export type ReminderBill = {
  type: 'bill';
  bill_id: string;
  title: string;
  amount: number;
  due_date: string;
  days_until_due: number;
  is_overdue: boolean;
  in_reminder_window: boolean;
  split_type: string;
  your_share: number | null;
  you_paid: boolean | null;
  recurrence: any | null;
  reminder_days_before: number;
};

export type ReminderChore = {
  type: 'chore';
  chore_id: string;
  title: string;
  assigned_to: string | null;
  due_date: string;
  days_until_due: number;
  is_overdue: boolean;
  in_reminder_window: boolean;
  recurrence: any | null;
  reminder_days_before: number;
};

export type RemindersResponse = {
  today: string;
  range_days: number;
  bills: ReminderBill[];
  chores: ReminderChore[];
};

@Injectable({ providedIn: 'root' })
export class RemindersService {
  constructor(private http: HttpClient, private api: ApiService) {}

  get(days = 7): Observable<RemindersResponse> {
    const params = new HttpParams().set('days', String(days));
    return this.http.get<RemindersResponse>(`${this.api.baseUrl}/reminders`, { params });
  }
}
