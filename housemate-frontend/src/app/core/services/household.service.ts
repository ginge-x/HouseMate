import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ApiService } from './api.service';
import { catchError, map, of, timeout } from 'rxjs';

export interface Household {
  household_id: string;
  name: string;
  invite_code?: string;
  member_count?: number;
}

export interface HouseholdMember {
  user_id: string;
  email: string;
  role: 'admin' | 'member' | string;
}

type MyHouseHoldResponse = {
  household: Household | null;
};

@Injectable({ providedIn: 'root' })
export class HouseholdService {
  constructor(private http: HttpClient, private api: ApiService) {}

  getMyHousehold() {
    return this.http
      .get<MyHouseHoldResponse>(`${this.api.baseUrl}/households/me`)
      .pipe(timeout(10000))
      .pipe(map((res) => res.household ?? null))
      .pipe(
        catchError(() => {
          // tolerant mode: ui can still render setup flow on transient failures
          return of(null);
        })
      );
  }

  getMyHouseholdStrict() {
    // strict mode: surface backend errors to caller
    return this.http
      .get<MyHouseHoldResponse>(`${this.api.baseUrl}/households/me`)
      .pipe(timeout(10000))
      .pipe(map((res) => res.household ?? null));
  }

  createHousehold(name: string) {
    return this.http.post<Household>(`${this.api.baseUrl}/households`, { name }).pipe(timeout(10000));
  }

  joinHousehold(inviteCode: string) {
    return this.http
      .post<Household>(`${this.api.baseUrl}/households/join`, { invite_code: inviteCode })
      .pipe(timeout(10000));
  }

  getMembers() {
    return this.http.get<{ members: HouseholdMember[] }>(`${this.api.baseUrl}/households/members`);
  }

  leaveHousehold() {
    return this.http.post<{ ok: boolean }>(`${this.api.baseUrl}/households/leave`, {});
  }

  rotateInviteCode() {
    return this.http.post<{ invite_code: string }>(`${this.api.baseUrl}/households/invite-code/rotate`, {});
  }

  setMemberRole(userId: string, role: 'admin' | 'member') {
    return this.http.patch<{ ok: boolean }>(`${this.api.baseUrl}/households/members/${userId}/role`, { role });
  }

  removeMember(userId: string) {
    return this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/households/members/${userId}`);
  }
}
