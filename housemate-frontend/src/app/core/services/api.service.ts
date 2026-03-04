import {Injectable} from '@angular/core';

@Injectable({providedIn: 'root'})
export class ApiService {
    // single api origin shared across all services
    baseUrl = 'http://127.0.0.1:5000';
}
