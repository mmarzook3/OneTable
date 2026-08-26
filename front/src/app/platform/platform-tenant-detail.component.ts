import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { ApiService, PlatformTenantDetail, TenantLocation } from '../services/api.service';

@Component({
  selector: 'app-platform-tenant-detail',
  standalone: true,
  imports: [RouterLink, TranslateModule, FormsModule],
  template: `
    <div class="platform-page">
      <header class="platform-header">
        <div>
          @if (tenant()) {
            <h1>{{ tenant()!.name }}</h1>
            <p class="platform-subtitle">{{ 'PLATFORM_DASHBOARD.TENANT_ID' | translate }} {{ tenant()!.id }}</p>
          }
        </div>
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
                <span class="platform-muted">Not available</span>
              }
            </dd>
            <dt>{{ 'PLATFORM_DASHBOARD.COL_PHONE' | translate }}</dt>
            <dd>{{ tenant()!.tenant_phone || 'Not available' }}</dd>
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

        <section
          class="platform-section kds-health"
          [class.kds-health--offline]="tenant()!.kds_required && !tenant()!.kds_online"
          data-testid="platform-kds-health"
        >
          <div>
            <h2>Kitchen connection</h2>
            <p class="platform-muted">Native app and browser heartbeat monitoring</p>
          </div>
          <strong class="kds-health-status">
            {{ !tenant()!.kds_required ? 'Not required' : tenant()!.kds_online ? 'Online' : 'Offline' }}
          </strong>
          <dl>
            <div><dt>Online devices</dt><dd>{{ tenant()!.kds_online_device_count }}/{{ tenant()!.kds_device_count }}</dd></div>
            <div><dt>Last heartbeat</dt><dd>{{ heartbeatAge(tenant()!.kds_last_seen_at) }}</dd></div>
            <div><dt>Offline threshold</dt><dd>{{ tenant()!.kds_heartbeat_timeout_seconds }} seconds</dd></div>
          </dl>
        </section>

        <section class="platform-section location-oversight">
          <div class="subscription-heading"><div><h2>Locations</h2><p class="platform-muted">Ordering-point usage, inheritance and launch readiness</p></div><button type="button" class="link-btn" (click)="beginLocationCreate()">Add location</button></div>
          @if (locationFormOpen()) {
            <form class="platform-location-form" (submit)="saveLocation($event)">
              <label>Internal name <input [(ngModel)]="locationForm.name" name="platformLocationName" required></label>
              <label>Customer display name <input [(ngModel)]="locationForm.display_name" name="platformLocationDisplay" required></label>
              <label>Type <select [(ngModel)]="locationForm.location_type" name="platformLocationType"><option value="pub">Pub</option><option value="lounge">Lounge</option><option value="hotel_building">Hotel building</option><option value="other">Other</option></select></label>
              <button type="button" class="link-btn secondary" (click)="locationFormOpen.set(false)">Cancel</button><button type="submit" class="link-btn">Save</button>
            </form>
          }
          <div class="platform-location-list">
            @for (location of locations(); track location.id) {
              <article>
                <div><strong>{{ location.display_name }}</strong><small>{{ location.location_type }} · {{ location.active_ordering_point_count }} active points</small></div>
                <div><span>Menu {{ location.menu_mode }}</span><span>Hours {{ location.hours_mode }}</span><span>Kitchen {{ location.kitchen_mode }}</span></div>
                <div class="location-row-actions"><b [class.attention]="location.ordering_paused || !location.is_active">{{ !location.is_active ? 'Archived' : location.ordering_paused ? 'Paused' : 'Active' }}</b><button type="button" (click)="beginLocationEdit(location)">Edit</button>@if (location.is_active) { <button type="button" (click)="archiveLocation(location)">Archive</button> }</div>
              </article>
            } @empty { <p class="platform-muted">No location data is available.</p> }
          </div>
          @if (locations().length) { <p class="platform-muted">Plan usage: {{ locations()[0].ordering_point_usage }}/{{ locations()[0].ordering_point_limit }} active ordering points</p> }
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
          <p class="platform-muted">Plan: {{ tenant()!.saas_plan_code }} · {{ tenant()!.table_count }}/{{ tenant()!.ordering_points_unlimited ? 'Unlimited' : tenant()!.table_limit }} active ordering points</p>
          <div class="plan-controls">
            <label>Plan
              <select [(ngModel)]="planCode">
                <option value="lite">Lite</option><option value="pro">Pro</option><option value="ultra">Ultra</option><option value="pilot">Pilot</option>
              </select>
            </label>
            <label>Extra ordering points <input type="number" min="0" max="500" [(ngModel)]="extraTables"></label>
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
            <dt>Trial expiry</dt><dd>{{ tenant()!.trial_ends_at ? formatDate(tenant()!.trial_ends_at!) : 'Not available' }}</dd>
            <dt>Renewal</dt><dd>{{ tenant()!.renewal_at ? formatDate(tenant()!.renewal_at!) : 'Not available' }}</dd>
            <dt>Monthly value</dt><dd>£{{ (tenant()!.monthly_cents / 100).toFixed(2) }}</dd>
            <dt>Stripe customer</dt><dd><code>{{ tenant()!.stripe_customer_id || 'Not connected' }}</code> @if (tenant()!.stripe_customer_url) { <a [href]="tenant()!.stripe_customer_url!" target="_blank" rel="noopener noreferrer">Open in Stripe</a> }</dd>
            <dt>Stripe subscription</dt><dd><code>{{ tenant()!.stripe_subscription_id || 'Not connected' }}</code></dd>
            <dt>Last failed payment</dt><dd>{{ tenant()!.last_payment_failed_at ? formatDate(tenant()!.last_payment_failed_at!) : 'None' }}</dd>
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
                    <td>{{ u.full_name || 'Not provided' }}</td>
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
      padding: 28px 0;
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
    .kds-health { display: grid; grid-template-columns: minmax(220px,1fr) auto; align-items: center; gap: var(--space-3) var(--space-5); padding: var(--space-4); border: 1px solid #18794e; border-radius: var(--radius-lg); background: #f4fbf7; }
    .kds-health h2,.kds-health p { margin: 0; }
    .kds-health p { margin-top: 3px; font-size: .8rem; }
    .kds-health-status { color: #18794e; font-size: 1rem; }
    .kds-health dl { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3,1fr); margin: 0; border-top: 1px solid #cce5d6; }
    .kds-health dl div { display: grid; gap: 3px; padding: 12px 12px 0 0; }
    .kds-health dt { color: var(--color-text-muted); font-size: .72rem; }
    .kds-health dd { margin: 0; font-size: .9rem; font-weight: 600; font-variant-numeric: tabular-nums; }
    .kds-health--offline { border-color: #b64235; background: #fff6f4; }
    .kds-health--offline .kds-health-status { color: #b64235; }
    .kds-health--offline dl { border-top-color: #f0c8c2; }
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
    .location-oversight { padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
    .platform-location-list { display: grid; }
    .platform-location-list article { display: grid; grid-template-columns: minmax(200px,1fr) minmax(260px,1fr) auto; align-items: center; gap: var(--space-4); padding: var(--space-3) 0; border-bottom: 1px solid var(--color-border); }
    .platform-location-list article:last-child { border-bottom: 0; }
    .platform-location-list article>div { display: grid; gap: 4px; }
    .platform-location-list article>div:nth-child(2) { grid-template-columns: repeat(3,1fr); color: var(--color-text-muted); font-size: .78rem; text-transform: capitalize; }
    .platform-location-list small { color: var(--color-text-muted); }
    .platform-location-list b { color: #18794e; font-size: .78rem; }
    .platform-location-list b.attention { color: var(--color-error); }
    .platform-location-form { display: grid; grid-template-columns: 1fr 1fr 180px auto auto; align-items: end; gap: var(--space-2); margin: var(--space-3) 0; padding: var(--space-3); border-radius: var(--radius-md); background: var(--color-bg); }
    .platform-location-form label { display: grid; gap: 4px; color: var(--color-text-muted); font-size: .75rem; }
    .platform-location-form input,.platform-location-form select { min-height: 38px; padding: 0 var(--space-2); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); color: var(--color-text); }
    .link-btn.secondary { background: var(--color-bg); color: var(--color-text); border: 1px solid var(--color-border); }
    .location-row-actions { display: flex!important; align-items: center; gap: 7px!important; }
    .location-row-actions button { border: 0; background: transparent; color: var(--color-primary); font-size: .75rem; cursor: pointer; }
    @media(max-width:720px){.platform-location-list article,.platform-location-form{grid-template-columns:1fr}.platform-location-list article>div:nth-child(2){grid-template-columns:1fr}.kds-health{grid-template-columns:1fr}.kds-health-status{justify-self:start}.kds-health dl{grid-template-columns:1fr}.kds-health dl div{padding-top:9px}}
  `]
})
export class PlatformTenantDetailComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);

  tenant = signal<PlatformTenantDetail | null>(null);
  loading = signal(true);
  error = signal('');
  planCode = 'lite';
  extraTables = 0;
  planSaving = signal(false);
  locations = signal<TenantLocation[]>([]);
  locationFormOpen = signal(false);
  editingLocationId = signal<number | null>(null);
  locationForm = { name: '', display_name: '', location_type: 'pub' };
  private tenantId = 0;
  private kdsRefreshIntervalId: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('tenantId'));
    if (!Number.isFinite(id) || id <= 0) {
      this.error.set('PLATFORM_DASHBOARD.TENANT_NOT_FOUND');
      this.loading.set(false);
      return;
    }
    this.tenantId = id;
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
    this.api.getPlatformTenantLocations(id).subscribe({
      next: (rows) => this.locations.set(rows),
      error: () => this.locations.set([]),
    });
    this.kdsRefreshIntervalId = setInterval(() => this.refreshKdsHealth(), 10_000);
  }

  ngOnDestroy(): void {
    if (this.kdsRefreshIntervalId) clearInterval(this.kdsRefreshIntervalId);
  }

  formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  heartbeatAge(iso?: string | null): string {
    if (!iso) return 'Never received';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 10) return '< 10 seconds ago';
    if (seconds < 60) return `${seconds} seconds ago`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
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

  beginLocationCreate(): void { this.editingLocationId.set(null); this.locationForm = { name: '', display_name: '', location_type: 'pub' }; this.locationFormOpen.set(true); }
  beginLocationEdit(location: TenantLocation): void { this.editingLocationId.set(location.id); this.locationForm = { name: location.name, display_name: location.display_name, location_type: location.location_type }; this.locationFormOpen.set(true); }
  saveLocation(event: Event): void { event.preventDefault(); const tenant = this.tenant(); if (!tenant) return; const request = this.editingLocationId() == null ? this.api.createPlatformTenantLocation(tenant.id, this.locationForm) : this.api.updatePlatformTenantLocation(tenant.id, this.editingLocationId()!, this.locationForm as any); request.subscribe({ next: () => { this.locationFormOpen.set(false); this.reloadLocations(tenant.id); }, error: () => {} }); }
  archiveLocation(location: TenantLocation): void { const tenant = this.tenant(); if (!tenant || !confirm(`Archive ${location.display_name} and disable its ordering points?`)) return; this.api.archivePlatformTenantLocation(tenant.id, location.id).subscribe({ next: () => this.reloadLocations(tenant.id), error: () => {} }); }
  private reloadLocations(tenantId: number): void { this.api.getPlatformTenantLocations(tenantId).subscribe({ next: (rows) => this.locations.set(rows), error: () => this.locations.set([]) }); }

  private refreshKdsHealth(): void {
    if (!this.tenantId) return;
    this.api.getPlatformTenant(this.tenantId).subscribe({
      next: (fresh) => this.tenant.update((current) => current ? {
        ...current,
        kds_required: fresh.kds_required,
        kds_online: fresh.kds_online,
        kds_device_count: fresh.kds_device_count,
        kds_online_device_count: fresh.kds_online_device_count,
        kds_last_seen_at: fresh.kds_last_seen_at,
        kds_heartbeat_timeout_seconds: fresh.kds_heartbeat_timeout_seconds,
      } : fresh),
      error: () => {},
    });
  }

}
