import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ApiService } from './api.service';
import { tap } from 'rxjs/operators';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private tokenKey = 'housemate_token';

  constructor(private http: HttpClient, private api: ApiService) {}

  get token(): string | null {
    return localStorage.getItem(this.tokenKey);
  }

  register(email: string, password: string) {
    return this.http.post<{access_token: string}>(`${this.api.baseUrl}/auth/register`, { email, password })
      .pipe(tap(res => localStorage.setItem(this.tokenKey, res.access_token)));
  }

  login(email: string, password: string) {
    return this.http.post<{access_token: string}>(`${this.api.baseUrl}/auth/login`, { email, password })
      .pipe(tap(res => localStorage.setItem(this.tokenKey, res.access_token)));
  }

  logout() {
    localStorage.removeItem(this.tokenKey);
  }
}