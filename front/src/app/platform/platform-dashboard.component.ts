import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import {
  ApiService,
  PlatformMetrics,
  PlatformSubscriptionMetrics,
  PlatformTenantSummary,
} from '../services/api.service';

@Component({
  selector: 'app-platform-dashboard',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="overview-page">
      <header class="overview-heading">
        <div><h1>Platform overview</h1><p>Customer health, recurring revenue and recent activity across Scanaki.</p></div>
        <span class="updated">Updated {{ updatedAt() ? time(updatedAt()!) : 'now' }}</span>
      </header>

      @if (error()) { <p class="error-banner" role="alert">{{ error() }}</p> }
      @if (loading()) {
        <section class="metric-skeleton" aria-label="Loading overview">@for(item of [1,2,3,4,5];track item){<span></span>}</section>
      } @else if (metrics() && subscriptions()) {
        <section class="metric-strip" aria-label="Platform metrics">
          <article class="metric-primary"><span>Monthly recurring revenue</span><strong>{{ money(subscriptions()!.mrr_cents) }}</strong><small>{{ subscriptions()!.active_count }} active subscriptions</small></article>
          <article><span>Restaurants</span><strong>{{ metrics()!.tenant_count }}</strong><small>{{ metrics()!.signups_last_30_days }} added in 30 days</small></article>
          <article><span>Trials</span><strong>{{ subscriptions()!.trialing_count }}</strong><small>Accounts evaluating Scanaki</small></article>
          <article [class.metric-alert]="subscriptions()!.past_due_count > 0"><span>Past due</span><strong>{{ subscriptions()!.past_due_count }}</strong><small>Payment follow-up required</small></article>
          <article><span>30-day revenue</span><strong>{{ money(subscriptions()!.revenue_30d_cents) }}</strong><small>{{ subscriptions()!.churn_rate_30d }}% churn</small></article>
        </section>

        <div class="overview-grid">
          <section class="panel restaurants-panel">
            <header><div><h2>Recent restaurants</h2><p>Newest customer accounts and onboarding state.</p></div><a routerLink="/platform/restaurants">View directory</a></header>
            @if (tenants().length === 0) {
              <div class="empty"><strong>No restaurants yet</strong><a routerLink="/platform/restaurants/new">Create the first account</a></div>
            } @else {
              <div class="customer-list">
                @for (tenant of tenants().slice(0,5); track tenant.id) {
                  <a [routerLink]="['/platform/tenants',tenant.id]" class="customer-row">
                    <span class="customer-avatar">{{ initials(tenant.name) }}</span>
                    <span class="customer-name"><strong>{{ tenant.name }}</strong><small>{{ tenant.owner_name || tenant.owner_email || 'Owner not provided' }}</small></span>
                    <span class="customer-plan">{{ tenant.saas_plan_code }}</span>
                    <span class="customer-usage">{{ tenant.table_count }}/{{ tenant.ordering_points_unlimited ? 'Unlimited' : tenant.table_limit }} ordering points</span>
                    <span class="kds-state" [class.kds-state--offline]="tenant.kds_required && !tenant.kds_online">
                      {{ !tenant.kds_required ? 'KDS not required' : tenant.kds_online ? 'Kitchen online' : 'Kitchen offline' }}
                    </span>
                    <span class="status" [attr.data-status]="tenant.onboarding_status">{{ label(tenant.onboarding_status) }}</span>
                  </a>
                }
              </div>
            }
          </section>

          <aside class="panel health-panel">
            <header><div><h2>Subscription health</h2><p>Current customer lifecycle.</p></div><a routerLink="/platform/subscriptions">Open console</a></header>
            <dl>
              <div><dt>Active</dt><dd>{{ subscriptions()!.active_count }}</dd></div>
              <div><dt>Trialing</dt><dd>{{ subscriptions()!.trialing_count }}</dd></div>
              <div><dt>Suspended</dt><dd>{{ subscriptions()!.suspended_count }}</dd></div>
              <div><dt>Canceling</dt><dd>{{ subscriptions()!.canceling_count }}</dd></div>
              <div><dt>Churned, 30 days</dt><dd>{{ subscriptions()!.churned_30d }}</dd></div>
            </dl>
          </aside>
        </div>

        <section class="panel activity-panel">
          <header><div><h2>Recent account activity</h2><p>Latest successful sign-ins across platform and restaurant users.</p></div><span>{{ metrics()!.logins_last_24_hours }} in 24 hours</span></header>
          @if (metrics()!.recent_logins.length === 0) { <div class="empty"><strong>No login activity recorded</strong></div> }
          @else {
            <div class="activity-table"><table><thead><tr><th>User</th><th>Role</th><th>Restaurant</th><th>Scope</th><th>Time</th></tr></thead><tbody>
              @for(row of metrics()!.recent_logins.slice(0,10);track row.logged_in_at){<tr><td>{{ row.user_email || 'Unknown user' }}</td><td>{{ label(row.role || 'unknown') }}</td><td>{{ row.tenant_name || 'Platform' }}</td><td>{{ label(row.login_scope || 'unknown') }}</td><td>{{ date(row.logged_in_at) }}</td></tr>}
            </tbody></table></div>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    .overview-page{max-width:1480px;margin:auto;padding:28px 0;color:var(--color-text)}.overview-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:22px}.overview-heading h1{margin:0;font-size:25px;letter-spacing:-.025em}.overview-heading p{margin:5px 0 0;color:var(--color-text-muted);font-size:13px}.updated{padding:6px 8px;border:1px solid var(--color-border);border-radius:7px;background:#fff;color:var(--color-text-muted);font-size:10px;white-space:nowrap}
    .metric-strip,.metric-skeleton{display:grid;grid-template-columns:1.45fr repeat(4,1fr);overflow:hidden;margin-bottom:18px;border:1px solid var(--color-border);border-radius:12px;background:#fff}.metric-strip article{display:grid;align-content:center;min-height:112px;padding:15px 17px;border-right:1px solid var(--color-border)}.metric-strip article:last-child{border-right:0}.metric-strip span{color:var(--color-text-muted);font-size:10px;font-weight:650}.metric-strip strong{margin-top:7px;font-size:24px;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.03em}.metric-strip small{margin-top:8px;color:#8a9099;font-size:9px}.metric-primary{background:#202226!important;color:#fff}.metric-primary span,.metric-primary small{color:#aeb3ba!important}.metric-primary strong{font-size:28px}.metric-alert strong{color:#b64235}.metric-skeleton{gap:1px;background:var(--color-border)}.metric-skeleton span{height:112px;background:linear-gradient(90deg,#fafbfc,#f1f3f5,#fafbfc);background-size:200% 100%;animation:shimmer 1.3s linear infinite}
    .overview-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(280px,.7fr);gap:18px;margin-bottom:18px}.panel{overflow:hidden;border:1px solid var(--color-border);border-radius:12px;background:#fff}.panel>header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 16px;border-bottom:1px solid var(--color-border)}.panel h2{margin:0;font-size:14px}.panel header p{margin:3px 0 0;color:var(--color-text-muted);font-size:10px}.panel header a,.panel header>span{font-size:10px;font-weight:700}.customer-list{display:grid}.customer-row{display:grid;grid-template-columns:auto minmax(180px,1.5fr) .55fr .75fr auto auto;gap:11px;align-items:center;min-height:62px;padding:9px 15px;border-bottom:1px solid #eceef1;color:var(--color-text);text-decoration:none}.customer-row:last-child{border-bottom:0}.customer-row:hover{background:#fafbfc;text-decoration:none}.customer-avatar{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;background:#eef0f3;color:#4f5661;font-size:9px;font-weight:800}.customer-name{display:grid;min-width:0}.customer-name strong{overflow:hidden;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.customer-name small{margin-top:3px;overflow:hidden;color:var(--color-text-muted);font-size:9px;text-overflow:ellipsis;white-space:nowrap}.customer-plan{text-transform:capitalize;font-size:10px;font-weight:700}.customer-usage{color:var(--color-text-muted);font-size:10px}.kds-state{color:#24724a;font-size:9px;font-weight:700;white-space:nowrap}.kds-state--offline{color:#b64235}.status{padding:4px 7px;border-radius:6px;background:#eef0f3;color:#555b65;font-size:9px;font-weight:700;white-space:nowrap}.status[data-status=completed]{background:#e7f5ec;color:#24724a}.status[data-status=in_progress]{background:#fff3d9;color:#895d06}
    .health-panel dl{margin:0;padding:4px 16px 10px}.health-panel dl div{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid #eceef1}.health-panel dl div:last-child{border-bottom:0}.health-panel dt{color:var(--color-text-muted);font-size:10px}.health-panel dd{margin:0;font-size:14px;font-weight:750;font-variant-numeric:tabular-nums}.activity-panel>header>span{color:var(--color-text-muted)}.activity-table{overflow:auto}.activity-table table{width:100%;min-width:760px;border-collapse:collapse}.activity-table th,.activity-table td{padding:10px 15px;border-bottom:1px solid #eceef1;text-align:left;font-size:10px}.activity-table th{background:#fafbfc;color:#747b86;font-size:9px;letter-spacing:.05em;text-transform:uppercase}.activity-table tbody tr:last-child td{border-bottom:0}.empty{display:grid;place-items:center;gap:7px;min-height:150px;color:var(--color-text-muted);font-size:11px}.error-banner{padding:10px;border-radius:8px;background:#feeceb;color:#a9382e}
    @keyframes shimmer{to{background-position:-200% 0}}@media(max-width:1100px){.metric-strip,.metric-skeleton{grid-template-columns:repeat(3,1fr)}.metric-strip article:nth-child(3){border-right:0}.metric-primary{grid-row:span 2}.overview-grid{grid-template-columns:1fr}}@media(max-width:700px){.overview-page{padding-top:18px}.overview-heading{display:block}.updated{display:inline-block;margin-top:10px}.metric-strip,.metric-skeleton{grid-template-columns:1fr 1fr}.metric-primary{grid-column:1/-1;grid-row:auto}.metric-strip article{border-right:1px solid var(--color-border);border-bottom:1px solid var(--color-border)}.metric-strip article:nth-child(odd):not(.metric-primary){border-right:0}.customer-row{grid-template-columns:auto 1fr auto}.customer-plan,.customer-usage{display:none}.kds-state{grid-column:2}}@media(prefers-reduced-motion:reduce){.metric-skeleton span{animation:none}}
  `],
})
export class PlatformDashboardComponent implements OnInit, OnDestroy {
  private api=inject(ApiService);
  metrics=signal<PlatformMetrics|null>(null);subscriptions=signal<PlatformSubscriptionMetrics|null>(null);tenants=signal<PlatformTenantSummary[]>([]);loading=signal(true);error=signal('');updatedAt=signal<string|null>(null);
  private kdsRefreshIntervalId:ReturnType<typeof setInterval>|null=null;
  ngOnInit():void{this.load();this.kdsRefreshIntervalId=setInterval(()=>this.refreshKitchenHealth(),10_000)}
  ngOnDestroy():void{if(this.kdsRefreshIntervalId)clearInterval(this.kdsRefreshIntervalId)}
  load():void{this.loading.set(true);this.error.set('');forkJoin({metrics:this.api.getPlatformMetrics(),subscriptions:this.api.getPlatformSubscriptionMetrics(),tenants:this.api.getPlatformTenants()}).subscribe({next:({metrics,subscriptions,tenants})=>{this.metrics.set(metrics);this.subscriptions.set(subscriptions);this.tenants.set(tenants);this.updatedAt.set(new Date().toISOString());this.loading.set(false)},error:()=>{this.error.set('Could not load the platform overview.');this.loading.set(false)}})}
  money(cents:number):string{return new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP',maximumFractionDigits:0}).format((cents||0)/100)}
  date(value:string):string{return new Date(value).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'})}
  time(value:string):string{return new Date(value).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}
  label(value:string):string{return value.replaceAll('_',' ')}
  initials(value:string):string{return value.split(/\s+/).filter(Boolean).slice(0,2).map(part=>part[0]).join('').toUpperCase()}
  private refreshKitchenHealth():void{this.api.getPlatformTenants().subscribe({next:(rows)=>{this.tenants.set(rows);this.updatedAt.set(new Date().toISOString())},error:()=>{}})}
}
