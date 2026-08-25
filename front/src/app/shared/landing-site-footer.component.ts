import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../environments/environment';
import { ApiService, PlatformPublicSettings } from '../services/api.service';

/** Dark marketing footer shared by landing and features pages. */
@Component({
  selector: 'app-landing-site-footer',
  standalone: true,
  imports: [RouterLink, TranslateModule],
  template: `
    <footer class="landing-site-footer">
      <section class="landing-site-footer__cta" aria-labelledby="landing-bottom-cta-heading">
        <h2 id="landing-bottom-cta-heading" class="landing-site-footer__cta-title">
          {{ 'LANDING.BOTTOM_CTA_TITLE' | translate }}
        </h2>
        <p class="landing-site-footer__cta-text">{{ 'LANDING.BOTTOM_CTA_TEXT' | translate }}</p>
        <a routerLink="/register" class="landing-btn landing-btn--primary landing-btn--large">
          {{ 'LANDING.CTA_CREATE_QR_MENU' | translate }}
        </a>
      </section>

      <div class="landing-footer">
        <nav class="landing-footer__nav" aria-label="Footer">
          <div class="landing-footer__group">
            <span class="landing-footer__group-label">{{ 'LANDING.FOOTER_ACCOUNT' | translate }}</span>
            <a routerLink="/register">{{ 'AUTH.CREATE_ACCOUNT' | translate }}</a>
            <a routerLink="/login">{{ 'LANDING.LOGIN' | translate }}</a>
            <a routerLink="/pricing" data-testid="landing-pricing">{{ 'LANDING.NAV_PRICING' | translate }}</a>
            <a routerLink="/features">{{ 'LANDING.NAV_FEATURES' | translate }}</a>
          </div>
          <div class="landing-footer__group">
            <span class="landing-footer__group-label">{{ 'LANDING.FOOTER_PARTNERS' | translate }}</span>
            <a routerLink="/provider/login" data-testid="landing-provider-login">{{ 'LANDING.PROVIDER_LOGIN' | translate }}</a>
            <a routerLink="/provider/register" data-testid="landing-provider-register">{{ 'LANDING.REGISTER_AS_PROVIDER' | translate }}</a>
            <a routerLink="/courier/login" data-testid="landing-courier-login">{{ 'LANDING.COURIER_LOGIN' | translate }}</a>
          </div>
          <div class="landing-footer__group">
            <span class="landing-footer__group-label">{{ 'LANDING.FOOTER_SUPPORT' | translate }}</span>
            <a routerLink="/about" data-testid="landing-about">{{ 'LANDING.NAV_ABOUT' | translate }}</a>
            <a routerLink="/manual-usuario" data-testid="landing-user-manual">{{ 'LANDING.USER_MANUAL' | translate }}</a>
            <a [href]="platform()?.terms_url || '/terms'" data-testid="landing-terms">{{ 'LEGAL.TERMS_OF_SERVICE' | translate }}</a>
            <a [href]="platform()?.privacy_url || '/privacy'" data-testid="landing-privacy">{{ 'LEGAL.PRIVACY_POLICY' | translate }}</a>
            @if (platform()?.support_email) {
              <a [href]="'mailto:' + platform()!.support_email" data-testid="landing-support-email">{{ platform()!.support_email }}</a>
            }
            @if (platform()?.phone) {
              <a [href]="'tel:' + platform()!.phone" data-testid="landing-support-phone">{{ platform()!.phone }}</a>
            }
          </div>
        </nav>
      </div>

      <div class="landing-version-bar" data-testid="landing-version">
        <div class="landing-version-bar__row">
          <span class="landing-version-meta"
            >{{ version || '0.0.0' }} <span class="landing-commit">{{ commitHash || '' }}</span></span
          >
        </div>
        <p class="landing-version-company" data-testid="landing-company">
          {{ platform()?.company_legal_name || ('LANDING.COMPANY_OPERATOR' | translate) }}
        </p>
        @if (platform()?.company_number || platform()?.vat_number) {
          <p class="landing-version-company">
            @if (platform()?.company_number) { <span>Company {{ platform()!.company_number }}</span> }
            @if (platform()?.vat_number) { <span>VAT {{ platform()!.vat_number }}</span> }
          </p>
        }
        <p class="landing-version-tagline">{{ 'LANDING.PRODUCT_TAGLINE' | translate }}</p>
      </div>
    </footer>
  `,
  styles: [`
    :host {
      --landing-border: rgba(255, 255, 255, 0.1);
      --landing-text: #fafafa;
      --landing-muted: rgba(250, 250, 250, 0.62);
      display: block;
    }

    .landing-site-footer {
      position: relative;
      z-index: 2;
      margin-top: var(--space-4);
      border-top: 1px solid var(--landing-border);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.02) 0%, rgba(0, 0, 0, 0.35) 100%);
    }

    .landing-site-footer__cta {
      max-width: 72rem;
      margin: 0 auto;
      padding: var(--space-8) var(--space-5) var(--space-6);
      text-align: center;
    }

    .landing-site-footer__cta-title {
      margin: 0 0 var(--space-3);
      font-size: clamp(1.5rem, 4vw, 2rem);
      font-weight: 700;
      letter-spacing: -0.03em;
      color: var(--landing-text);
    }

    .landing-site-footer__cta-text {
      margin: 0 auto var(--space-6);
      max-width: 32rem;
      color: var(--landing-muted);
      line-height: 1.55;
    }

    .landing-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.875rem 1.375rem;
      border-radius: 999px;
      font-size: 0.9375rem;
      font-weight: 600;
      text-decoration: none;
      transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
    }

    .landing-btn:hover {
      text-decoration: none;
      transform: translateY(-1px);
    }

    .landing-btn--primary {
      background: #fff;
      color: #0a0a0b;
      box-shadow: 0 12px 40px rgba(255, 255, 255, 0.12);
    }

    .landing-btn--primary:hover {
      box-shadow: 0 16px 48px rgba(255, 255, 255, 0.18);
    }

    .landing-btn--large {
      padding: 1rem 1.75rem;
      font-size: 1rem;
    }

    .landing-footer {
      max-width: 72rem;
      margin: 0 auto;
      padding: var(--space-6) var(--space-5);
      border-top: 1px solid var(--landing-border);
    }

    .landing-footer__nav {
      display: grid;
      grid-template-columns: 1fr;
      gap: var(--space-6);
    }

    @media (min-width: 720px) {
      .landing-footer__nav {
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-5);
      }
    }

    .landing-footer__group {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-2);
    }

    .landing-footer__group-label {
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--landing-muted);
    }

    .landing-footer a {
      color: rgba(250, 250, 250, 0.88);
      font-size: 0.875rem;
      font-weight: 500;
      text-decoration: none;
      transition: color 0.15s ease;
    }

    .landing-footer a:hover {
      color: var(--landing-text);
      text-decoration: none;
    }

    .landing-version-bar {
      max-width: 72rem;
      margin: 0 auto;
      padding: var(--space-4) var(--space-5) var(--space-6);
      border-top: 1px solid var(--landing-border);
      font-size: 0.6875rem;
      color: var(--landing-muted);
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-2);
    }

    .landing-version-bar__row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      row-gap: var(--space-1);
    }

    .landing-version-meta .landing-commit {
      margin-left: 4px;
      font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
      font-size: 0.625rem;
    }

    .landing-version-company {
      margin: 0;
      max-width: 36rem;
      font-size: 0.6875rem;
      line-height: 1.4;
      color: rgba(250, 250, 250, 0.78);
    }

    .landing-version-tagline {
      margin: 0;
      max-width: 36rem;
      font-size: 0.625rem;
      line-height: 1.35;
      color: var(--landing-muted);
    }
  `],
})
export class LandingSiteFooterComponent implements OnInit {
  private api = inject(ApiService);
  readonly version = environment.version;
  readonly commitHash = environment.commitHash;
  readonly platform = signal<PlatformPublicSettings | null>(null);

  ngOnInit(): void {
    this.api.getPlatformPublicSettings().subscribe({
      next: (settings) => this.platform.set(settings),
      error: () => this.platform.set(null),
    });
  }
}
