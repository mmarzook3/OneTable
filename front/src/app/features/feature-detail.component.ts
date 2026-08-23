import { Component, inject } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { map } from 'rxjs/operators';
import { LanguagePickerComponent } from '../shared/language-picker.component';
import { LandingSiteFooterComponent } from '../shared/landing-site-footer.component';
import { SeoService } from '../services/seo.service';
import { featureDetailKey, getFeatureLanding, type FeatureLanding } from './feature-landings';

@Component({
  selector: 'app-feature-detail',
  standalone: true,
  imports: [RouterLink, TranslateModule, LanguagePickerComponent, LandingSiteFooterComponent],
  template: `
    <div class="feature-detail-page">
      <div class="feature-detail-page__bg" aria-hidden="true"></div>

      <nav class="feature-detail-nav" aria-label="Main">
        <a routerLink="/" class="feature-detail-nav__brand">
          <span class="feature-detail-nav__mark" aria-hidden="true"></span>
          <span>{{ 'LANDING.BRAND_NAME' | translate }}</span>
        </a>
        <div class="feature-detail-nav__links">
          <a routerLink="/features" class="feature-detail-nav__link feature-detail-nav__link--active">{{
            'LANDING.NAV_FEATURES' | translate
          }}</a>
          <a routerLink="/pricing" class="feature-detail-nav__link">{{ 'LANDING.NAV_PRICING' | translate }}</a>
          <a routerLink="/about" class="feature-detail-nav__link">{{ 'LANDING.NAV_ABOUT' | translate }}</a>
          <a routerLink="/" fragment="guests" class="feature-detail-nav__link">{{ 'LANDING.NAV_GUESTS' | translate }}</a>
          <a routerLink="/" fragment="demo" class="feature-detail-nav__link">{{ 'LANDING.NAV_DEMO' | translate }}</a>
        </div>
        <div class="feature-detail-nav__actions">
          <app-language-picker></app-language-picker>
          <a routerLink="/login" class="feature-detail-nav__login">{{ 'LANDING.LOGIN' | translate }}</a>
          <a routerLink="/register" class="feature-detail-nav__cta">{{ 'LANDING.CTA_CREATE_QR_MENU' | translate }}</a>
        </div>
      </nav>

      @if (feature) {
        <header class="feature-detail-hero">
          <p class="feature-detail-hero__back">
            <a routerLink="/features" class="feature-detail-hero__back-link">{{
              'FEATURE_DETAIL.BACK_TO_ALL' | translate
            }}</a>
          </p>
          <h1 class="feature-detail-hero__title" data-testid="feature-detail-title">
            {{ heroTitleKey | translate }}
          </h1>
          <p class="feature-detail-hero__subtitle">{{ heroSubtitleKey | translate }}</p>
          <a routerLink="/register" class="feature-detail-btn feature-detail-btn--primary">{{
            'LANDING.CTA_CREATE_QR_MENU' | translate
          }}</a>
        </header>

        <main class="feature-detail-main">
          <section class="feature-detail-section" aria-labelledby="feature-benefits-heading">
            <h2 id="feature-benefits-heading" class="feature-detail-section__title">
              {{ 'FEATURE_DETAIL.BENEFITS_TITLE' | translate }}
            </h2>
            <ul class="feature-detail-list">
              @for (key of benefitKeys; track key) {
                <li class="feature-detail-list__item">{{ key | translate }}</li>
              }
            </ul>
          </section>

          @if (howKeys.length) {
            <section class="feature-detail-section" aria-labelledby="feature-how-heading">
              <h2 id="feature-how-heading" class="feature-detail-section__title">
                {{ 'FEATURE_DETAIL.HOW_TITLE' | translate }}
              </h2>
              <ol class="feature-detail-steps">
                @for (key of howKeys; track key) {
                  <li class="feature-detail-steps__item">{{ key | translate }}</li>
                }
              </ol>
            </section>
          }

          <section class="feature-detail-cta" aria-labelledby="feature-cta-heading">
            <h2 id="feature-cta-heading" class="feature-detail-cta__title">
              {{ 'FEATURE_DETAIL.CTA_TITLE' | translate }}
            </h2>
            <p class="feature-detail-cta__body">{{ 'FEATURE_DETAIL.CTA_BODY' | translate }}</p>
            <div class="feature-detail-cta__actions">
              <a routerLink="/register" class="feature-detail-btn feature-detail-btn--primary">{{
                'LANDING.CTA_CREATE_QR_MENU' | translate
              }}</a>
              <a routerLink="/" fragment="demo" class="feature-detail-btn feature-detail-btn--ghost">{{
                'LANDING.NAV_DEMO' | translate
              }}</a>
            </div>
          </section>
        </main>
      } @else {
        <main class="feature-detail-main feature-detail-main--center">
          <h1 class="feature-detail-hero__title">{{ 'FEATURE_DETAIL.NOT_FOUND_TITLE' | translate }}</h1>
          <p class="feature-detail-hero__subtitle">{{ 'FEATURE_DETAIL.NOT_FOUND_BODY' | translate }}</p>
          <a routerLink="/features" class="feature-detail-btn feature-detail-btn--primary">{{
            'FEATURE_DETAIL.BACK_TO_ALL' | translate
          }}</a>
        </main>
      }

      <app-landing-site-footer></app-landing-site-footer>
    </div>
  `,
  styles: [
    `
      .feature-detail-page {
        --fd-bg: #050506;
        --fd-surface: rgba(255, 255, 255, 0.04);
        --fd-border: rgba(255, 255, 255, 0.1);
        --fd-text: #fafafa;
        --fd-muted: rgba(250, 250, 250, 0.62);
        --fd-accent: #ff6b47;

        min-height: 100vh;
        background: var(--fd-bg);
        color: var(--fd-text);
        position: relative;
        overflow-x: clip;
      }

      .feature-detail-page__bg {
        position: absolute;
        inset: 0 0 auto;
        height: 480px;
        pointer-events: none;
        background: radial-gradient(ellipse 70% 50% at 50% 0%, rgba(255, 107, 71, 0.2) 0%, transparent 70%);
      }

      .feature-detail-nav {
        position: relative;
        z-index: 2;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-4);
        flex-wrap: wrap;
        max-width: 72rem;
        margin: 0 auto;
        padding: var(--space-4) var(--space-5);
      }

      .feature-detail-nav__brand {
        display: inline-flex;
        align-items: center;
        gap: var(--space-3);
        color: var(--fd-text);
        font-weight: 700;
        font-size: 1.125rem;
        text-decoration: none;
      }

      .feature-detail-nav__mark {
        width: 28px;
        height: 28px;
        border-radius: 8px;
        background: linear-gradient(135deg, #ff8a65 0%, #d35233 55%, #9333ea 100%);
      }

      .feature-detail-nav__links {
        display: none;
        align-items: center;
        gap: var(--space-5);
      }

      .feature-detail-nav__link {
        color: var(--fd-muted);
        font-size: 0.9375rem;
        font-weight: 500;
        text-decoration: none;
      }

      .feature-detail-nav__link--active,
      .feature-detail-nav__link:hover {
        color: var(--fd-text);
      }

      .feature-detail-nav__actions {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin-left: auto;
      }

      .feature-detail-nav__login {
        display: none;
        color: var(--fd-muted);
        font-size: 0.9375rem;
        font-weight: 500;
        text-decoration: none;
      }

      .feature-detail-nav__cta {
        display: inline-flex;
        padding: 0.625rem 1rem;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.14);
        color: var(--fd-text);
        font-size: 0.8125rem;
        font-weight: 600;
        text-decoration: none;
        white-space: nowrap;
      }

      @media (min-width: 768px) {
        .feature-detail-nav__links {
          display: flex;
        }
        .feature-detail-nav__login {
          display: inline-flex;
        }
      }

      .feature-detail-hero {
        position: relative;
        z-index: 1;
        max-width: 42rem;
        margin: 0 auto;
        padding: var(--space-5) var(--space-5) var(--space-6);
        text-align: center;
      }

      .feature-detail-hero__back {
        margin: 0 0 var(--space-4);
      }

      .feature-detail-hero__back-link {
        color: var(--fd-muted);
        font-size: 0.875rem;
        text-decoration: none;
      }

      .feature-detail-hero__back-link:hover {
        color: var(--fd-text);
      }

      .feature-detail-hero__title {
        margin: 0 0 var(--space-4);
        font-size: clamp(2rem, 5vw, 2.75rem);
        font-weight: 700;
        letter-spacing: -0.04em;
        line-height: 1.08;
      }

      .feature-detail-hero__subtitle {
        margin: 0 auto var(--space-6);
        max-width: 36rem;
        font-size: 1.0625rem;
        line-height: 1.6;
        color: var(--fd-muted);
      }

      .feature-detail-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.875rem 1.375rem;
        border-radius: 999px;
        font-size: 0.9375rem;
        font-weight: 600;
        text-decoration: none;
      }

      .feature-detail-btn--primary {
        background: #fff;
        color: #0a0a0b;
      }

      .feature-detail-btn--ghost {
        background: transparent;
        border: 1px solid var(--fd-border);
        color: var(--fd-text);
      }

      .feature-detail-main {
        position: relative;
        z-index: 1;
        max-width: 42rem;
        margin: 0 auto;
        padding: 0 var(--space-5) var(--space-8);
        display: flex;
        flex-direction: column;
        gap: var(--space-7);
      }

      .feature-detail-main--center {
        text-align: center;
        padding-top: var(--space-8);
      }

      .feature-detail-section__title {
        margin: 0 0 var(--space-4);
        font-size: 0.75rem;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--fd-accent);
      }

      .feature-detail-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      .feature-detail-list__item {
        padding: var(--space-4);
        border-radius: 12px;
        background: var(--fd-surface);
        border: 1px solid var(--fd-border);
        font-size: 0.9375rem;
        line-height: 1.55;
        color: var(--fd-muted);
      }

      .feature-detail-list__item::before {
        content: '✓';
        display: inline-block;
        margin-right: var(--space-3);
        color: var(--fd-accent);
        font-weight: 700;
      }

      .feature-detail-steps {
        margin: 0;
        padding-left: 1.25rem;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      .feature-detail-steps__item {
        font-size: 0.9375rem;
        line-height: 1.55;
        color: var(--fd-muted);
      }

      .feature-detail-cta {
        padding: var(--space-6);
        border-radius: 16px;
        background: var(--fd-surface);
        border: 1px solid var(--fd-border);
        text-align: center;
      }

      .feature-detail-cta__title {
        margin: 0 0 var(--space-3);
        font-size: 1.25rem;
        font-weight: 600;
      }

      .feature-detail-cta__body {
        margin: 0 0 var(--space-5);
        color: var(--fd-muted);
        line-height: 1.6;
      }

      .feature-detail-cta__actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3);
        justify-content: center;
      }
    `,
  ],
})
export class FeatureDetailComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);

  readonly feature$ = this.route.paramMap.pipe(map((p) => getFeatureLanding(p.get('slug') ?? '')));

  feature: FeatureLanding | undefined;
  heroTitleKey = '';
  heroSubtitleKey = '';
  benefitKeys: string[] = [];
  howKeys: string[] = [];

  constructor() {
    if (this.route.snapshot.paramMap.get('slug') === 'satisfecho-delivery') {
      void this.router.navigate(['/features', 'scanaki-delivery'], { replaceUrl: true });
    }
    this.feature$.subscribe((feature) => {
      this.feature = feature;
      if (!feature) {
        this.seo.applyFeatureDetail('/features', 'Features - Scanaki', 'Feature not found.');
        return;
      }
      const slug = feature.slug;
      this.heroTitleKey = featureDetailKey(slug, 'HERO_TITLE');
      this.heroSubtitleKey = featureDetailKey(slug, 'HERO_SUBTITLE');
      this.benefitKeys = ['BENEFIT_1', 'BENEFIT_2', 'BENEFIT_3'].map((s) => featureDetailKey(slug, s));
      this.howKeys = ['HOW_1', 'HOW_2', 'HOW_3'].map((s) => featureDetailKey(slug, s));

      this.seo.applyFeatureDetail(`/features/${slug}`, feature.seoTitle, feature.seoDescription);
    });
  }
}
