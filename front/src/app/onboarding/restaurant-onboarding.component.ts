import { Component, inject, OnInit, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ApiService, RestaurantOnboardingState } from '../services/api.service';
import { ScanakiBrandComponent } from '../shared/scanaki-brand.component';

type StarterItem = { name: string; priceCents: number; enabled: boolean };

@Component({
  selector: 'app-restaurant-onboarding',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, TranslateModule, ScanakiBrandComponent],
  template: `
    <main class="onboarding-shell">
      <header class="onboarding-header">
        <a routerLink="/" class="brand" aria-label="Scanaki"><app-scanaki-brand [size]="32"></app-scanaki-brand></a>
        <div class="save-state">
          <span class="save-dot" aria-hidden="true"></span>
          {{ 'RESTAURANT_ONBOARDING.SAVED_AUTOMATICALLY' | translate }}
        </div>
      </header>

      @if (loadingInitial()) {
        <section class="loading-card" aria-live="polite">
          <div class="loading-bar"></div>
          <p>{{ 'RESTAURANT_ONBOARDING.LOADING' | translate }}</p>
        </section>
      } @else if (state()) {
        <div class="onboarding-layout">
          <aside class="progress-panel" [attr.aria-label]="'RESTAURANT_ONBOARDING.PROGRESS' | translate">
            <p class="progress-kicker">{{ 'RESTAURANT_ONBOARDING.SETUP_FOR' | translate }}</p>
            <h1>{{ state()!.restaurant_name }}</h1>
            <p class="progress-summary">{{ 'RESTAURANT_ONBOARDING.PROGRESS_HELP' | translate }}</p>

            <ol class="step-list">
              @for (item of steps; track item.key; let index = $index) {
                <li [class.current]="step() === index" [class.complete]="step() > index || state()!.status === 'completed'">
                  <button type="button" (click)="goToCompletedStep(index)" [disabled]="index > state()!.current_step">
                    <span class="step-number" aria-hidden="true">{{ step() > index ? '✓' : index + 1 }}</span>
                    <span>
                      <strong>{{ item.title | translate }}</strong>
                      <small>{{ item.summary | translate }}</small>
                    </span>
                  </button>
                </li>
              }
            </ol>
          </aside>

          <section class="wizard-card" data-testid="restaurant-onboarding-wizard">
            <div class="mobile-progress">
              <span>{{ 'RESTAURANT_ONBOARDING.STEP_OF' | translate: { current: step() + 1, total: steps.length } }}</span>
              <div class="progress-track"><span [style.width.%]="((step() + 1) / steps.length) * 100"></span></div>
            </div>

            @if (error()) {
              <p class="error-banner" role="alert" data-testid="onboarding-error">{{ error() }}</p>
            }

            @if (step() === 0) {
              <div class="step-content" data-testid="onboarding-step-account">
                <p class="eyebrow">{{ 'RESTAURANT_ONBOARDING.ACCOUNT_EYEBROW' | translate }}</p>
                <h2>{{ 'RESTAURANT_ONBOARDING.ACCOUNT_TITLE' | translate }}</h2>
                <p class="lead">{{ 'RESTAURANT_ONBOARDING.ACCOUNT_HELP' | translate }}</p>

                @if (state()!.must_change_password) {
                  <form [formGroup]="passwordForm" (ngSubmit)="savePassword()">
                    <div class="form-field">
                      <label for="new-password">{{ 'RESTAURANT_ONBOARDING.NEW_PASSWORD' | translate }}</label>
                      <p class="field-help" id="new-password-help">{{ 'RESTAURANT_ONBOARDING.NEW_PASSWORD_HELP' | translate }}</p>
                      <input id="new-password" type="password" formControlName="password" autocomplete="new-password" aria-describedby="new-password-help" data-testid="onboarding-password" />
                    </div>
                    <div class="form-field">
                      <label for="confirm-password">{{ 'RESTAURANT_ONBOARDING.CONFIRM_PASSWORD' | translate }}</label>
                      <input id="confirm-password" type="password" formControlName="confirm" autocomplete="new-password" data-testid="onboarding-password-confirm" />
                      @if (passwordForm.hasError('passwordMismatch') && passwordForm.get('confirm')?.touched) {
                        <p class="field-error">{{ 'RESTAURANT_ONBOARDING.PASSWORD_MISMATCH' | translate }}</p>
                      }
                    </div>
                    <footer class="step-actions single-action">
                      <button class="primary-button" type="submit" [disabled]="busy()" data-testid="onboarding-account-next">
                        {{ 'RESTAURANT_ONBOARDING.SAVE_AND_CONTINUE' | translate }}
                      </button>
                    </footer>
                  </form>
                } @else {
                  <div class="ready-card">
                    <span class="ready-mark" aria-hidden="true">✓</span>
                    <div>
                      <strong>{{ 'RESTAURANT_ONBOARDING.PASSWORD_READY' | translate }}</strong>
                      <p>{{ 'RESTAURANT_ONBOARDING.PASSWORD_READY_HELP' | translate }}</p>
                    </div>
                  </div>
                  <footer class="step-actions single-action">
                    <button class="primary-button" type="button" (click)="advanceSecureAccount()" [disabled]="busy()" data-testid="onboarding-account-next">
                      {{ 'COMMON.NEXT' | translate }}
                    </button>
                  </footer>
                }
              </div>
            }

            @if (step() === 1) {
              <div class="step-content" data-testid="onboarding-step-business">
                <p class="eyebrow">{{ 'RESTAURANT_ONBOARDING.BUSINESS_EYEBROW' | translate }}</p>
                <h2>{{ 'RESTAURANT_ONBOARDING.BUSINESS_TITLE' | translate }}</h2>
                <p class="lead">{{ 'RESTAURANT_ONBOARDING.BUSINESS_HELP' | translate }}</p>

                <form [formGroup]="businessForm" (ngSubmit)="saveBusiness()">
                  <div class="form-grid">
                    <div class="form-field span-two">
                      <label for="business-name">{{ 'RESTAURANT_ONBOARDING.RESTAURANT_NAME' | translate }}</label>
                      <p class="field-help" id="business-name-help">{{ 'RESTAURANT_ONBOARDING.RESTAURANT_NAME_HELP' | translate }}</p>
                      <input id="business-name" formControlName="restaurant_name" aria-describedby="business-name-help" data-testid="onboarding-business-name" />
                    </div>
                    <div class="form-field">
                      <label for="business-type">{{ 'RESTAURANT_ONBOARDING.BUSINESS_TYPE' | translate }}</label>
                      <select id="business-type" formControlName="business_type">
                        <option value="restaurant">{{ 'RESTAURANT_ONBOARDING.TYPE_RESTAURANT' | translate }}</option>
                        <option value="bar">{{ 'RESTAURANT_ONBOARDING.TYPE_PUB' | translate }}</option>
                        <option value="cafe">{{ 'RESTAURANT_ONBOARDING.TYPE_CAFE' | translate }}</option>
                        <option value="other">{{ 'RESTAURANT_ONBOARDING.TYPE_OTHER' | translate }}</option>
                      </select>
                    </div>
                    <div class="form-field">
                      <label for="owner-name">{{ 'RESTAURANT_ONBOARDING.OWNER_NAME' | translate }}</label>
                      <input id="owner-name" formControlName="owner_name" />
                    </div>
                    <div class="form-field">
                      <label for="business-email">{{ 'RESTAURANT_ONBOARDING.BUSINESS_EMAIL' | translate }}</label>
                      <p class="field-help" id="business-email-help">{{ 'RESTAURANT_ONBOARDING.BUSINESS_EMAIL_HELP' | translate }}</p>
                      <input id="business-email" type="email" formControlName="business_email" aria-describedby="business-email-help" />
                    </div>
                    <div class="form-field">
                      <label for="business-phone">{{ 'RESTAURANT_ONBOARDING.PHONE' | translate }}</label>
                      <input id="business-phone" type="tel" formControlName="phone" [placeholder]="'RESTAURANT_ONBOARDING.PHONE_PLACEHOLDER' | translate" />
                    </div>
                    <div class="form-field span-two">
                      <label for="business-address">{{ 'RESTAURANT_ONBOARDING.ADDRESS' | translate }}</label>
                      <p class="field-help" id="business-address-help">{{ 'RESTAURANT_ONBOARDING.ADDRESS_HELP' | translate }}</p>
                      <textarea id="business-address" rows="3" formControlName="address" aria-describedby="business-address-help"></textarea>
                    </div>
                  </div>
                  <footer class="step-actions">
                    <button class="secondary-button" type="button" (click)="back()">{{ 'COMMON.BACK' | translate }}</button>
                    <button class="primary-button" type="submit" [disabled]="busy()" data-testid="onboarding-business-next">{{ 'RESTAURANT_ONBOARDING.SAVE_AND_CONTINUE' | translate }}</button>
                  </footer>
                </form>
              </div>
            }

            @if (step() === 2) {
              <div class="step-content" data-testid="onboarding-step-hours">
                <p class="eyebrow">{{ 'RESTAURANT_ONBOARDING.HOURS_EYEBROW' | translate }}</p>
                <h2>{{ 'RESTAURANT_ONBOARDING.HOURS_TITLE' | translate }}</h2>
                <p class="lead">{{ 'RESTAURANT_ONBOARDING.HOURS_HELP' | translate }}</p>

                <form [formGroup]="hoursForm" (ngSubmit)="saveHours()">
                  <fieldset>
                    <legend>{{ 'RESTAURANT_ONBOARDING.OPEN_DAYS' | translate }}</legend>
                    <p class="field-help">{{ 'RESTAURANT_ONBOARDING.OPEN_DAYS_HELP' | translate }}</p>
                    <div class="day-grid">
                      @for (day of days; track day.value) {
                        <label class="day-choice" [class.selected]="selectedDays().includes(day.value)">
                          <input type="checkbox" [checked]="selectedDays().includes(day.value)" (change)="toggleDay(day.value)" />
                          <span>{{ day.label | translate }}</span>
                        </label>
                      }
                    </div>
                  </fieldset>

                  <div class="time-grid">
                    <div class="form-field">
                      <label for="opening-time">{{ 'RESTAURANT_ONBOARDING.OPENING_TIME' | translate }}</label>
                      <input id="opening-time" type="time" formControlName="opening_time" data-testid="onboarding-opening-time" />
                    </div>
                    <div class="form-field">
                      <label for="closing-time">{{ 'RESTAURANT_ONBOARDING.CLOSING_TIME' | translate }}</label>
                      <input id="closing-time" type="time" formControlName="closing_time" data-testid="onboarding-closing-time" />
                    </div>
                  </div>

                  <aside class="helper-card">
                    <strong>{{ 'RESTAURANT_ONBOARDING.UK_DEFAULTS' | translate }}</strong>
                    <p>{{ 'RESTAURANT_ONBOARDING.UK_DEFAULTS_HELP' | translate }}</p>
                  </aside>

                  <footer class="step-actions">
                    <button class="secondary-button" type="button" (click)="back()">{{ 'COMMON.BACK' | translate }}</button>
                    <button class="primary-button" type="submit" [disabled]="busy() || selectedDays().length === 0" data-testid="onboarding-hours-next">{{ 'RESTAURANT_ONBOARDING.SAVE_AND_CONTINUE' | translate }}</button>
                  </footer>
                </form>
              </div>
            }

            @if (step() === 3) {
              <div class="step-content" data-testid="onboarding-step-tables">
                <p class="eyebrow">{{ 'RESTAURANT_ONBOARDING.TABLES_EYEBROW' | translate }}</p>
                <h2>{{ 'RESTAURANT_ONBOARDING.TABLES_TITLE' | translate }}</h2>
                <p class="lead">{{ 'RESTAURANT_ONBOARDING.TABLES_HELP' | translate }}</p>

                @if (state()!.table_count > 0) {
                  <div class="ready-card">
                    <span class="ready-mark" aria-hidden="true">✓</span>
                    <div>
                      <strong>{{ 'RESTAURANT_ONBOARDING.TABLES_READY' | translate: { count: state()!.table_count } }}</strong>
                      <p>{{ 'RESTAURANT_ONBOARDING.TABLES_READY_HELP' | translate }}</p>
                    </div>
                  </div>
                } @else {
                  <form [formGroup]="tablesForm">
                    <div class="form-grid">
                      <div class="form-field">
                        <label for="floor-name">{{ 'RESTAURANT_ONBOARDING.FLOOR_NAME' | translate }}</label>
                        <p class="field-help">{{ 'RESTAURANT_ONBOARDING.FLOOR_NAME_HELP' | translate }}</p>
                        <input id="floor-name" formControlName="floor_name" />
                      </div>
                      <div class="form-field">
                        <label for="table-prefix">{{ 'RESTAURANT_ONBOARDING.TABLE_PREFIX' | translate }}</label>
                        <p class="field-help">{{ 'RESTAURANT_ONBOARDING.TABLE_PREFIX_HELP' | translate }}</p>
                        <input id="table-prefix" formControlName="table_prefix" />
                      </div>
                      <div class="form-field">
                        <label for="table-count">{{ 'RESTAURANT_ONBOARDING.TABLE_COUNT' | translate }}</label>
                        <input id="table-count" type="number" min="1" max="100" formControlName="table_count" data-testid="onboarding-table-count" />
                      </div>
                      <div class="form-field">
                        <label for="seat-count">{{ 'RESTAURANT_ONBOARDING.SEATS_PER_TABLE' | translate }}</label>
                        <input id="seat-count" type="number" min="1" max="50" formControlName="seats_per_table" />
                      </div>
                    </div>
                    <aside class="helper-card">
                      <strong>{{ 'RESTAURANT_ONBOARDING.QR_NFC_READY' | translate }}</strong>
                      <p>{{ 'RESTAURANT_ONBOARDING.QR_NFC_READY_HELP' | translate }}</p>
                    </aside>
                  </form>
                }

                <footer class="step-actions">
                  <button class="secondary-button" type="button" (click)="back()">{{ 'COMMON.BACK' | translate }}</button>
                  <button class="primary-button" type="button" (click)="saveTables()" [disabled]="busy() || (state()!.table_count === 0 && tablesForm.invalid)" data-testid="onboarding-tables-next">
                    {{ (state()!.table_count > 0 ? 'COMMON.NEXT' : 'RESTAURANT_ONBOARDING.CREATE_TABLES') | translate }}
                  </button>
                </footer>
              </div>
            }

            @if (step() === 4) {
              <div class="step-content" data-testid="onboarding-step-menu">
                <p class="eyebrow">{{ 'RESTAURANT_ONBOARDING.MENU_EYEBROW' | translate }}</p>
                <h2>{{ 'RESTAURANT_ONBOARDING.MENU_TITLE' | translate }}</h2>
                <p class="lead">{{ 'RESTAURANT_ONBOARDING.MENU_HELP' | translate }}</p>

                @if (state()!.product_count > 0) {
                  <div class="ready-card">
                    <span class="ready-mark" aria-hidden="true">✓</span>
                    <div>
                      <strong>{{ 'RESTAURANT_ONBOARDING.MENU_READY' | translate: { count: state()!.product_count } }}</strong>
                      <p>{{ 'RESTAURANT_ONBOARDING.MENU_READY_HELP' | translate }}</p>
                    </div>
                  </div>
                } @else {
                  <div class="starter-list">
                    @for (item of starterItems(); track item.name) {
                      <label class="starter-row">
                        <input type="checkbox" [checked]="item.enabled" (change)="toggleStarter(item.name)" />
                        <span class="starter-name">{{ starterLabel(item.name) | translate }}</span>
                        <span class="price-input">
                          <span aria-hidden="true">£</span>
                          <input type="number" min="0" step="0.01" [value]="item.priceCents / 100" (change)="changeStarterPrice(item.name, $event)" [attr.aria-label]="'RESTAURANT_ONBOARDING.ITEM_PRICE' | translate" />
                        </span>
                      </label>
                    }
                  </div>
                  <p class="skip-help">{{ 'RESTAURANT_ONBOARDING.MENU_SKIP_HELP' | translate }}</p>
                }

                <footer class="step-actions">
                  <button class="secondary-button" type="button" (click)="back()">{{ 'COMMON.BACK' | translate }}</button>
                  <button class="primary-button" type="button" (click)="saveMenu()" [disabled]="busy()" data-testid="onboarding-menu-next">{{ 'RESTAURANT_ONBOARDING.SAVE_AND_CONTINUE' | translate }}</button>
                </footer>
              </div>
            }

            @if (step() === 5) {
              <div class="step-content" data-testid="onboarding-step-review">
                <p class="eyebrow">{{ 'RESTAURANT_ONBOARDING.REVIEW_EYEBROW' | translate }}</p>
                <h2>{{ 'RESTAURANT_ONBOARDING.REVIEW_TITLE' | translate }}</h2>
                <p class="lead">{{ 'RESTAURANT_ONBOARDING.REVIEW_HELP' | translate }}</p>

                <div class="review-list">
                  <div class="review-row ready">
                    <span aria-hidden="true">✓</span>
                    <div><strong>{{ 'RESTAURANT_ONBOARDING.REVIEW_ACCOUNT' | translate }}</strong><p>{{ state()!.owner_email }}</p></div>
                  </div>
                  <div class="review-row ready">
                    <span aria-hidden="true">✓</span>
                    <div><strong>{{ 'RESTAURANT_ONBOARDING.REVIEW_RESTAURANT' | translate }}</strong><p>{{ state()!.restaurant_name }}</p></div>
                  </div>
                  <div class="review-row ready">
                    <span aria-hidden="true">✓</span>
                    <div><strong>{{ 'RESTAURANT_ONBOARDING.REVIEW_TABLES' | translate }}</strong><p>{{ 'RESTAURANT_ONBOARDING.TABLES_READY' | translate: { count: state()!.table_count } }}</p></div>
                  </div>
                  <div class="review-row" [class.ready]="state()!.product_count > 0">
                    <span aria-hidden="true">{{ state()!.product_count > 0 ? '✓' : 'i' }}</span>
                    <div><strong>{{ 'RESTAURANT_ONBOARDING.REVIEW_MENU' | translate }}</strong><p>{{ (state()!.product_count > 0 ? 'RESTAURANT_ONBOARDING.REVIEW_MENU_READY' : 'RESTAURANT_ONBOARDING.REVIEW_MENU_LATER') | translate }}</p></div>
                  </div>
                  <div class="review-row" [class.ready]="state()!.payment_configured">
                    <span aria-hidden="true">{{ state()!.payment_configured ? '✓' : 'i' }}</span>
                    <div><strong>{{ 'RESTAURANT_ONBOARDING.REVIEW_PAYMENTS' | translate }}</strong><p>{{ (state()!.payment_configured ? 'RESTAURANT_ONBOARDING.REVIEW_PAYMENTS_READY' : 'RESTAURANT_ONBOARDING.REVIEW_PAYMENTS_LATER') | translate }}</p></div>
                  </div>
                </div>

                @if (!state()!.payment_configured || state()!.product_count === 0) {
                  <aside class="launch-note">
                    <strong>{{ 'RESTAURANT_ONBOARDING.SAFE_START' | translate }}</strong>
                    <p>{{ 'RESTAURANT_ONBOARDING.SAFE_START_HELP' | translate }}</p>
                  </aside>
                }

                <footer class="step-actions">
                  <button class="secondary-button" type="button" (click)="back()">{{ 'COMMON.BACK' | translate }}</button>
                  <button class="primary-button" type="button" (click)="finish()" [disabled]="busy()" data-testid="onboarding-finish">{{ 'RESTAURANT_ONBOARDING.FINISH' | translate }}</button>
                </footer>
              </div>
            }
          </section>
        </div>
      } @else {
        <section class="loading-card">
          <p class="error-banner" role="alert">{{ error() || ('RESTAURANT_ONBOARDING.LOAD_FAILED' | translate) }}</p>
          <button type="button" class="primary-button" (click)="load()">{{ 'COMMON.RETRY' | translate }}</button>
        </section>
      }
    </main>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: #f5f3ee; }
    .onboarding-shell { min-height: 100vh; color: #20231f; }
    .onboarding-header { height: 72px; padding: 0 clamp(1rem, 4vw, 3rem); display: flex; justify-content: space-between; align-items: center; background: #fff; border-bottom: 1px solid #dedbd2; }
    .brand { color: #173f35; font-size: 1.15rem; font-weight: 800; letter-spacing: -0.02em; text-decoration: none; }
    .save-state { color: #687168; display: flex; gap: 0.5rem; align-items: center; font-size: 0.82rem; }
    .save-dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: #2d7a55; }
    .onboarding-layout { max-width: 1180px; margin: 0 auto; padding: clamp(1.25rem, 4vw, 3.5rem); display: grid; grid-template-columns: 300px minmax(0, 720px); gap: clamp(1.5rem, 4vw, 4rem); align-items: start; }
    .progress-panel { position: sticky; top: 2rem; padding-top: 0.5rem; }
    .progress-kicker, .eyebrow { color: #2d6b57; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; margin: 0 0 0.6rem; }
    .progress-panel h1 { font-size: 1.65rem; letter-spacing: -0.03em; margin: 0 0 0.75rem; overflow-wrap: anywhere; }
    .progress-summary { color: #687168; line-height: 1.55; font-size: 0.9rem; margin: 0 0 1.8rem; }
    .step-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.45rem; }
    .step-list button { width: 100%; display: flex; align-items: center; gap: 0.8rem; padding: 0.65rem; border: 0; border-radius: 10px; background: transparent; color: #687168; text-align: left; cursor: pointer; font: inherit; }
    .step-list button:disabled { cursor: default; }
    .step-list .current button { background: rgba(45, 107, 87, 0.09); color: #173f35; }
    .step-number { width: 1.8rem; height: 1.8rem; display: grid; place-items: center; flex: 0 0 auto; border-radius: 50%; border: 1px solid #c7c8c1; font-size: 0.75rem; font-weight: 700; }
    .step-list .current .step-number { border-color: #2d6b57; background: #2d6b57; color: #fff; }
    .step-list .complete .step-number { border-color: #2d7a55; color: #2d7a55; }
    .step-list strong, .step-list small { display: block; }
    .step-list strong { font-size: 0.86rem; }
    .step-list small { font-size: 0.72rem; margin-top: 0.12rem; }
    .wizard-card, .loading-card { background: #fff; border: 1px solid #dedbd2; border-radius: 16px; box-shadow: 0 18px 45px rgba(35, 45, 38, 0.08); }
    .wizard-card { min-height: 560px; }
    .step-content { padding: clamp(1.5rem, 5vw, 3.25rem); }
    .step-content h2 { font-size: clamp(1.75rem, 4vw, 2.35rem); letter-spacing: -0.035em; line-height: 1.1; margin: 0 0 0.8rem; }
    .lead { color: #687168; line-height: 1.65; margin: 0 0 2rem; max-width: 62ch; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 1.1rem; }
    .span-two { grid-column: 1 / -1; }
    .form-field { margin-bottom: 1.25rem; }
    label, legend { display: block; font-weight: 700; font-size: 0.9rem; margin-bottom: 0.35rem; }
    .field-help { color: #747b74; font-size: 0.8rem; line-height: 1.45; margin: 0 0 0.45rem; }
    input, select, textarea { width: 100%; box-sizing: border-box; border: 1px solid #c9cbc5; border-radius: 9px; padding: 0.78rem 0.85rem; color: #20231f; background: #fff; font: inherit; }
    input:focus, select:focus, textarea:focus, button:focus-visible { outline: 2px solid #2d6b57; outline-offset: 2px; }
    fieldset { margin: 0 0 1.6rem; padding: 0; border: 0; }
    .day-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 0.45rem; }
    .day-choice { margin: 0; cursor: pointer; }
    .day-choice input { position: absolute; opacity: 0; pointer-events: none; }
    .day-choice span { display: grid; place-items: center; min-height: 42px; border: 1px solid #c9cbc5; border-radius: 9px; color: #606760; font-size: 0.8rem; }
    .day-choice.selected span { background: #e6f0eb; border-color: #2d6b57; color: #173f35; }
    .time-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.1rem; }
    .helper-card, .launch-note { padding: 1rem 1.1rem; border-radius: 10px; background: #f2f5f1; border-left: 3px solid #668b78; }
    .helper-card p, .launch-note p, .ready-card p, .review-row p { color: #687168; line-height: 1.5; margin: 0.25rem 0 0; font-size: 0.84rem; }
    .ready-card { display: flex; gap: 0.9rem; align-items: flex-start; padding: 1.1rem; background: #f1f7f3; border: 1px solid #cfe1d6; border-radius: 10px; }
    .ready-mark { width: 1.6rem; height: 1.6rem; display: grid; place-items: center; border-radius: 50%; color: #fff; background: #2d7a55; flex: 0 0 auto; }
    .starter-list { border: 1px solid #dedbd2; border-radius: 10px; overflow: hidden; }
    .starter-row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 0.8rem; margin: 0; padding: 0.9rem 1rem; border-bottom: 1px solid #e5e3dc; }
    .starter-row:last-child { border-bottom: 0; }
    .starter-row > input { width: 1.1rem; height: 1.1rem; }
    .starter-name { font-weight: 700; }
    .price-input { display: flex; align-items: center; gap: 0.35rem; }
    .price-input input { width: 6rem; padding: 0.55rem; }
    .skip-help { color: #747b74; font-size: 0.8rem; line-height: 1.5; }
    .review-list { border: 1px solid #dedbd2; border-radius: 10px; overflow: hidden; }
    .review-row { display: grid; grid-template-columns: 1.7rem 1fr; gap: 0.8rem; padding: 1rem; border-bottom: 1px solid #e5e3dc; }
    .review-row:last-child { border-bottom: 0; }
    .review-row > span { width: 1.55rem; height: 1.55rem; display: grid; place-items: center; border-radius: 50%; color: #7a5a15; background: #fff0c9; font-weight: 800; }
    .review-row.ready > span { color: #fff; background: #2d7a55; }
    .launch-note { margin-top: 1.1rem; background: #fff9eb; border-left-color: #c48b27; }
    .step-actions { display: flex; justify-content: space-between; gap: 1rem; margin-top: 2.2rem; padding-top: 1.4rem; border-top: 1px solid #e5e3dc; }
    .single-action { justify-content: flex-end; }
    .primary-button, .secondary-button { min-height: 46px; display: inline-flex; align-items: center; justify-content: center; border-radius: 9px; padding: 0 1.25rem; font: inherit; font-weight: 700; cursor: pointer; }
    .primary-button { border: 1px solid #245a49; background: #245a49; color: #fff; }
    .secondary-button { border: 1px solid #c9cbc5; background: #fff; color: #303530; }
    .primary-button:disabled { opacity: 0.55; cursor: wait; }
    .error-banner { margin: 1.25rem 1.25rem 0; padding: 0.85rem 1rem; border-radius: 9px; color: #9b2c2c; background: #fff1f1; }
    .field-error { color: #9b2c2c; font-size: 0.8rem; margin: 0.4rem 0 0; }
    .mobile-progress { display: none; }
    .loading-card { max-width: 700px; margin: 8vh auto; padding: 2rem; text-align: center; }
    .loading-bar { height: 4px; overflow: hidden; border-radius: 3px; background: linear-gradient(90deg, #dfe6e1 20%, #2d6b57 50%, #dfe6e1 80%); background-size: 200% 100%; animation: loading 1.3s linear infinite; }
    @keyframes loading { to { background-position: -200% 0; } }
    @media (max-width: 840px) {
      .onboarding-layout { display: block; padding: 1rem; }
      .progress-panel { display: none; }
      .mobile-progress { display: block; padding: 1rem 1.5rem 0; color: #687168; font-size: 0.78rem; }
      .progress-track { height: 4px; margin-top: 0.5rem; border-radius: 4px; background: #e4e3dd; overflow: hidden; }
      .progress-track span { display: block; height: 100%; background: #2d6b57; transition: width 0.2s ease; }
    }
    @media (max-width: 580px) {
      .onboarding-header { height: 60px; }
      .save-state { font-size: 0; }
      .save-state .save-dot { width: 0.6rem; height: 0.6rem; }
      .form-grid, .time-grid { grid-template-columns: 1fr; }
      .span-two { grid-column: auto; }
      .day-grid { grid-template-columns: repeat(4, 1fr); }
      .step-actions { flex-direction: column-reverse; }
      .step-actions button { width: 100%; }
      .starter-row { grid-template-columns: auto 1fr; }
      .price-input { grid-column: 2; }
    }
  `],
})
export class RestaurantOnboardingComponent implements OnInit {
  private fb = inject(FormBuilder);
  private api = inject(ApiService);
  private router = inject(Router);
  private translate = inject(TranslateService);

