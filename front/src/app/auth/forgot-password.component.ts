import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { contactEmailValidator } from '../shared/contact-validators';
import { ApiService } from '../services/api.service';
import { ApiErrorMessageService } from '../services/api-error-message.service';
import { LanguagePickerComponent } from '../shared/language-picker.component';

@Component({
  selector: 'app-forgot-password',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, TranslateModule, LanguagePickerComponent],
  template: `
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-header">
          <div class="auth-header-row">
            <div>
              <h1>{{ 'AUTH.FORGOT_TITLE' | translate }}</h1>
              <p>{{ 'AUTH.FORGOT_DESC' | translate }}</p>
            </div>
            @if (!isProvider()) {
              <app-language-picker></app-language-picker>
            }
          </div>
        </div>

        @if (done()) {
          <p class="success-msg">{{ successMessage() }}</p>
          <a [routerLink]="loginPath" [queryParams]="loginQueryParams" class="btn-link">{{ 'AUTH.BACK_TO_LOGIN' | translate }}</a>
        } @else {
          <form [formGroup]="form" (ngSubmit)="onSubmit()">
            <div class="form-group">
              <label for="email">{{ 'AUTH.EMAIL' | translate }}</label>
              <input
                id="email"
                type="email"
                formControlName="email"
                [placeholder]="translate.instant('AUTH.EMAIL_PLACEHOLDER')"
                autocomplete="email"
              >
            </div>
            @if (error()) {
              <div class="error-banner">{{ error() }}</div>
            }
            <button type="submit" class="btn-submit" [disabled]="form.invalid || loading()">
              {{ loading() ? ('AUTH.REQUESTING_RESET' | translate) : ('AUTH.REQUEST_RESET' | translate) }}
            </button>
          </form>
          <div class="auth-footer">
            <a [routerLink]="loginPath" [queryParams]="loginQueryParams">{{ 'AUTH.BACK_TO_LOGIN' | translate }}</a>
          </div>
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
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      font-size: 1rem;
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
    .auth-footer {
      margin-top: var(--space-5);
      text-align: center;
    }
    .auth-footer a, .btn-link {
      color: var(--color-primary);
      font-weight: 500;
      text-decoration: none;
      display: inline-block;
    }
    .btn-link {
      width: 100%;
      text-align: center;
      padding: var(--space-3);
    }
    .auth-footer a:hover, .btn-link:hover {
      text-decoration: underline;
    }
  `],
})
export class ForgotPasswordComponent {
  private fb = inject(FormBuilder);
  private api = inject(ApiService);
  private apiErr = inject(ApiErrorMessageService);
  private route = inject(ActivatedRoute);
  translate = inject(TranslateService);

  resetScope = signal(
    this.route.snapshot.data['passwordResetScope'] as
      | 'provider'
      | 'courier'
      | 'platform'
      | 'customer'
      | undefined,
  );
  isProvider = signal(this.resetScope() === 'provider');
  loginPath = ({
    provider: '/provider/login',
    courier: '/courier/login',
    platform: '/platform/login',
    customer: '/customer/login',
  } as Record<string, string>)[this.resetScope() || ''] || '/login';
  loginQueryParams: Record<string, string> = (() => {
    const t = this.route.snapshot.queryParamMap.get('tenant');
    const out: Record<string, string> = {};
    if (t) {
      out['tenant'] = t;
    }
    return out;
  })();

  error = signal('');
  loading = signal(false);
  done = signal(false);
  successMessage = signal('');

  form = this.fb.group({
    email: ['', [Validators.required, contactEmailValidator]],
  });

  onSubmit() {
    if (!this.form.valid) return;
    this.error.set('');
    this.loading.set(true);
    const email = this.form.get('email')?.value ?? '';
    const tenantRaw = this.route.snapshot.queryParamMap.get('tenant');
    let tenantId: number | undefined;
    if (tenantRaw != null) {
      const n = parseInt(tenantRaw, 10);
      tenantId = isNaN(n) ? undefined : n;
    }
    const scope = this.resetScope();
    this.api.requestPasswordReset(email, tenantId, scope).subscribe({
      next: (res) => {
        this.loading.set(false);
        this.successMessage.set(res.message || this.translate.instant('AUTH.RESET_EMAIL_SENT'));
        this.done.set(true);
      },
      error: (err) => {
        this.loading.set(false);
        if (err.status === 429) {
          this.error.set(this.apiErr.fromHttpError(err, 'FEEDBACK.RATE_LIMIT'));
        } else {
          this.error.set(this.apiErr.fromHttpError(err, 'COMMON.API_REQUEST_FAILED'));
        }
      },
    });
  }
}
