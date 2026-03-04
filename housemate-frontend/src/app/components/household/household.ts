import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import {
  HouseholdService,
  Household as HouseholdData,
  HouseholdMember,
} from '../../core/services/household.service';
import { AuthService, Me } from '../../core/services/auth.service';
import { finalize } from 'rxjs';
import { FormBuilder, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';

type CreateHouseholdForm = FormGroup<{
  name: FormControl<string>;
}>;

type JoinHouseholdForm = FormGroup<{
  inviteCode: FormControl<string>;
}>;

@Component({
  selector: 'app-household',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './household.html',
})
export class Household implements OnInit, OnDestroy {
  loading = true;
  error = '';
  setupError = '';

  creating = false;
  joining = false;

  household: HouseholdData | null = null;
  private loadWatchdog: ReturnType<typeof setTimeout> | null = null;

  // Admin UI state
  me: Me | null = null;
  members: HouseholdMember[] = [];
  membersLoading = false;
  membersError = '';

  rotatingInvite = false;
  leaving = false;
  updatingRoleFor: string | null = null;
  removingMemberId: string | null = null;

  createForm: CreateHouseholdForm;
  joinForm: JoinHouseholdForm;

  constructor(
    private householdService: HouseholdService,
    private auth: AuthService,
    private router: Router,
    private fb: FormBuilder,
    private cdr: ChangeDetectorRef
  ) {
    this.createForm = this.fb.nonNullable.group({
      name: ['', [Validators.required, Validators.minLength(2)]],
    });

    this.joinForm = this.fb.nonNullable.group({
      inviteCode: ['', [Validators.required, Validators.minLength(6)]],
    });
  }

  get createNameControl(): FormControl<string> {
    return this.createForm.controls.name;
  }

  get joinInviteCodeControl(): FormControl<string> {
    return this.joinForm.controls.inviteCode;
  }

  get isAdmin(): boolean {
    return this.me?.role === 'admin';
  }

  ngOnInit(): void {
    this.loadHousehold();
  }

  ngOnDestroy(): void {
    this.clearLoadWatchdog();
  }

  loadHousehold(): void {
    this.loading = true;
    this.error = '';
    this.setupError = '';
    this.startLoadWatchdog();
    this.cdr.detectChanges();

    this.householdService
      .getMyHousehold()
      .pipe(
        finalize(() => {
          this.loading = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (h) => {
          this.clearLoadWatchdog();
          this.household = h ?? null;

          if (this.household) {
            this.loadMeAndMembers();
          } else {
            this.me = null;
            this.members = [];
          }

          this.cdr.detectChanges();
        },
        error: (err) => {
          this.clearLoadWatchdog();
          const status = (err as { status?: number })?.status;
          if (status === 401 || status === 422) {
            this.auth.logout();
            this.router.navigate(['/login']);
            return;
          }

          this.error = this.extractError(err, 'Could not load household');
          this.cdr.detectChanges();
        },
      });
  }

  private loadMeAndMembers(): void {
    this.membersError = '';
    this.membersLoading = true;

    // Load /auth/me
    this.auth.getMe().subscribe({
      next: (me) => {
        this.me = me;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.membersError = this.extractError(err, 'Failed to load your profile');
        this.cdr.detectChanges();
      },
    });

    // Load /households/members
    this.householdService
      .getMembers()
      .pipe(
        finalize(() => {
          this.membersLoading = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (res) => {
          // Keep stable ordering
          this.members = [...(res.members || [])].sort((a, b) => a.email.localeCompare(b.email));
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.membersError = this.extractError(err, 'Failed to load members');
          this.cdr.detectChanges();
        },
      });
  }

  refreshMembers(): void {
    if (!this.household) return;
    this.loadMeAndMembers();
  }

  async copyInviteCode(): Promise<void> {
    const code = this.household?.invite_code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
    }
  }

  rotateInviteCode(): void {
    if (!this.isAdmin || !this.household) return;

    this.rotatingInvite = true;
    this.membersError = '';

    this.householdService
      .rotateInviteCode()
      .pipe(
        finalize(() => {
          this.rotatingInvite = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (res) => {
          this.household = { ...this.household!, invite_code: res.invite_code };
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.membersError = this.extractError(err, 'Could not rotate invite code');
          this.cdr.detectChanges();
        },
      });
  }

  setRole(member: HouseholdMember, role: 'admin' | 'member'): void {
    if (!this.isAdmin) return;
    if (this.updatingRoleFor) return;

    this.updatingRoleFor = member.user_id;
    this.membersError = '';

    this.householdService
      .setMemberRole(member.user_id, role)
      .pipe(
        finalize(() => {
          this.updatingRoleFor = null;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: () => this.refreshMembers(),
        error: (err) => {
          this.membersError = this.extractError(err, 'Could not update role');
          this.cdr.detectChanges();
        },
      });
  }

  removeMember(member: HouseholdMember): void {
    if (!this.isAdmin) return;
    if (this.removingMemberId) return;

    const ok = confirm(`Remove ${member.email} from the household?`);
    if (!ok) return;

    this.removingMemberId = member.user_id;
    this.membersError = '';

    this.householdService
      .removeMember(member.user_id)
      .pipe(
        finalize(() => {
          this.removingMemberId = null;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: () => this.refreshMembers(),
        error: (err) => {
          this.membersError = this.extractError(err, 'Could not remove member');
          this.cdr.detectChanges();
        },
      });
  }

  leaveHousehold(): void {
    if (!this.household) return;
    if (this.leaving) return;

    const ok = confirm('Leave this household?');
    if (!ok) return;

    this.leaving = true;
    this.membersError = '';

    this.householdService
      .leaveHousehold()
      .pipe(
        finalize(() => {
          this.leaving = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: () => {
          this.household = null;
          this.me = null;
          this.members = [];
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.membersError = this.extractError(err, 'Could not leave household');
          this.cdr.detectChanges();
        },
      });
  }

  private startLoadWatchdog(): void {
    this.clearLoadWatchdog();
    this.loadWatchdog = setTimeout(() => {
      if (!this.loading) {
        return;
      }

      this.loading = false;
      this.household = null;
      this.error = '';
      this.setupError = 'Household lookup timed out. You can still create or join a household below.';
      this.cdr.detectChanges();
    }, 12000);
  }

  private clearLoadWatchdog(): void {
    if (this.loadWatchdog) {
      clearTimeout(this.loadWatchdog);
      this.loadWatchdog = null;
    }
  }

  createHousehold(): void {
    this.setupError = '';
    if (this.createForm.invalid) {
      this.createForm.markAllAsTouched();
      return;
    }

    const name = this.createForm.controls.name.value.trim();
    if (!name) {
      this.setupError = 'Household name is required.';
      return;
    }

    this.creating = true;
    this.householdService
      .createHousehold(name)
      .pipe(
        finalize(() => {
          this.creating = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (createdHousehold) => {
          this.household = createdHousehold;
          this.error = '';
          this.setupError = '';
          this.createForm.reset();
          this.joinForm.reset();
          this.loadMeAndMembers();
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.setupError = this.extractError(err, 'Could not create household');
          this.cdr.detectChanges();
        },
      });
  }

  joinHousehold(): void {
    this.setupError = '';
    if (this.joinForm.invalid) {
      this.joinForm.markAllAsTouched();
      return;
    }

    const inviteCode = this.joinForm.controls.inviteCode.value.trim().toUpperCase();
    if (!inviteCode) {
      this.setupError = 'Invite code is required.';
      return;
    }

    this.joining = true;
    this.householdService
      .joinHousehold(inviteCode)
      .pipe(
        finalize(() => {
          this.joining = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (joinedHousehold) => {
          this.household = joinedHousehold;
          this.error = '';
          this.setupError = '';
          this.createForm.reset();
          this.joinForm.reset();
          this.loadMeAndMembers();
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.setupError = this.extractError(err, 'Could not join household');
          this.cdr.detectChanges();
        },
      });
  }

  private extractError(err: unknown, fallback: string): string {
    const httpErr = err as {
      error?: { error?: string; message?: string };
      message?: string;
      status?: number;
    };
    const msg = httpErr?.error?.error || httpErr?.error?.message || httpErr?.message || fallback;
    return httpErr?.status ? `(${httpErr.status}) ${msg}` : msg;
  }

  logout() {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
