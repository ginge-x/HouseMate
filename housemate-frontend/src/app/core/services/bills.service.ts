import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export type Recurrence = {
  freq: string;     // weekly | monthly | quarterly
  interval: number; // >= 1
};

export type Bill = {
  bill_id: string;
  household_id: string;
  title: string;
  amount: number;
  due_date: string | null;
  created_by: string | null;

  split_type: 'equal' | 'custom' | string;
  status: string;
  archived?: boolean;
  archived_at?: string | null;
  archived_by?: string | null;
  created_at: string | null;

  // optional recurrence metadata for recurring bills
  recurrence?: Recurrence | null;
  reminder_days_before?: number;

  your_share: number | null;
  you_paid: boolean | null;
  splits: BillSplit[];
};

export type BillSplit = {
  user_id: string | null;
  email: string | null;
  is_you: boolean;
  amount_owed: number;
  paid: boolean;
  paid_at: string | null;
};

export type CreateBillPayload = {
  title: string;
  amount: number;
  due_date?: string | null;
  split_type?: 'equal' | 'custom';
  splits?: Array<{ user_id: string; amount_owed: number }>;

  // optional recurrence config sent at create time
  recurrence?: Recurrence | null;
  reminder_days_before?: number;
};

@Injectable({ providedIn: 'root' })
export class BillsService {
  constructor(private http: HttpClient, private api: ApiService) {}

  listBills(includeArchived = false): Observable<{ bills: Bill[] }> {
    // default list excludes archived until user asks for history view
    const query = includeArchived ? '?include_archived=true' : '';
    return this.http.get<{ bills: Bill[] }>(`${this.api.baseUrl}/bills${query}`);
  }

  getBill(billId: string): Observable<{ bill: Bill }> {
    return this.http.get<{ bill: Bill }>(`${this.api.baseUrl}/bills/${billId}`);
  }

  createBill(payload: CreateBillPayload): Observable<{ bill: Bill }> {
    return this.http.post<{ bill: Bill }>(`${this.api.baseUrl}/bills`, payload);
  }

  setPaid(billId: string, paid: boolean): Observable<{ bill: Bill }> {
    return this.http.patch<{ bill: Bill }>(`${this.api.baseUrl}/bills/${billId}/pay`, { paid });
  }

  setArchived(billId: string, archived: boolean): Observable<{ bill: Bill }> {
    return this.http.patch<{ bill: Bill }>(`${this.api.baseUrl}/bills/${billId}/archive`, { archived });
  }

  deleteBill(billId: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`${this.api.baseUrl}/bills/${billId}`);
  }
}
