import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { LanguagePickerComponent } from '../shared/language-picker.component';
import { LandingSiteFooterComponent } from '../shared/landing-site-footer.component';
import { FEATURE_CATEGORIES } from './feature-landings';
import { ScanakiBrandComponent } from '../shared/scanaki-brand.component';

@Component({
  selector: 'app-features',
  standalone: true,
  imports: [RouterLink, TranslateModule, LanguagePickerComponent, LandingSiteFooterComponent, ScanakiBrandComponent],
  template: `
    <div class="features-page">
      <div class="features-page__bg" aria-hidden="true"></div>

      <nav class="features-nav" aria-label="Main">
        <a routerLink="/" class="features-nav__brand">
          <app-scanaki-brand [size]="28"></app-scanaki-brand>
        </a>
        <div class="features-nav__links">
          <a routerLink="/features" class="features-nav__link features-nav__link--active">{{ 'LANDING.NAV_FEATURES' | translate }}</a>
          <a routerLink="/pricing" class="features-nav__link">{{ 'LANDING.NAV_PRICING' | translate }}</a>
          <a routerLink="/about" class="features-nav__link">{{ 'LANDING.NAV_ABOUT' | translate }}</a>
          <a routerLink="/" fragment="guests" class="features-nav__link">{{ 'LANDING.NAV_GUESTS' | translate }}</a>
          <a routerLink="/" fragment="demo" class="features-nav__link">{{ 'LANDING.NAV_DEMO' | translate }}</a>
        </div>
        <div class="features-nav__actions">
          <app-language-picker></app-language-picker>
          <a routerLink="/login" class="features-nav__login">{{ 'LANDING.LOGIN' | translate }}</a>
          <a routerLink="/register" class="features-nav__cta">{{ 'LANDING.CTA_CREATE_QR_MENU' | translate }}</a>
        </div>
      </nav>

      <header class="features-hero">
        <p class="features-hero__badge">{{ 'FEATURES_PAGE.BADGE' | translate }}</p>
        <h1 class="features-hero__title">{{ 'FEATURES_PAGE.TITLE' | translate }}</h1>
        <p class="features-hero__subtitle">{{ 'FEATURES_PAGE.SUBTITLE' | translate }}</p>
        <a routerLink="/register" class="features-btn features-btn--primary">{{ 'LANDING.CTA_CREATE_QR_MENU' | translate }}</a>
      </header>

      <main class="features-main">
        @for (category of categories; track category.id) {
          <section class="features-category" [attr.aria-labelledby]="'features-cat-' + category.id">
            <h2 [id]="'features-cat-' + category.id" class="features-category__title">{{ category.titleKey | translate }}</h2>
            <ul class="features-grid">
              @for (item of category.items; track item.slug) {
                <li class="features-card">
                  <a [routerLink]="['/features', item.slug]" class="features-card__link">
                    <h3 class="features-card__title">{{ item.titleKey | translate }}</h3>
                    <p class="features-card__text">{{ item.descKey | translate }}</p>
                    <span class="features-card__more">{{ 'FEATURE_DETAIL.LEARN_MORE' | translate }}</span>
                  </a>
                </li>
              }
            </ul>
          </section>
        }
      </main>

      <app-landing-site-footer></app-landing-site-footer>
    </div>
  `,
  styles: [`
    .features-page {
      --fp-bg: #050506;
      --fp-surface: rgba(255, 255, 255, 0.04);
      --fp-border: rgba(255, 255, 255, 0.1);
      --fp-text: #fafafa;
      --fp-muted: rgba(250, 250, 250, 0.62);
      --fp-accent: #ff6b47;

      min-height: 100vh;
      background: var(--fp-bg);
      color: var(--fp-text);
      position: relative;
      overflow-x: clip;
    }

    .features-page__bg {
      position: absolute;
      inset: 0 0 auto;
      height: 480px;
      pointer-events: none;
      background: radial-gradient(ellipse 70% 50% at 50% 0%, rgba(255, 107, 71, 0.2) 0%, transparent 70%);
    }

    .features-nav {
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

    .features-nav__brand {
      display: inline-flex;
      align-items: center;
      gap: var(--space-3);
      color: var(--fp-text);
      font-weight: 700;
      font-size: 1.125rem;
      text-decoration: none;
    }

    .features-nav__links {
      display: none;
      align-items: center;
      gap: var(--space-5);
    }

    .features-nav__link {
      color: var(--fp-muted);
      font-size: 0.9375rem;
      font-weight: 500;
      text-decoration: none;
    }

    .features-nav__link--active,
    .features-nav__link:hover {
      color: var(--fp-text);
    }

    .features-nav__actions {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin-left: auto;
    }

    .features-nav__login {
      display: none;
      color: var(--fp-muted);
      font-size: 0.9375rem;
      font-weight: 500;
      text-decoration: none;
    }

    .features-nav__cta {
      display: inline-flex;
      padding: 0.625rem 1rem;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: var(--fp-text);
      font-size: 0.8125rem;
      font-weight: 600;
      text-decoration: none;
      white-space: nowrap;
    }

    @media (min-width: 768px) {
      .features-nav__links { display: flex; }
      .features-nav__login { display: inline-flex; }
    }

    .features-hero {
      position: relative;
      z-index: 1;
      max-width: 42rem;
      margin: 0 auto;
      padding: var(--space-6) var(--space-5) var(--space-8);
      text-align: center;
    }

    .features-hero__badge {
      display: inline-block;
      margin: 0 0 var(--space-4);
      padding: 0.375rem 0.875rem;
      border-radius: 999px;
      border: 1px solid var(--fp-border);
      font-size: 0.8125rem;
      color: var(--fp-muted);
    }

    .features-hero__title {
      margin: 0 0 var(--space-4);
      font-size: clamp(2rem, 5vw, 3rem);
      font-weight: 700;
      letter-spacing: -0.04em;
      line-height: 1.08;
    }

    .features-hero__subtitle {
      margin: 0 auto var(--space-6);
      max-width: 36rem;
      font-size: 1.0625rem;
      line-height: 1.6;
      color: var(--fp-muted);
    }

    .features-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.875rem 1.375rem;
      border-radius: 999px;
      font-size: 0.9375rem;
      font-weight: 600;
      text-decoration: none;
    }

    .features-btn--primary {
      background: #fff;
      color: #0a0a0b;
    }

    .features-main {
      position: relative;
      z-index: 1;
      max-width: 72rem;
      margin: 0 auto;
      padding: 0 var(--space-5) var(--space-8);
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }

    .features-category__title {
      margin: 0 0 var(--space-5);
      font-size: 1.25rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      color: var(--fp-accent);
      text-transform: uppercase;
      font-size: 0.75rem;
      letter-spacing: 0.08em;
    }

    .features-grid {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: 1fr;
      gap: var(--space-4);
    }

    @media (min-width: 640px) {
      .features-grid { grid-template-columns: repeat(2, 1fr); }
    }

    @media (min-width: 1024px) {
      .features-grid { grid-template-columns: repeat(3, 1fr); }
    }

    .features-card {
      border-radius: 16px;
      background: var(--fp-surface);
      border: 1px solid var(--fp-border);
      transition: border-color 0.15s ease, background 0.15s ease;
    }

    .features-card:hover {
      border-color: rgba(255, 107, 71, 0.35);
      background: rgba(255, 255, 255, 0.06);
    }

    .features-card__link {
      display: block;
      padding: var(--space-5);
      color: inherit;
      text-decoration: none;
    }

    .features-card__more {
      display: inline-block;
      margin-top: var(--space-3);
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--fp-accent);
    }

    .features-card__title {
      margin: 0 0 var(--space-2);
      font-size: 1rem;
      font-weight: 600;
      color: var(--fp-text);
    }

    .features-card__text {
      margin: 0;
      font-size: 0.875rem;
      line-height: 1.55;
      color: var(--fp-muted);
    }
  `],
})
export class FeaturesComponent {
  readonly categories = FEATURE_CATEGORIES;
}
