import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ApiService } from './api.service';
import { tap } from 'rxjs/operators';
import { Observable } from 'rxjs';

export interface Me {
  _id: string;
  email: string;
  household_id: string | null;
  role: 'admin' | 'member';
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private tokenKey = 'housemate_token';

  constructor(private http: HttpClient, private api: ApiService) {}

  get token(): string | null {
    // jwt is persisted so refresh keeps user signed in
    return localStorage.getItem(this.tokenKey);
  }

  register(email: string, password: string) {
    return this.http
      .post<{ access_token: string }>(`${this.api.baseUrl}/auth/register`, { email, password })
      // store token immediately so guarded routes work after register
      .pipe(tap((res) => localStorage.setItem(this.tokenKey, res.access_token)));
  }

  login(email: string, password: string) {
    return this.http
      .post<{ access_token: string }>(`${this.api.baseUrl}/auth/login`, { email, password })
      // same token handling as register path
      .pipe(tap((res) => localStorage.setItem(this.tokenKey, res.access_token)));
  }

  getMe(): Observable<Me> {
    return this.http.get<Me>(`${this.api.baseUrl}/auth/me`);
  }

  logout() {
    localStorage.removeItem(this.tokenKey);
  }
}
