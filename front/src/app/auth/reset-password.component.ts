import { Component, inject, OnInit, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ApiService } from '../services/api.service';
import { LanguagePickerComponent } from '../shared/language-picker.component';

@Component({
  selector: 'app-reset-password',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, TranslateModule, LanguagePickerComponent],
  template: `
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-header">
          <div class="auth-header-row">
            <div>
              <h1>{{ 'AUTH.RESET_PASSWORD_TITLE' | translate }}</h1>
              <p>{{ 'AUTH.RESET_PASSWORD_DESC' | translate }}</p>
            </div>
            <app-language-picker></app-language-picker>
          </div>
        </div>

        @if (tokenMissing()) {
          <div class="error-banner">{{ 'AUTH.RESET_TOKEN_MISSING' | translate }}</div>
          <a [routerLink]="loginPath" class="btn-link">{{ 'AUTH.BACK_TO_LOGIN' | translate }}</a>
        } @else if (done()) {
          <p class="success-msg">{{ 'AUTH.RESET_SUCCESS' | translate }}</p>
          <a [routerLink]="loginPath" class="btn-link">{{ 'AUTH.BACK_TO_LOGIN' | translate }}</a>
        } @else {
          <form [formGroup]="form" (ngSubmit)="onSubmit()">
            <div class="form-group">
              <label for="password">{{ 'AUTH.NEW_PASSWORD' | translate }}</label>
              <div class="input-with-toggle">
                <input
                  id="password"
                  [type]="showPassword() ? 'text' : 'password'"
                  formControlName="password"
                  [placeholder]="translate.instant('AUTH.NEW_PASSWORD_PLACEHOLDER')"
                  autocomplete="new-password"
                >
                <button
                  type="button"
                  class="pw-toggle"
                  (click)="showPassword.set(!showPassword())"
                  [attr.aria-label]="showPassword() ? ('AUTH.HIDE_PASSWORD' | translate) : ('AUTH.SHOW_PASSWORD' | translate)"
                  tabindex="-1"
                >
                  @if (showPassword()) {
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  } @else {
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  }
                </button>
              </div>
            </div>
            <div class="form-group">
              <label for="password2">{{ 'AUTH.CONFIRM_PASSWORD' | translate }}</label>
              <div class="input-with-toggle">
                <input
                  id="password2"
                  [type]="showPassword2() ? 'text' : 'password'"
                  formControlName="password_confirm"
                  [placeholder]="translate.instant('AUTH.CONFIRM_PASSWORD_PLACEHOLDER')"
                  autocomplete="new-password"
                >
                <button
                  type="button"
                  class="pw-toggle"
                  (click)="showPassword2.set(!showPassword2())"
                  [attr.aria-label]="showPassword2() ? ('AUTH.HIDE_PASSWORD' | translate) : ('AUTH.SHOW_PASSWORD' | translate)"
                  tabindex="-1"
                >
                  @if (showPassword2()) {
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  } @else {
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  }
                </button>
              </div>
            </div>
            @if (form.errors?.['mismatch'] && form.get('password_confirm')?.touched) {
              <div class="error-banner">{{ 'AUTH.PASSWORDS_DO_NOT_MATCH' | translate }}</div>
            }
            @if (error()) {
              <div class="error-banner">{{ error() }}</div>
            }
            <button type="submit" class="btn-submit" [disabled]="form.invalid || loading()">
              {{ loading() ? ('AUTH.SAVING' | translate) : ('AUTH.SAVE_NEW_PASSWORD' | translate) }}
            </button>
          </form>
        }
      </div>
    </div>
  `,
  styles: [`
    .auth-page {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-5);
      background: var(--color-bg);
    }
    .auth-card {
      width: 100%;
      max-width: 400px;
      background: var(--color-surface);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      padding: var(--space-8);
    }
    .auth-header {
      margin-bottom: var(--space-6);
    }
    .auth-header-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: var(--space-4);
    }
    .auth-header h1 {
      font-size: 1.75rem;
      font-weight: 600;
      color: var(--color-text);
      margin-bottom: var(--space-2);
    }
    .auth-header p {
      color: var(--color-text-muted);
      font-size: 0.9375rem;
    }
    .form-group {
      margin-bottom: var(--space-4);
    }
    .form-group label {
      display: block;
      margin-bottom: var(--space-2);
      font-weight: 500;
      color: var(--color-text);
    }
    .form-group input {
      width: 100%;
      padding: var(--space-3);
      padding-right: 2.75rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      font-size: 1rem;
    }
    .input-with-toggle {
      position: relative;
      display: flex;
    }
    .pw-toggle {
      position: absolute;
      right: var(--space-2);
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      padding: var(--space-1);
      cursor: pointer;
      color: var(--color-text-muted);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .pw-toggle:hover {
      color: var(--color-text);
    }
    .error-banner {
      background: rgba(220, 38, 38, 0.1);
      color: var(--color-error);
      padding: var(--space-3) var(--space-4);
      border-radius: var(--radius-md);
      font-size: 0.875rem;
      margin-bottom: var(--space-4);
    }
    .success-msg {
      color: var(--color-text);
      line-height: 1.5;
      margin-bottom: var(--space-5);
    }
    .btn-submit {
      width: 100%;
      padding: var(--space-4);
      background: var(--color-primary);
      color: white;
      border: none;
      border-radius: var(--radius-md);
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
    }
    .btn-submit:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .btn-submit:hover:not(:disabled) {
      background: var(--color-primary-hover);
    }
    .btn-link {
      display: inline-block;
      width: 100%;
      text-align: center;
      padding: var(--space-3);
      color: var(--color-primary);
      font-weight: 500;
      text-decoration: none;
    }
    .btn-link:hover {
      text-decoration: underline;
    }
  `],
})
export class ResetPasswordComponent implements OnInit {
  private fb = inject(FormBuilder);
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  translate = inject(TranslateService);

  token = '';
  tokenMissing = signal(false);
  error = signal('');
  loading = signal(false);
  done = signal(false);
  showPassword = signal(false);
  showPassword2 = signal(false);
  resetScope = this.route.snapshot.data['passwordResetScope'] as 'customer' | undefined;
  loginPath = this.resetScope === 'customer' ? '/customer/login' : '/login';

  form = this.fb.group(
    {
      password: ['', [Validators.required, Validators.minLength(8)]],
      password_confirm: ['', Validators.required],
    },
    { validators: ResetPasswordComponent.passwordsMatch },
  );

  static passwordsMatch(group: import('@angular/forms').AbstractControl) {
    const p = group.get('password')?.value;
    const c = group.get('password_confirm')?.value;
    if (p && c && p !== c) {
      return { mismatch: true };
    }
    return null;
  }

  ngOnInit() {
    const first = this.route.snapshot.queryParamMap.get('token')?.trim() ?? '';
    this.token = first;
    this.tokenMissing.set(!first);
    this.route.queryParamMap.subscribe((q) => {
      const t = q.get('token')?.trim() ?? '';
      this.token = t;
      this.tokenMissing.set(!t);
    });
  }

  onSubmit() {
    if (!this.form.valid || !this.token) return;
    this.error.set('');
    this.loading.set(true);
    const password = this.form.get('password')?.value ?? '';
    this.api.confirmPasswordReset(this.token, password, this.resetScope).subscribe({
      next: () => {
        this.loading.set(false);
        this.done.set(true);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(err.error?.detail || 'Reset failed');
      },
    });
  }
}