  readonly steps = [
    { key: 'account', title: 'RESTAURANT_ONBOARDING.STEP_ACCOUNT', summary: 'RESTAURANT_ONBOARDING.STEP_ACCOUNT_SUMMARY' },
    { key: 'business', title: 'RESTAURANT_ONBOARDING.STEP_BUSINESS', summary: 'RESTAURANT_ONBOARDING.STEP_BUSINESS_SUMMARY' },
    { key: 'hours', title: 'RESTAURANT_ONBOARDING.STEP_HOURS', summary: 'RESTAURANT_ONBOARDING.STEP_HOURS_SUMMARY' },
    { key: 'tables', title: 'RESTAURANT_ONBOARDING.STEP_TABLES', summary: 'RESTAURANT_ONBOARDING.STEP_TABLES_SUMMARY' },
    { key: 'menu', title: 'RESTAURANT_ONBOARDING.STEP_MENU', summary: 'RESTAURANT_ONBOARDING.STEP_MENU_SUMMARY' },
    { key: 'review', title: 'RESTAURANT_ONBOARDING.STEP_REVIEW', summary: 'RESTAURANT_ONBOARDING.STEP_REVIEW_SUMMARY' },
  ];
  readonly days = [
    { value: 'monday', label: 'RESTAURANT_ONBOARDING.DAY_MON' },
    { value: 'tuesday', label: 'RESTAURANT_ONBOARDING.DAY_TUE' },
    { value: 'wednesday', label: 'RESTAURANT_ONBOARDING.DAY_WED' },
    { value: 'thursday', label: 'RESTAURANT_ONBOARDING.DAY_THU' },
    { value: 'friday', label: 'RESTAURANT_ONBOARDING.DAY_FRI' },
    { value: 'saturday', label: 'RESTAURANT_ONBOARDING.DAY_SAT' },
    { value: 'sunday', label: 'RESTAURANT_ONBOARDING.DAY_SUN' },
  ];

