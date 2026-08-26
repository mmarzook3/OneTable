import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  ApiService,
  PlatformPricingConsole,
  PlatformPricingPlan,
  PlatformPricingPublish,
} from '../services/api.service';

interface PricingForm {
  planCode: string;
  version: number;
  name: string;
  description: string;
  regularPrice: number;
  offerPrice: number | null;
  discountPercent: number | null;
  extraTablePrice: number;
  includedTables: number;
  trialDays: number;
  offerBadge: string;
  offerStartsAt: string;
  offerEndsAt: string;
  isFeatured: boolean;
  isPublic: boolean;
  stripeProductId: string;
  stripeRegularPriceId: string;
  stripeOfferPriceId: string;
  stripeExtraTablePriceId: string;
  createStripePrices: boolean;
  migrationMode: 'new_customers_only' | 'next_renewal' | 'immediate';
}

@Component({
  selector: 'app-platform-pricing',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <main class="pricing-console">
      <header class="page-header">
        <div>
          <h1>Pricing & offers</h1>
          <p>Control the public tiers, scheduled deals, Stripe prices and existing-customer migration.</p>
        </div>
        <div class="header-actions">
          <a routerLink="/pricing" target="_blank" class="secondary">Preview landing page</a>
          <button type="button" class="secondary" (click)="load()" [disabled]="loading()">Refresh</button>
        </div>
      </header>

      <section class="safety-note">
        <strong>Safe publishing</strong>
        <span>Every save creates a new revision. Existing customers keep their contracted price unless you explicitly migrate them.</span>
      </section>

      @if (message()) { <p class="success" role="status">{{ message() }}</p> }
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      @if (loading()) {
        <p class="loading">Loading pricing catalogue…</p>
      } @else {
        <section class="tier-grid" aria-label="Scanaki pricing tiers">
          @for (form of forms(); track form.planCode) {
            <article class="tier-card" [class.featured]="form.isFeatured" [attr.data-plan]="form.planCode">
              <header class="tier-header">
                <div>
                  <span class="eyebrow">{{ form.planCode }} · revision {{ form.version }}</span>
                  <h2>{{ form.name || form.planCode }}</h2>
                </div>
                <span class="visibility" [class.off]="!form.isPublic">{{ form.isPublic ? 'Public' : 'Hidden' }}</span>
              </header>

              <div class="price-preview">
                @if (form.offerPrice !== null) {
                  <span class="deal-badge">{{ form.offerBadge || 'Offer' }}</span>
                  <s>{{ money(form.regularPrice) }}</s>
                  <strong>{{ money(form.offerPrice) }}</strong>
                } @else {
                  <strong>{{ money(form.regularPrice) }}</strong>
                }
                <small>/ month · {{ form.planCode === 'pilot' ? 'Unlimited ordering points' : form.includedTables + ' ordering points' }}</small>
              </div>

              <div class="fields two-cols">
                <label>Tier name<input [(ngModel)]="form.name" maxlength="80"></label>
                <label>Included ordering points<input type="number" min="0" max="10000" [(ngModel)]="form.includedTables" [disabled]="form.planCode === 'pilot'"></label>
              </div>
              <label>Description<textarea rows="2" maxlength="500" [(ngModel)]="form.description"></textarea></label>

              <fieldset>
                <legend>Price</legend>
                <div class="fields two-cols">
                  <label>Regular monthly price (£)<input type="number" min="0" step="0.01" [(ngModel)]="form.regularPrice"></label>
                  <label>Offer price (£)<input type="number" min="0" step="0.01" [(ngModel)]="form.offerPrice" (ngModelChange)="syncDiscountFromOffer(form)" placeholder="No offer"></label>
                  <label>Discount (%)<input type="number" min="0" max="99" step="0.1" [(ngModel)]="form.discountPercent" (ngModelChange)="applyDiscountPercent(form)" placeholder="Calculated from offer"></label>
                  <label>Extra table (£ / month)<input type="number" min="0" step="0.01" [(ngModel)]="form.extraTablePrice"></label>
                  <label>Free trial days<input type="number" min="0" max="365" [(ngModel)]="form.trialDays"></label>
                </div>
              </fieldset>

              <fieldset>
                <legend>Offer presentation</legend>
                <label>Deal badge<input [(ngModel)]="form.offerBadge" maxlength="80" placeholder="Launch deal"></label>
                <div class="fields two-cols">
                  <label>Starts <input type="datetime-local" [(ngModel)]="form.offerStartsAt"></label>
                  <label>Ends <input type="datetime-local" [(ngModel)]="form.offerEndsAt"></label>
                </div>
                <p class="hint">Leave dates empty for an offer that remains active until you publish another revision.</p>
              </fieldset>

              <div class="toggles">
                <label><input type="checkbox" [(ngModel)]="form.isPublic" [disabled]="form.planCode === 'pilot'"> Show on landing page</label>
                <label><input type="checkbox" [(ngModel)]="form.isFeatured"> Mark as most popular</label>
              </div>

              @if (form.planCode === 'pilot') {
                <p class="hint">Internal Pilot is permanently hidden from the website and does not use public Stripe prices.</p>
              } @else { <details>
                <summary>Stripe configuration</summary>
                <p class="hint">Price amounts cannot be edited in Stripe. Scanaki creates replacement Price records when requested.</p>
                <label>Product ID<input [(ngModel)]="form.stripeProductId" placeholder="prod_…"></label>
                <label>Regular Price ID<input [(ngModel)]="form.stripeRegularPriceId" placeholder="price_…"></label>
                <label>Offer Price ID<input [(ngModel)]="form.stripeOfferPriceId" placeholder="price_…"></label>
                <label>Extra-table Price ID<input [(ngModel)]="form.stripeExtraTablePriceId" placeholder="price_…"></label>
                <label class="check-row">
                  <input type="checkbox" [(ngModel)]="form.createStripePrices" [disabled]="!stripeConfigured()">
                  Create replacement Stripe prices automatically
                </label>
                @if (!stripeConfigured()) { <p class="warning">Platform Stripe is not configured. Public prices can still be published, but Checkout remains unavailable for missing Price IDs.</p> }
              </details> }

              <fieldset class="migration">
                <legend>Existing customers</legend>
                <label><input type="radio" [(ngModel)]="form.migrationMode" value="new_customers_only"> Keep their current price <small>Recommended</small></label>
                <label><input type="radio" [(ngModel)]="form.migrationMode" value="next_renewal"> Change at next renewal <small>No mid-cycle charge</small></label>
                <label><input type="radio" [(ngModel)]="form.migrationMode" value="immediate"> Change immediately <small>Stripe proration and invoice</small></label>
              </fieldset>

              <button type="button" class="publish" (click)="publish(form)" [disabled]="savingPlan() === form.planCode">
                {{ savingPlan() === form.planCode ? 'Publishing…' : 'Publish new revision' }}
              </button>
            </article>
          }
        </section>

        <section class="history-card">
          <h2>Pricing publication history</h2>
          @if (events().length === 0) { <p class="hint">No pricing revisions have been published from the console yet.</p> }
          @else {
            <div class="history-scroll">
              <table>
                <thead><tr><th>Date</th><th>Tier</th><th>Migration</th><th>Migrated</th><th>Failed</th></tr></thead>
                <tbody>@for (event of events(); track field(event, 'id')) {
                  <tr><td>{{ date(stringField(event, 'created_at')) }}</td><td>{{ field(event, 'plan_code') }}</td><td>{{ label(stringField(event, 'migration_mode')) }}</td><td>{{ field(event, 'migrated_count') }}</td><td>{{ field(event, 'failed_count') }}</td></tr>
                }</tbody>
              </table>
            </div>
          }
        </section>
      }
    </main>
  `,
  styles: [`
    .pricing-console{max-width:1500px;margin:auto;padding:28px 0;color:var(--color-text)}
    .page-header{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:1.25rem}.page-header h1{margin:.35rem 0;font-size:2rem}.page-header p{margin:0;color:var(--color-text-muted);max-width:720px}.back-link{font-size:.85rem}.header-actions{display:flex;gap:.6rem;flex-wrap:wrap}
    button,.secondary{min-height:42px;padding:0 .9rem;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface);color:var(--color-text);font:inherit;font-weight:700;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}
    .safety-note{display:flex;gap:.75rem;align-items:center;padding:1rem 1.1rem;margin-bottom:1rem;border-radius:var(--radius-lg);background:#eef6ff;border:1px solid #c9e0ff;color:#174d83}.safety-note span{font-size:.88rem}.success,.error,.loading{padding:1rem;border-radius:var(--radius-md)}.success{background:#e8f7ee;color:#18794e}.error{background:#fde8e8;color:#b42318}.loading{color:var(--color-text-muted)}
    .tier-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem;align-items:start}.tier-card{display:grid;min-width:0;gap:1rem;padding:1.2rem;border:1px solid var(--color-border);border-radius:var(--radius-lg);background:var(--color-surface);box-shadow:var(--shadow-sm)}.tier-card>*{min-width:0}.tier-card.featured{border-color:var(--color-primary);box-shadow:0 0 0 1px var(--color-primary)}
    .tier-header{display:flex;justify-content:space-between;gap:.75rem}.tier-header h2{margin:.2rem 0 0}.eyebrow{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-muted)}.visibility{height:max-content;padding:.2rem .55rem;border-radius:999px;background:#e8f7ee;color:#18794e;font-size:.7rem;font-weight:800}.visibility.off{background:#eee;color:#666}
    .price-preview{display:grid;grid-template-columns:auto 1fr;align-items:end;gap:.15rem .55rem;padding:1rem;border-radius:var(--radius-md);background:var(--color-bg)}.price-preview .deal-badge{grid-column:1/-1;width:max-content;padding:.18rem .45rem;border-radius:999px;background:var(--color-primary);color:#fff;font-size:.68rem;font-weight:800}.price-preview s{color:var(--color-text-muted)}.price-preview strong{font-size:1.7rem}.price-preview small{grid-column:1/-1;color:var(--color-text-muted)}
    label{display:grid;min-width:0;gap:.32rem;font-size:.75rem;font-weight:700;color:var(--color-text-muted)}input,textarea,select{width:100%;min-width:0;min-height:42px;padding:.55rem .65rem;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg);color:var(--color-text);font:inherit}textarea{resize:vertical}.fields{display:grid;min-width:0;gap:.75rem}.two-cols{grid-template-columns:repeat(2,minmax(0,1fr))}
    fieldset{display:grid;gap:.75rem;margin:0;padding:.9rem;border:1px solid var(--color-border);border-radius:var(--radius-md)}legend{padding:0 .35rem;font-size:.8rem;font-weight:800}.hint,.warning{margin:0;color:var(--color-text-muted);font-size:.72rem;line-height:1.45}.warning{color:#8a5a00}.toggles{display:flex;gap:1rem;flex-wrap:wrap}.toggles label,.check-row,.migration label{display:flex;align-items:flex-start;gap:.5rem;color:var(--color-text);font-weight:600}.toggles input,.check-row input,.migration input{width:auto;min-height:auto;margin-top:.15rem}
    details{padding:.85rem;border:1px solid var(--color-border);border-radius:var(--radius-md)}summary{cursor:pointer;font-size:.8rem;font-weight:800}details[open]{display:grid;gap:.75rem}.migration small{display:block;color:var(--color-text-muted);font-weight:400}.publish{width:100%;background:var(--color-primary);border-color:var(--color-primary);color:#fff}
    .history-card{margin-top:1.5rem;padding:1.2rem;border:1px solid var(--color-border);border-radius:var(--radius-lg);background:var(--color-surface)}.history-card h2{margin-top:0}.history-scroll{overflow:auto}table{width:100%;border-collapse:collapse;min-width:620px}th,td{text-align:left;padding:.7rem;border-top:1px solid var(--color-border);font-size:.78rem}th{color:var(--color-text-muted)}
    @media(max-width:1250px){.tier-grid{grid-template-columns:1fr 1fr}}
    @media(max-width:700px){.pricing-console{padding-top:18px}.page-header{display:block}.header-actions{margin-top:1rem}.safety-note{align-items:flex-start;flex-direction:column}.tier-grid{grid-template-columns:1fr}.tier-card:last-child{grid-column:auto}.two-cols{grid-template-columns:1fr}}
  `],
})
export class PlatformPricingComponent implements OnInit {
  private api = inject(ApiService);
  loading = signal(true);
  savingPlan = signal('');
  error = signal('');
  message = signal('');
  stripeConfigured = signal(false);
  forms = signal<PricingForm[]>([]);
  events = signal<Array<Record<string, unknown>>>([]);

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true); this.error.set('');
    this.api.getPlatformPricing().subscribe({
      next: (data) => { this.applyConsole(data); this.loading.set(false); },
      error: (err) => { this.error.set(err?.error?.detail || 'Could not load pricing.'); this.loading.set(false); },
    });
  }

  private applyConsole(data: PlatformPricingConsole): void {
    this.stripeConfigured.set(data.stripe_configured);
    this.events.set(data.events || []);
    this.forms.set(data.plans.map((plan) => this.toForm(plan)));
  }

  private toForm(plan: PlatformPricingPlan): PricingForm {
    return {
      planCode: plan.plan_code,
      version: plan.version || 0,
      name: plan.name,
      description: plan.description || '',
      regularPrice: this.pounds(plan.regular_price_cents),
      offerPrice: plan.offer_price_cents == null ? null : this.pounds(plan.offer_price_cents),
      discountPercent: plan.offer_price_cents == null || !plan.regular_price_cents
        ? null
        : Math.round((1 - plan.offer_price_cents / plan.regular_price_cents) * 1000) / 10,
      extraTablePrice: this.pounds(plan.extra_table_price_cents),
      includedTables: plan.included_tables,
      trialDays: plan.trial_days,
      offerBadge: plan.offer_badge || '',
      offerStartsAt: this.inputDate(plan.offer_starts_at),
      offerEndsAt: this.inputDate(plan.offer_ends_at),
      isFeatured: plan.is_featured,
      isPublic: plan.plan_code === 'pilot' ? false : plan.is_public,
      stripeProductId: plan.stripe_product_id || '',
      stripeRegularPriceId: plan.stripe_regular_price_id || '',
      stripeOfferPriceId: plan.stripe_offer_price_id || '',
      stripeExtraTablePriceId: plan.stripe_extra_table_price_id || '',
      createStripePrices: false,
      migrationMode: 'new_customers_only',
    };
  }

  publish(form: PricingForm): void {
    if (form.planCode === 'pilot') {
      form.isPublic = false;
      form.includedTables = 10_000;
      form.createStripePrices = false;
      form.stripeProductId = '';
      form.stripeRegularPriceId = '';
      form.stripeOfferPriceId = '';
      form.stripeExtraTablePriceId = '';
    }
    if (!form.name.trim()) { this.error.set('Tier name is required.'); return; }
    if (form.offerPrice !== null && form.offerPrice >= form.regularPrice) { this.error.set('Offer price must be lower than the regular price.'); return; }
    const warning = form.migrationMode === 'immediate'
      ? 'This can invoice existing customers immediately using Stripe prorations.'
      : form.migrationMode === 'next_renewal'
        ? 'Existing subscriptions will move to the new Stripe price without a mid-cycle charge.'
        : 'Existing customers will retain their contracted prices.';
    if (!confirm(`Publish a new ${form.name} pricing revision?\n\n${warning}`)) return;
    const body: PlatformPricingPublish = {
      name: form.name.trim(), description: form.description.trim() || null,
      regular_price_cents: this.cents(form.regularPrice),
      offer_price_cents: form.offerPrice === null ? null : this.cents(form.offerPrice),
      currency: 'gbp', included_tables: Math.max(0, Number(form.includedTables) || 0),
      extra_table_price_cents: this.cents(form.extraTablePrice), trial_days: Math.max(0, Number(form.trialDays) || 0),
      offer_badge: form.offerBadge.trim() || null,
      offer_starts_at: this.isoDate(form.offerStartsAt), offer_ends_at: this.isoDate(form.offerEndsAt),
      is_featured: form.isFeatured, is_public: form.isPublic,
      stripe_product_id: form.stripeProductId.trim() || null,
      stripe_regular_price_id: form.stripeRegularPriceId.trim() || null,
      stripe_offer_price_id: form.stripeOfferPriceId.trim() || null,
      stripe_extra_table_price_id: form.stripeExtraTablePriceId.trim() || null,
      create_stripe_prices: form.createStripePrices, migration_mode: form.migrationMode,
    };
    this.savingPlan.set(form.planCode); this.error.set(''); this.message.set('');
    this.api.publishPlatformPricing(form.planCode, body).subscribe({
      next: (data) => {
        const result = data.publication;
        this.applyConsole(data); this.savingPlan.set('');
        this.message.set(`Published ${form.name} revision ${result?.version}. Migrated ${result?.migrated_count || 0}; failed ${result?.failed_count || 0}.`);
      },
      error: (err) => { this.error.set(err?.error?.detail || 'Pricing publication failed.'); this.savingPlan.set(''); },
    });
  }

  money(value: number | null): string { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(value || 0)); }
  syncDiscountFromOffer(form: PricingForm): void { form.discountPercent = form.offerPrice === null || !form.regularPrice ? null : Math.round((1 - form.offerPrice / form.regularPrice) * 1000) / 10; }
  applyDiscountPercent(form: PricingForm): void { const percent = Number(form.discountPercent); form.offerPrice = form.discountPercent === null || !Number.isFinite(percent) ? null : Math.round(form.regularPrice * (1 - Math.min(99, Math.max(0, percent)) / 100) * 100) / 100; }
  pounds(cents: number): number { return Math.round(Number(cents || 0)) / 100; }
  cents(pounds: number): number { return Math.round(Math.max(0, Number(pounds || 0)) * 100); }
  inputDate(value?: string | null): string { if (!value) return ''; const date = new Date(value); const offset = date.getTimezoneOffset() * 60000; return new Date(date.getTime() - offset).toISOString().slice(0, 16); }
  isoDate(value: string): string | null { return value ? new Date(value).toISOString() : null; }
  date(value: string): string { return value ? new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'Not available'; }
  label(value: string): string { return value.replaceAll('_', ' '); }
  field(row: Record<string, unknown>, key: string): unknown { return row[key]; }
  stringField(row: Record<string, unknown>, key: string): string { return String(row[key] || ''); }
}
