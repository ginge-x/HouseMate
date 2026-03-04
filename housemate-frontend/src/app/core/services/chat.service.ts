import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { ApiService } from './api.service';
import { Observable } from 'rxjs';

export type ChatMessage = {
  message_id: string;
  user_id: string | null;
  email: string | null;
  is_you: boolean;
  text: string;
  created_at: string | null;
};

@Injectable({ providedIn: 'root' })
export class ChatService {
  constructor(private http: HttpClient, private api: ApiService) {}

  listMessages(after?: string | null, limit = 50): Observable<{ messages: ChatMessage[] }> {
    // after supports incremental polling for new messages
    let params = new HttpParams().set('limit', String(limit));
    if (after) params = params.set('after', after);
    return this.http.get<{ messages: ChatMessage[] }>(`${this.api.baseUrl}/chat/messages`, { params });
  }

  sendMessage(text: string): Observable<{ message: ChatMessage }> {
    return this.http.post<{ message: ChatMessage }>(`${this.api.baseUrl}/chat/messages`, { text });
  }
}