  state = signal<RestaurantOnboardingState | null>(null);
  step = signal(0);
  loadingInitial = signal(true);
  busy = signal(false);
  error = signal('');
  selectedDays = signal(this.days.map((day) => day.value));
  starterItems = signal<StarterItem[]>([
    { name: 'Coffee', priceCents: 250, enabled: true },
    { name: 'Coca Cola', priceCents: 300, enabled: true },
    { name: 'Water', priceCents: 150, enabled: true },
  ]);

  passwordForm = this.fb.nonNullable.group(
    {
      password: ['', [Validators.required, Validators.minLength(8)]],
      confirm: ['', Validators.required],
    },
    {
      validators: (group) =>
        group.get('password')?.value === group.get('confirm')?.value
          ? null
          : { passwordMismatch: true },
    },
  );
  businessForm = this.fb.nonNullable.group({
    restaurant_name: ['', [Validators.required, Validators.minLength(2)]],
    business_type: ['restaurant', Validators.required],
    owner_name: [''],
    business_email: ['', Validators.email],
    phone: [''],
    address: [''],
  });
  hoursForm = this.fb.nonNullable.group({
    opening_time: ['11:00', Validators.required],
    closing_time: ['23:00', Validators.required],
  });
  tablesForm = this.fb.nonNullable.group({
    floor_name: ['Main', Validators.required],
    table_prefix: ['Table ', Validators.required],
    table_count: [10, [Validators.required, Validators.min(1), Validators.max(100)]],
    seats_per_table: [4, [Validators.required, Validators.min(1), Validators.max(50)]],
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loadingInitial.set(true);
    this.error.set('');
    this.api.getRestaurantOnboarding().subscribe({
      next: (state) => {
        if (state.status === 'completed') {
          void this.router.navigate(['/dashboard']);
          return;
        }
        this.applyState(state);
        this.step.set(Math.max(0, Math.min(state.current_step, this.steps.length - 1)));
        this.loadingInitial.set(false);
      },
      error: () => {
        this.error.set(this.translate.instant('RESTAURANT_ONBOARDING.LOAD_FAILED'));
        this.loadingInitial.set(false);
      },
    });
  }

  private applyState(state: RestaurantOnboardingState): void {
    this.state.set(state);
    this.businessForm.patchValue({
      restaurant_name: state.restaurant_name,
      business_type: state.business_type || 'restaurant',
      owner_name: state.owner_name || '',
      business_email: state.business_email || state.owner_email,
      phone: state.phone || '',
      address: state.address || '',
    });
    const hours = state.ordering_service_hours;
    if (hours) {
      const openDays = this.days.filter((day) => !hours[day.value]?.closed).map((day) => day.value);
      if (openDays.length) this.selectedDays.set(openDays);
      const first = openDays.map((day) => hours[day]).find((value) => value?.open && value?.close);
      if (first) {
        this.hoursForm.patchValue({ opening_time: first.open!, closing_time: first.close! });
      }
    }
  }

  private handleError(error: unknown): void {
    const response = error as { error?: { detail?: string | { message?: string } } };
    const detail = response?.error?.detail;
    this.error.set(
      typeof detail === 'string'
        ? detail
        : detail?.message || this.translate.instant('RESTAURANT_ONBOARDING.SAVE_FAILED'),
    );
    this.busy.set(false);
  }

  private nextWithState(state: RestaurantOnboardingState, nextStep: number): void {
    this.applyState(state);
    this.step.set(nextStep);
    this.error.set('');
    this.busy.set(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  savePassword(): void {
    if (this.passwordForm.invalid) {
      this.passwordForm.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.api.setRestaurantOnboardingPassword(this.passwordForm.getRawValue().password).subscribe({
      next: (state) => this.nextWithState(state, 1),
      error: (error) => this.handleError(error),
    });
  }

  advanceSecureAccount(): void {
    this.busy.set(true);
    this.api.saveRestaurantOnboardingProgress(1).subscribe({
      next: (state) => this.nextWithState(state, 1),
      error: (error) => this.handleError(error),
    });
  }

  saveBusiness(): void {
    if (this.businessForm.invalid) {
      this.businessForm.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.api.saveRestaurantOnboardingBusiness(this.businessForm.getRawValue()).subscribe({
      next: (state) => this.nextWithState(state, 2),
      error: (error) => this.handleError(error),
    });
  }

  toggleDay(day: string): void {
    this.selectedDays.update((days) =>
      days.includes(day) ? days.filter((value) => value !== day) : [...days, day],
    );
  }

  saveHours(): void {
    if (this.hoursForm.invalid || this.selectedDays().length === 0) return;
    this.busy.set(true);
    this.api
      .saveRestaurantOnboardingOperations({
        days_open: this.selectedDays(),
        ...this.hoursForm.getRawValue(),
      })
      .subscribe({
        next: (state) => this.nextWithState(state, 3),
        error: (error) => this.handleError(error),
      });
  }

  saveTables(): void {
    if (this.state()!.table_count > 0) {
      this.busy.set(true);
      this.api.saveRestaurantOnboardingProgress(4).subscribe({
        next: (state) => this.nextWithState(state, 4),
        error: (error) => this.handleError(error),
      });
      return;
    }
    if (this.tablesForm.invalid) {
      this.tablesForm.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.api.createRestaurantOnboardingTables(this.tablesForm.getRawValue()).subscribe({
      next: (state) => this.nextWithState(state, 4),
      error: (error) => this.handleError(error),
    });
  }

  starterLabel(name: string): string {
    const labels: Record<string, string> = {
      Coffee: 'RESTAURANT_ONBOARDING.STARTER_COFFEE',
      'Coca Cola': 'RESTAURANT_ONBOARDING.STARTER_SOFT_DRINK',
      Water: 'RESTAURANT_ONBOARDING.STARTER_WATER',
    };
    return labels[name] || name;
  }

  toggleStarter(name: string): void {
    this.starterItems.update((items) =>
      items.map((item) => (item.name === name ? { ...item, enabled: !item.enabled } : item)),
    );
  }

  changeStarterPrice(name: string, event: Event): void {
    const amount = Number.parseFloat((event.target as HTMLInputElement).value);
    this.starterItems.update((items) =>
      items.map((item) =>
        item.name === name
          ? { ...item, priceCents: Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100)) : 0 }
          : item,
      ),
    );
  }

  saveMenu(): void {
    this.busy.set(true);
    const finishStep = () => {
      this.api.saveRestaurantOnboardingProgress(5).subscribe({
        next: (state) => this.nextWithState(state, 5),
        error: (error) => this.handleError(error),
      });
    };
    if (this.state()!.product_count > 0 || !this.starterItems().some((item) => item.enabled)) {
      finishStep();
      return;
    }
    this.api
      .seedOnboardingStarterProducts(
        this.starterItems().map((item) => ({
          name: item.name,
          price_cents: item.priceCents,
          enabled: item.enabled,
        })),
      )
      .subscribe({ next: finishStep, error: (error) => this.handleError(error) });
  }

  finish(): void {
    this.busy.set(true);
    this.api.completeRestaurantOnboarding().subscribe({
      next: () => {
        this.busy.set(false);
        void this.router.navigate(['/dashboard']);
      },
      error: (error) => this.handleError(error),
    });
  }

  back(): void {
    this.error.set('');
    this.step.update((step) => Math.max(0, step - 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  goToCompletedStep(index: number): void {
    if (index <= this.state()!.current_step) {
      this.error.set('');
      this.step.set(index);
    }
  }
}
