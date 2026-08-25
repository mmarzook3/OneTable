import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { ApiService, PlatformTenantDetail } from '../services/api.service';

@Component({
  selector: 'app-platform-tenant-detail',
  standalone: true,
  imports: [RouterLink, TranslateModule, FormsModule],
  template: `
    <div class="platform-page">
      <header class="platform-header">
        <div>
          <a routerLink="/platform" class="platform-back">{{ 'PLATFORM_DASHBOARD.BACK_TO_OVERVIEW' | translate }}</a>
          @if (tenant()) {
            <h1>{{ tenant()!.name }}</h1>
            <p class="platform-subtitle">{{ 'PLATFORM_DASHBOARD.TENANT_ID' | translate }} {{ tenant()!.id }}</p>
          }
        </div>
        <button type="button" class="btn-logout" (click)="logout()">
          {{ 'PLATFORM_DASHBOARD.LOGOUT' | translate }}
        </button>
      </header>

      @if (loading()) {
        <p class="platform-muted">{{ 'COMMON.LOADING' | translate }}</p>
      } @else if (error()) {
        <p class="platform-error">{{ error() | translate }}</p>
      } @else if (tenant()) {
        <section class="platform-section">
          <h2>{{ 'PLATFORM_DASHBOARD.CONTACT' | translate }}</h2>
          <dl class="detail-grid">
            <dt>{{ 'PLATFORM_DASHBOARD.OWNER_CONTACT' | translate }}</dt>
            <dd>
              @if (tenant()!.owner_email) {
                <a [href]="'mailto:' + tenant()!.owner_email">{{ tenant()!.owner_name || tenant()!.owner_email }}</a>
                @if (tenant()!.owner_name && tenant()!.owner_email) {
                  <span class="platform-muted"> ({{ tenant()!.owner_email }})</span>
                }
              } @else {
                <span class="platform-muted">{{ 'PLATFORM_DASHBOARD.NO_CONTACT' | translate }}</span>
              }
            </dd>
            <dt>{{ 'PLATFORM_DASHBOARD.BUSINESS_EMAIL' | translate }}</dt>
            <dd>
              @if (tenant()!.tenant_email) {
                <a [href]="'mailto:' + tenant()!.tenant_email">{{ tenant()!.tenant_email }}</a>
              } @else {
                <span class="platform-muted">—</span>
              }
            </dd>
            <dt>{{ 'PLATFORM_DASHBOARD.COL_PHONE' | translate }}</dt>
            <dd>{{ tenant()!.tenant_phone || '—' }}</dd>
            <dt>{{ 'PLATFORM_DASHBOARD.COL_CREATED' | translate }}</dt>
            <dd>{{ formatDate(tenant()!.created_at) }}</dd>
            @if (tenant()!.address) {
              <dt>{{ 'PLATFORM_DASHBOARD.ADDRESS' | translate }}</dt>
              <dd>{{ tenant()!.address }}</dd>
            }
            @if (tenant()!.website) {
              <dt>{{ 'PLATFORM_DASHBOARD.WEBSITE' | translate }}</dt>
              <dd><a [href]="tenant()!.website!" target="_blank" rel="noopener noreferrer">{{ tenant()!.website }}</a></dd>
            }
          </dl>
        </section>

        <section class="platform-section">
          <h2>{{ 'PLATFORM_DASHBOARD.STATS' | translate }}</h2>
          <div class="metrics-grid">
            <article class="metric-card">
              <h3>{{ 'PLATFORM_DASHBOARD.COL_PRODUCTS' | translate }}</h3>
              <p class="metric-value">{{ tenant()!.product_count }}</p>
            </article>
            <article class="metric-card">
              <h3>{{ 'PLATFORM_DASHBOARD.COL_TABLES' | translate }}</h3>
              <p class="metric-value">{{ tenant()!.table_count }}</p>
            </article>
            <article class="metric-card">
              <h3>{{ 'PLATFORM_DASHBOARD.COL_USERS' | translate }}</h3>
              <p class="metric-value">{{ tenant()!.user_count }}</p>
            </article>
            <article class="metric-card">
              <h3>{{ 'PLATFORM_DASHBOARD.COL_ORDERS' | translate }}</h3>
              <p class="metric-value">{{ tenant()!.order_count }}</p>
            </article>
            <article class="metric-card">
              <h3>{{ 'PLATFORM_DASHBOARD.COL_RESERVATIONS' | translate }}</h3>
              <p class="metric-value">{{ tenant()!.reservation_count }}</p>
            </article>
          </div>
        </section>

        <section class="platform-section readiness-card" [class.readiness-card--ready]="tenant()!.readiness.ready">
          <h2>Launch readiness</h2>
          <p class="readiness-summary">{{ tenant()!.readiness.ready ? 'Ready for controlled-beta launch' : tenant()!.readiness.missing.length + ' launch checks still need attention' }}</p>
          <div class="readiness-grid">
            @for (check of readinessEntries(); track check.key) {
              <span [class.readiness-ok]="check.value" [class.readiness-missing]="!check.value">
                {{ check.value ? '✓' : '○' }} {{ readinessLabel(check.key) }}
              </span>
            }
          </div>
          <p class="platform-muted">Plan: {{ tenant()!.saas_plan_code }} · {{ tenant()!.table_count }}/{{ tenant()!.table_limit }} tables</p>
          <div class="plan-controls">
            <label>Plan
              <select [(ngModel)]="planCode">
                <option value="lite">Lite</option><option value="pro">Pro</option><option value="ultra">Ultra</option>
              </select>
            </label>
            <label>Extra tables <input type="number" min="0" max="500" [(ngModel)]="extraTables"></label>
            <button type="button" class="link-btn" (click)="savePlan()" [disabled]="planSaving()">Save plan</button>
          </div>
        </section>

        <section class="platform-section subscription-card">
          <div class="subscription-heading">
            <div><h2>Subscription</h2><p class="platform-muted">Current entitlement and Stripe identifiers</p></div>
            <a routerLink="/platform/subscriptions" class="link-btn">Open subscription console</a>
          </div>
          <dl class="detail-grid">
            <dt>Status</dt><dd>{{ tenant()!.subscription_status }} @if (tenant()!.cancel_at_period_end) { · cancels at period end }</dd>
            <dt>Trial expiry</dt><dd>{{ tenant()!.trial_ends_at ? formatDate(tenant()!.trial_ends_at!) : '—' }}</dd>
            <dt>Renewal</dt><dd>{{ tenant()!.renewal_at ? formatDate(tenant()!.renewal_at!) : '—' }}</dd>
            <dt>Monthly value</dt><dd>£{{ (tenant()!.monthly_cents / 100).toFixed(2) }}</dd>
            <dt>Stripe customer</dt><dd><code>{{ tenant()!.stripe_customer_id || 'Not connected' }}</code> @if (tenant()!.stripe_customer_url) { <a [href]="tenant()!.stripe_customer_url!" target="_blank" rel="noopener noreferrer">Open in Stripe</a> }</dd>
            <dt>Stripe subscription</dt><dd><code>{{ tenant()!.stripe_subscription_id || '—' }}</code></dd>
            <dt>Last failed payment</dt><dd>{{ tenant()!.last_payment_failed_at ? formatDate(tenant()!.last_payment_failed_at!) : '—' }}</dd>
          </dl>
        </section>

        <section class="platform-section">
          <h2>{{ 'PLATFORM_DASHBOARD.PUBLIC_PAGES' | translate }}</h2>
          <p class="platform-muted section-hint">{{ 'PLATFORM_DASHBOARD.PUBLIC_PAGES_HINT' | translate }}</p>
          <div class="link-row">
            <a [href]="publicUrl('public-menu')" target="_blank" rel="noopener noreferrer" class="link-btn">
              {{ 'PLATFORM_DASHBOARD.LINK_PUBLIC_MENU' | translate }}
            </a>
            <a [href]="publicUrl('book')" target="_blank" rel="noopener noreferrer" class="link-btn">
              {{ 'PLATFORM_DASHBOARD.LINK_BOOK' | translate }}
            </a>
            <a [href]="publicUrl('waitlist')" target="_blank" rel="noopener noreferrer" class="link-btn">
              {{ 'PLATFORM_DASHBOARD.LINK_WAITLIST' | translate }}
            </a>
            <a [href]="publicUrl('delivery')" target="_blank" rel="noopener noreferrer" class="link-btn">
              {{ 'PLATFORM_DASHBOARD.LINK_DELIVERY' | translate }}
            </a>
          </div>
        </section>

        <section class="platform-section">
          <h2>{{ 'PLATFORM_DASHBOARD.STAFF_CONTACTS' | translate }}</h2>
          @if (tenant()!.staff_users.length === 0) {
            <p class="platform-muted">{{ 'PLATFORM_DASHBOARD.NO_STAFF' | translate }}</p>
          } @else {
            <table class="platform-table">
              <thead>
                <tr>
                  <th>{{ 'PLATFORM_DASHBOARD.COL_NAME' | translate }}</th>
                  <th>{{ 'PLATFORM_DASHBOARD.COL_EMAIL' | translate }}</th>
                  <th>{{ 'PLATFORM_DASHBOARD.COL_ROLE' | translate }}</th>
                </tr>
              </thead>
              <tbody>
                @for (u of tenant()!.staff_users; track u.email) {
                  <tr>
                    <td>{{ u.full_name || '—' }}</td>
                    <td><a [href]="'mailto:' + u.email">{{ u.email }}</a></td>
                    <td>{{ u.role }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    .platform-page {
      min-height: 100vh;
      padding: var(--space-6);
      background: var(--color-bg);
      color: var(--color-text);
      max-width: 1100px;
      margin: 0 auto;
    }
    .platform-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: var(--space-4);
      margin-bottom: var(--space-6);
    }
    .platform-back {
      display: inline-block;
      margin-bottom: var(--space-2);
      font-size: 0.875rem;
      color: var(--color-primary);
      text-decoration: none;
    }
    .platform-header h1 { font-size: 1.5rem; font-weight: 600; margin: 0; }
    .platform-subtitle { color: var(--color-text-muted); font-size: 0.9375rem; margin: var(--space-1) 0 0; }
    .btn-logout {
      padding: var(--space-2) var(--space-4);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
      cursor: pointer;
    }
    .platform-section { margin-bottom: var(--space-8); }
    .platform-section h2 { font-size: 1.125rem; margin-bottom: var(--space-3); }
    .section-hint { margin: 0 0 var(--space-3); font-size: 0.875rem; }
    .detail-grid {
      display: grid;
      grid-template-columns: minmax(140px, 200px) 1fr;
      gap: var(--space-2) var(--space-4);
      background: var(--color-surface);
      border-radius: var(--radius-md);
      padding: var(--space-4);
    }
    .detail-grid dt { font-weight: 500; color: var(--color-text-muted); margin: 0; }
    .detail-grid dd { margin: 0; }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: var(--space-4);
    }
    .metric-card {
      background: var(--color-surface);
      border-radius: var(--radius-lg);
      padding: var(--space-4);
      box-shadow: var(--shadow-sm);
    }
    .metric-card h3 {
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--color-text-muted);
      margin: 0 0 var(--space-2);
    }
    .metric-value { font-size: 1.5rem; font-weight: 600; margin: 0; }
    .link-row { display: flex; flex-wrap: wrap; gap: var(--space-3); }
    .link-btn {
      display: inline-block;
      padding: var(--space-2) var(--space-4);
      border-radius: var(--radius-md);
      background: var(--color-primary);
      color: #fff;
      text-decoration: none;
      font-size: 0.875rem;
    }
    .platform-table {
      width: 100%;
      border-collapse: collapse;
      background: var(--color-surface);
      border-radius: var(--radius-md);
      overflow: hidden;
    }
    .platform-table th,
    .platform-table td {
      padding: var(--space-3) var(--space-4);
      text-align: left;
      border-bottom: 1px solid var(--color-border);
      font-size: 0.875rem;
    }
    .platform-table th { background: var(--color-bg); font-weight: 500; }
    .platform-muted { color: var(--color-text-muted); }
    .platform-error { color: var(--color-error); }
    .readiness-card { padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
    .readiness-card--ready { border-color: #18794e; }
    .readiness-summary { font-weight: 700; }
    .readiness-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: var(--space-2); margin: var(--space-3) 0; }
    .readiness-ok { color: #18794e; }
    .readiness-missing { color: var(--color-error); }
    .plan-controls { display: flex; flex-wrap: wrap; align-items: end; gap: var(--space-3); margin-top: var(--space-4); }
    .plan-controls label { display: grid; gap: var(--space-1); font-size: 0.8rem; }
    .plan-controls select, .plan-controls input { min-height: 40px; padding: 0 var(--space-2); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg); color: var(--color-text); }
    .subscription-card { padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
    .subscription-heading { display: flex; justify-content: space-between; align-items: start; gap: var(--space-3); }
    .subscription-heading h2, .subscription-heading p { margin-top: 0; }
    code { word-break: break-all; }
  `]
})
export class PlatformTenantDetailComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  tenant = signal<PlatformTenantDetail | null>(null);
  loading = signal(true);
  error = signal('');
  planCode = 'lite';
  extraTables = 0;
  planSaving = signal(false);

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('tenantId'));
    if (!Number.isFinite(id) || id <= 0) {
      this.error.set('PLATFORM_DASHBOARD.TENANT_NOT_FOUND');
      this.loading.set(false);
      return;
    }
    this.api.getPlatformTenant(id).subscribe({
      next: (t) => {
        this.tenant.set(t);
        this.planCode = t.saas_plan_code;
        this.extraTables = t.saas_extra_tables;
        this.loading.set(false);
      },
      error: () => {
        this.error.set('PLATFORM_DASHBOARD.TENANT_NOT_FOUND');
        this.loading.set(false);
      },
    });
  }

  formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  publicUrl(segment: string): string {
    const id = this.tenant()?.id;
    if (!id || typeof window === 'undefined') return `/${segment}/${id ?? ''}`;
    return `${window.location.origin}/${segment}/${id}`;
  }

  readinessEntries(): { key: string; value: boolean }[] {
    return Object.entries(this.tenant()?.readiness.checks || {}).map(([key, value]) => ({ key, value }));
  }

  readinessLabel(key: string): string {
    return key.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase());
  }

  savePlan(): void {
    const tenant = this.tenant();
    if (!tenant || this.planSaving()) return;
    this.planSaving.set(true);
    this.api.updatePlatformTenantPlan(tenant.id, this.planCode, Math.max(0, Number(this.extraTables) || 0)).subscribe({
      next: (updated) => { this.tenant.set(updated); this.planSaving.set(false); },
      error: () => { this.planSaving.set(false); },
    });
  }

  logout(): void {
    this.api.logout().subscribe(() => this.router.navigate(['/platform/login']));
  }
}
