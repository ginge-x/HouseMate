import { Routes } from '@angular/router';
import { Login } from './components/login/login';
import { Register } from './components/register/register';
import { Household } from './components/household/household';
import { authGuard } from './core/guards/auth.guard';
import { Bills } from './components/bills/bills';
import { BillDetail } from './components/bill-detail/bill-detail';
import { Chores } from './components/chores/chores';
import { Dashboard } from './components/dashboard/dashboard';
import {Requests} from './components/requests/requests';
import { Chat } from './components/chat/chat';
import { Reminders } from './components/reminders/reminders';
import { Analytics } from './components/analytics/analytics';


export const routes: Routes = [

  { path: '', redirectTo: 'login', pathMatch: 'full' },

  { path: 'login', component: Login },
  { path: 'register', component: Register },
  { path: 'dashboard', component: Dashboard, canActivate: [authGuard] },
  { path: 'household', component: Household, canActivate: [authGuard] },
  { path: 'bills/:billId', component: BillDetail, canActivate: [authGuard] },
  { path: 'bills', component: Bills, canActivate: [authGuard] },
  { path: 'chores', component: Chores, canActivate: [authGuard] },
  {path: 'requests', component: Requests, canActivate: [authGuard]},
  {path: 'chat', component: Chat, canActivate: [authGuard]},
  {path: 'reminders', component: Reminders, canActivate: [authGuard]},
  {path: 'analytics', component: Analytics, canActivate: [authGuard]},

  { path: '**', redirectTo: 'login' }

];
