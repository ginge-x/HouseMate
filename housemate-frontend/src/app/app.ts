import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './core/services/auth.service';

@Component({
  selector: 'app-root',
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('housemate-frontend');

  constructor(private auth: AuthService, private router: Router) {}

  get isLoggedIn(): boolean {
    return !!this.auth.token;
  }

  get onAuthPage(): boolean {
    return this.router.url.startsWith('/login') || this.router.url.startsWith('/register');
  }

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
