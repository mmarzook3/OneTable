import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import {
  ApiService,
  PlatformRestaurantCredentials,
} from '../services/api.service';

@Component({
  selector: 'app-platform-create-restaurant',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, TranslateModule],
  template: `
    <main class="provision-page">
      <a routerLink="/platform" class="back-link">{{ 'PLATFORM_CREATE.BACK' | translate }}</a>

      <header class="page-heading">
        <p class="eyebrow">{{ 'PLATFORM_CREATE.EYEBROW' | translate }}</p>
        <h1>{{ 'PLATFORM_CREATE.TITLE' | translate }}</h1>
        <p>{{ 'PLATFORM_CREATE.SUBTITLE' | translate }}</p>
      </header>

      @if (!credentials()) {
        <form [formGroup]="form" (ngSubmit)="createRestaurant()" class="provision-card" data-testid="platform-create-restaurant-form">
          <div class="form-field">
            <label for="restaurant-name">{{ 'PLATFORM_CREATE.RESTAURANT_NAME' | translate }}</label>
            <p class="field-help" id="restaurant-name-help">{{ 'PLATFORM_CREATE.RESTAURANT_NAME_HELP' | translate }}</p>
            <input id="restaurant-name" formControlName="restaurant_name" aria-describedby="restaurant-name-help" data-testid="platform-restaurant-name" />
          </div>

          <div class="form-field">
            <label for="owner-name">{{ 'PLATFORM_CREATE.OWNER_NAME' | translate }}</label>
            <p class="field-help" id="owner-name-help">{{ 'PLATFORM_CREATE.OWNER_NAME_HELP' | translate }}</p>
            <input id="owner-name" formControlName="owner_name" aria-describedby="owner-name-help" data-testid="platform-owner-name" />
          </div>

          <div class="form-field">
            <label for="owner-email">{{ 'PLATFORM_CREATE.OWNER_EMAIL' | translate }}</label>
            <p class="field-help" id="owner-email-help">{{ 'PLATFORM_CREATE.OWNER_EMAIL_HELP' | translate }}</p>
            <input id="owner-email" type="email" formControlName="owner_email" aria-describedby="owner-email-help" autocomplete="off" data-testid="platform-owner-email" />
          </div>

          @if (error()) {
            <p class="error-banner" role="alert" data-testid="platform-create-error">{{ error() }}</p>
          }

          <button class="primary-button" type="submit" [disabled]="form.invalid || loading()" data-testid="platform-create-submit">
            {{ (loading() ? 'PLATFORM_CREATE.CREATING' : 'PLATFORM_CREATE.CREATE') | translate }}
          </button>
        </form>
      } @else {
        <section class="credentials-card" aria-live="polite" data-testid="platform-created-credentials">
          <div class="success-heading">
            <span class="success-mark" aria-hidden="true">✓</span>
            <div>
              <p class="eyebrow">{{ 'PLATFORM_CREATE.READY_EYEBROW' | translate }}</p>
              <h2>{{ credentials()!.restaurant_name }}</h2>
              <p>{{ 'PLATFORM_CREATE.READY_HELP' | translate }}</p>
            </div>
          </div>

          <div class="credential-row">
            <div>
              <span>{{ 'PLATFORM_CREATE.SIGN_IN_EMAIL' | translate }}</span>
              <strong data-testid="created-username">{{ credentials()!.username }}</strong>
            </div>
            <button type="button" class="copy-button" (click)="copy(credentials()!.username, 'username')">
              {{ copied() === 'username' ? ('PLATFORM_CREATE.COPIED' | translate) : ('PLATFORM_CREATE.COPY' | translate) }}
            </button>
          </div>

          <div class="credential-row">
            <div>
              <span>{{ 'PLATFORM_CREATE.TEMP_PASSWORD' | translate }}</span>
              <strong class="password-value" data-testid="created-temporary-password">{{ credentials()!.temporary_password }}</strong>
            </div>
            <button type="button" class="copy-button" (click)="copy(credentials()!.temporary_password, 'password')">
              {{ copied() === 'password' ? ('PLATFORM_CREATE.COPIED' | translate) : ('PLATFORM_CREATE.COPY' | translate) }}
            </button>
          </div>

          @if (credentials()!.password_setup_url) {
            <div class="setup-link">
              <span>{{ 'PLATFORM_CREATE.PASSWORD_LINK' | translate }}</span>
              <a [href]="credentials()!.password_setup_url!" target="_blank" rel="noopener noreferrer">
                {{ 'PLATFORM_CREATE.OPEN_PASSWORD_LINK' | translate }}
              </a>
            </div>
          }

          <aside class="security-note">
            <strong>{{ 'PLATFORM_CREATE.SAVE_NOW' | translate }}</strong>
            <p>{{ 'PLATFORM_CREATE.SAVE_NOW_HELP' | translate }}</p>
          </aside>

          <div class="result-actions">
            <a [routerLink]="['/platform/tenants', credentials()!.tenant_id]" class="secondary-button">
              {{ 'PLATFORM_CREATE.VIEW_RESTAURANT' | translate }}
            </a>
            <button type="button" class="primary-button" (click)="createAnother()">
              {{ 'PLATFORM_CREATE.CREATE_ANOTHER' | translate }}
            </button>
          </div>
        </section>
      }
    </main>
  `,
  styles: [`
    .provision-page {
      min-height: 100vh;
      max-width: 760px;
      margin: 0 auto;
      padding: var(--space-6);
      color: var(--color-text);
    }
    .back-link { display: inline-block; margin-bottom: var(--space-6); font-size: 0.9rem; }
    .page-heading { margin-bottom: var(--space-6); }
    .page-heading h1, .success-heading h2 { margin: 0 0 var(--space-2); }
    .page-heading > p:last-child, .success-heading p { color: var(--color-text-muted); margin: 0; line-height: 1.6; }
    .eyebrow { color: var(--color-primary); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin: 0 0 var(--space-2); }
    .provision-card, .credentials-card {
      padding: clamp(var(--space-5), 5vw, var(--space-8));
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
    }
    .form-field { margin-bottom: var(--space-5); }
    label { display: block; font-weight: 600; margin-bottom: var(--space-1); }
    .field-help { color: var(--color-text-muted); font-size: 0.85rem; line-height: 1.45; margin: 0 0 var(--space-2); }
    input {
      width: 100%; box-sizing: border-box; padding: var(--space-3); border: 1px solid var(--color-border);
      border-radius: var(--radius-md); background: var(--color-bg); color: var(--color-text); font: inherit;
    }
    input:focus { outline: 2px solid var(--color-primary); outline-offset: 2px; }
    .primary-button, .secondary-button, .copy-button {
      min-height: 44px; border-radius: var(--radius-md); font: inherit; font-weight: 600; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center; text-decoration: none;
    }
    .primary-button { border: 0; padding: 0 var(--space-5); color: white; background: var(--color-primary); }
    .primary-button:disabled { opacity: 0.55; cursor: wait; }
    .secondary-button, .copy-button { border: 1px solid var(--color-border); padding: 0 var(--space-4); color: var(--color-text); background: var(--color-surface); }
    .error-banner { color: var(--color-error); background: rgba(220, 38, 38, 0.08); padding: var(--space-3); border-radius: var(--radius-md); }
    .success-heading { display: flex; gap: var(--space-4); align-items: flex-start; margin-bottom: var(--space-6); }
    .success-mark { width: 2.5rem; height: 2.5rem; display: grid; place-items: center; flex: 0 0 auto; border-radius: 50%; background: #e8f7ee; color: #18794e; font-weight: 800; }
    .credential-row { display: flex; justify-content: space-between; align-items: center; gap: var(--space-4); padding: var(--space-4) 0; border-top: 1px solid var(--color-border); }
    .credential-row span, .setup-link span { display: block; color: var(--color-text-muted); font-size: 0.8rem; margin-bottom: var(--space-1); }
    .credential-row strong { display: block; overflow-wrap: anywhere; }
    .password-value { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: 0.03em; }
    .setup-link { padding: var(--space-4) 0; border-top: 1px solid var(--color-border); }
    .security-note { margin-top: var(--space-4); padding: var(--space-4); border-radius: var(--radius-md); background: var(--color-bg); }
    .security-note p { color: var(--color-text-muted); margin: var(--space-1) 0 0; line-height: 1.5; }
    .result-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-6); }
    @media (max-width: 560px) {
      .provision-page { padding: var(--space-4); }
      .credential-row { align-items: flex-start; flex-direction: column; }
      .result-actions > * { width: 100%; }
    }
  `],
})
export class PlatformCreateRestaurantComponent {
  private fb = inject(FormBuilder);
  private api = inject(ApiService);

  loading = signal(false);
  error = signal('');
  credentials = signal<PlatformRestaurantCredentials | null>(null);
  copied = signal<'username' | 'password' | null>(null);

  form = this.fb.nonNullable.group({
    restaurant_name: ['', [Validators.required, Validators.minLength(2)]],
    owner_name: [''],
    owner_email: ['', [Validators.required, Validators.email]],
  });

  createRestaurant(): void {
    if (this.form.invalid || this.loading()) {
      this.form.markAllAsTouched();
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.api.createPlatformRestaurant(this.form.getRawValue()).subscribe({
      next: (result) => {
        this.credentials.set(result);
        this.loading.set(false);
      },
      error: (error) => {
        this.error.set(error?.error?.detail || 'Could not create the restaurant account.');
        this.loading.set(false);
      },
    });
  }

  async copy(value: string, field: 'username' | 'password'): Promise<void> {
    await navigator.clipboard.writeText(value);
    this.copied.set(field);
    window.setTimeout(() => this.copied.set(null), 1600);
  }

  createAnother(): void {
    this.form.reset();
    this.credentials.set(null);
    this.copied.set(null);
  }
}

