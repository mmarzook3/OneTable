import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import {
  ApiService,
  PlatformBillingHistory,
  PlatformSubscriptionList,
  PlatformSubscriptionMetrics,
  PlatformSubscriptionRow,
} from '../services/api.service';

@Component({
  selector: 'app-platform-subscriptions',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <main class="console-page">
      <header class="console-header">
        <div>
          <h1>Subscriptions</h1>
          <p>Plans, billing health, Stripe lifecycle and recurring revenue.</p>
        </div>
        <div class="header-links"><button type="button" class="secondary" (click)="load()" [disabled]="loading()">Refresh</button></div>
      </header>

      @if (metrics(); as metric) {
        <section class="metrics" aria-label="Subscription metrics">
          <article><span>MRR</span><strong>{{ money(metric.mrr_cents, metric.currency) }}</strong></article>
          <article><span>Revenue, 30 days</span><strong>{{ money(metric.revenue_30d_cents, metric.currency) }}</strong></article>
          <article><span>Total recorded revenue</span><strong>{{ money(metric.revenue_total_cents, metric.currency) }}</strong></article>
          <article><span>Active</span><strong>{{ metric.active_count }}</strong></article>
          <article class="metric-warning"><span>Past due</span><strong>{{ metric.past_due_count }}</strong></article>
          <article><span>Trials</span><strong>{{ metric.trialing_count }}</strong></article>
          <article><span>Canceling</span><strong>{{ metric.canceling_count }}</strong></article>
          <article><span>30-day churn</span><strong>{{ metric.churn_rate_30d }}%</strong></article>
        </section>
      }

      <section class="filters" aria-label="Subscription filters">
        <label class="search-field">Search
          <input [(ngModel)]="search" (keyup.enter)="applyFilters()" placeholder="Restaurant, email, Stripe ID">
        </label>
        <label>Status
          <select [(ngModel)]="statusFilter" (change)="applyFilters()">
            <option value="">All statuses</option><option value="active">Active</option><option value="trialing">Trialing</option>
            <option value="past_due">Past due</option><option value="suspended">Suspended</option><option value="canceled">Canceled</option>
            <option value="grandfathered">Grandfathered</option><option value="none">None</option>
          </select>
        </label>
        <label>Plan
          <select [(ngModel)]="planFilter" (change)="applyFilters()">
            <option value="">All plans</option><option value="lite">Lite</option><option value="pro">Pro</option><option value="ultra">Ultra</option>
          </select>
        </label>
        <label>Billing health
          <select [(ngModel)]="healthFilter" (change)="applyFilters()">
            <option value="">All accounts</option><option value="overdue">Overdue</option><option value="failed">Failed payment</option><option value="canceling">Canceling</option>
          </select>
        </label>
        <button type="button" class="primary" (click)="applyFilters()">Search</button>
        <button type="button" class="secondary" (click)="clearFilters()">Clear</button>
      </section>

      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      @if (loading()) {
        <div class="loading">Loading subscriptions...</div>
      } @else if (list(); as result) {
        <section class="table-card">
          <div class="table-summary">{{ result.total }} restaurants</div>
          <div class="table-scroll">
            <table>
              <thead><tr>
                <th>Restaurant</th><th>Status</th><th>Plan and tables</th><th>Trial / renewal</th><th>Billing health</th><th>Stripe</th><th>Actions</th>
              </tr></thead>
              <tbody>
                @for (row of result.items; track row.tenant_id) {
                  <tr [class.row-overdue]="row.status === 'past_due' || row.last_payment_failed_at">
                    <td>
                      <a [routerLink]="['/platform/tenants', row.tenant_id]" class="tenant-name">{{ row.tenant_name }}</a>
                      <small>{{ row.owner_email || 'No owner email' }}</small>
                      <small>MRR: {{ money(row.monthly_cents, row.currency) }}</small>
                    </td>
                    <td>
                      <span class="status" [attr.data-status]="row.status">{{ statusLabel(row) }}</span>
                      @if (row.cancel_at_period_end) { <small class="warning-text">Cancels at period end</small> }
                    </td>
                    <td>
                      <div class="inline-controls">
                        <select [value]="row.plan_code" (change)="changePlan(row, $event)">
                          <option value="lite">Lite</option><option value="pro">Pro</option><option value="ultra">Ultra</option>
                        </select>
                        <label class="extra-field">+<input type="number" min="0" max="500" [value]="row.extra_tables" (change)="changeExtraTables(row, $event)"></label>
                      </div>
                      <small>{{ row.table_count }}/{{ row.table_limit }} tables</small>
                    </td>
                    <td>
                      @if (row.status === 'trialing') { <span>Trial ends {{ date(row.trial_ends_at) }}</span> }
                      @else { <span>{{ row.renewal_at ? date(row.renewal_at) : 'No renewal date' }}</span> }
                    </td>
                    <td>
                      <span>{{ row.last_invoice_status || 'No invoice' }}</span>
                      @if (row.last_payment_failed_at) { <small class="danger-text">Failed {{ date(row.last_payment_failed_at) }}</small> }
                      @if (row.last_payment_at) { <small>Paid {{ date(row.last_payment_at) }}</small> }
                    </td>
                    <td>
                      <code>{{ row.stripe_customer_id || 'Not connected' }}</code>
                      <code>{{ row.stripe_subscription_id || '' }}</code>
                      @if (row.stripe_customer_url) { <a [href]="row.stripe_customer_url" target="_blank" rel="noopener noreferrer">Open in Stripe</a> }
                    </td>
                    <td>
                      <div class="actions">
                        <button type="button" (click)="showHistory(row)">History</button>
                        @if (row.status === 'suspended' || row.status === 'past_due' || row.status === 'canceled' || row.status === 'none') {
                          <button type="button" (click)="action(row, 'activate')">Activate</button>
                        } @else {
                          <button type="button" (click)="action(row, 'suspend')">Suspend</button>
                        }
                        <button type="button" (click)="action(row, 'grandfather')">Grandfather</button>
                        <button type="button" class="danger" (click)="action(row, 'cancel')">Cancel</button>
                        <button type="button" class="danger" (click)="action(row, 'cancel', true)">Cancel now</button>
                      </div>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <footer class="pagination">
            <button type="button" (click)="goPage(result.page - 1)" [disabled]="result.page <= 1">Previous</button>
            <span>Page {{ result.page }} of {{ result.pages }}</span>
            <button type="button" (click)="goPage(result.page + 1)" [disabled]="result.page >= result.pages">Next</button>
          </footer>
        </section>
      }

      @if (historyTenant(); as tenant) {
        <div class="modal-backdrop" (click)="closeHistory()"></div>
        <section class="history-modal" role="dialog" aria-modal="true" aria-labelledby="history-title">
          <header><div><h2 id="history-title">{{ tenant.tenant_name }}</h2><p>Invoices, payments and subscription events</p></div><button type="button" (click)="closeHistory()">Close</button></header>
          @if (historyLoading()) { <p>Loading billing history...</p> }
          @else if (history(); as data) {
            @if (data.stripe_error) { <p class="error">Stripe: {{ data.stripe_error }}</p> }
            @if (data.stripe_customer_url) { <a [href]="data.stripe_customer_url" target="_blank" rel="noopener noreferrer">Open customer in Stripe</a> }
            <h3>Invoices</h3>
            @if (data.invoices.length === 0) { <p class="muted">No Stripe invoices found.</p> }
            @else { <div class="history-list">@for (invoice of data.invoices; track field(invoice, 'id')) { <article><strong>{{ field(invoice, 'number') || field(invoice, 'id') }}</strong><span>{{ field(invoice, 'status') }}</span><span>{{ money(numberField(invoice, 'amount_paid') || numberField(invoice, 'amount_due'), stringField(invoice, 'currency')) }}</span><span>{{ date(stringField(invoice, 'created_at')) }}</span>@if (field(invoice, 'hosted_invoice_url')) { <a [href]="stringField(invoice, 'hosted_invoice_url')" target="_blank" rel="noopener noreferrer">View invoice</a> }</article> }</div> }
            <h3>Payments</h3>
            @if (data.payments.length === 0) { <p class="muted">No payment intents found.</p> }
            @else { <div class="history-list">@for (payment of data.payments; track field(payment, 'id')) { <article><strong>{{ field(payment, 'id') }}</strong><span>{{ field(payment, 'status') }}</span><span>{{ money(numberField(payment, 'amount_received') || numberField(payment, 'amount'), stringField(payment, 'currency')) }}</span><span>{{ date(stringField(payment, 'created_at')) }}</span></article> }</div> }
            <h3>Audit events</h3>
            <div class="history-list">@for (event of data.events; track field(event, 'id')) { <article><strong>{{ field(event, 'event_type') }}</strong><span>{{ field(event, 'old_status') || 'Unknown' }} to {{ field(event, 'new_status') || 'Unknown' }}</span><span>{{ date(stringField(event, 'created_at')) }}</span><span>{{ field(event, 'source') }}</span></article> }</div>
          }
        </section>
      }
    </main>
  `,
  styles: [`
    .console-page{max-width:1500px;margin:auto;padding:28px 0;color:var(--color-text)}
    .console-header{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;margin-bottom:1.5rem}.console-header h1{margin:.35rem 0}.console-header p{margin:0;color:var(--color-text-muted)}.back-link{font-size:.85rem}.header-links{display:flex;gap:.5rem;flex-wrap:wrap}.header-links a{text-decoration:none;display:inline-flex;align-items:center}
    .metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:.8rem;margin-bottom:1.5rem}.metrics article{padding:1rem;border:1px solid var(--color-border);border-radius:var(--radius-lg);background:var(--color-surface)}.metrics span{display:block;font-size:.75rem;color:var(--color-text-muted)}.metrics strong{display:block;margin-top:.35rem;font-size:1.5rem}.metric-warning strong{color:var(--color-error)}
    .filters{display:flex;flex-wrap:wrap;align-items:end;gap:.75rem;padding:1rem;margin-bottom:1rem;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg)}.filters label{display:grid;gap:.3rem;font-size:.75rem;color:var(--color-text-muted)}.search-field{flex:1;min-width:220px}.filters input,.filters select,.inline-controls input,.inline-controls select{min-height:40px;padding:0 .65rem;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg);color:var(--color-text);font:inherit}
    button,.primary,.secondary{min-height:40px;padding:0 .85rem;border-radius:var(--radius-md);border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);font:inherit;font-weight:600;cursor:pointer}.primary{background:var(--color-primary);color:#fff;border-color:var(--color-primary)}button:disabled{opacity:.5;cursor:not-allowed}.danger{color:var(--color-error)}
    .table-card{border:1px solid var(--color-border);border-radius:var(--radius-lg);background:var(--color-surface);overflow:hidden}.table-summary{padding:.8rem 1rem;color:var(--color-text-muted);font-size:.8rem}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;min-width:1180px}th,td{text-align:left;padding:.8rem;border-top:1px solid var(--color-border);vertical-align:top;font-size:.8rem}th{background:var(--color-bg);white-space:nowrap}td small,td code{display:block;margin-top:.3rem;color:var(--color-text-muted);word-break:break-all}.tenant-name{font-size:.9rem;font-weight:700}.row-overdue{background:color-mix(in srgb,var(--color-error) 5%,transparent)}
    .status{display:inline-block;padding:.2rem .55rem;border-radius:999px;background:var(--color-bg);font-weight:700;text-transform:capitalize}.status[data-status=active]{background:#e8f7ee;color:#18794e}.status[data-status=past_due],.status[data-status=canceled]{background:#fde8e8;color:#b42318}.status[data-status=trialing]{background:#e8f1ff;color:#175cd3}.status[data-status=suspended]{background:#fff4d8;color:#8a5a00}.warning-text,.danger-text{color:var(--color-error)!important}.inline-controls{display:flex;gap:.35rem}.extra-field{display:flex;align-items:center}.extra-field input{width:58px}.actions{display:flex;flex-wrap:wrap;gap:.35rem}.actions button{min-height:32px;padding:0 .5rem;font-size:.72rem}
    .pagination{display:flex;justify-content:center;align-items:center;gap:1rem;padding:1rem;border-top:1px solid var(--color-border)}.error{padding:.8rem;background:#fde8e8;color:#b42318;border-radius:var(--radius-md)}.loading,.muted{color:var(--color-text-muted)}
    .modal-backdrop{position:fixed;inset:0;background:#0009;z-index:100}.history-modal{position:fixed;z-index:101;inset:4vh 4vw;overflow:auto;padding:1.25rem;background:var(--color-surface);color:var(--color-text);border-radius:var(--radius-lg);box-shadow:var(--shadow-lg)}.history-modal header{display:flex;justify-content:space-between;gap:1rem}.history-modal h2{margin:0}.history-modal header p{margin:.3rem 0;color:var(--color-text-muted)}.history-list{display:grid;gap:.5rem}.history-list article{display:grid;grid-template-columns:minmax(150px,1.3fr) repeat(4,minmax(100px,1fr));gap:.75rem;padding:.75rem;border:1px solid var(--color-border);border-radius:var(--radius-md);font-size:.78rem;align-items:center}
    @media(max-width:700px){.console-page{padding-top:18px}.console-header{display:block}.console-header button{margin-top:1rem}.history-modal{inset:1rem}.history-list article{grid-template-columns:1fr}.metrics{grid-template-columns:1fr 1fr}}
  `],
})
export class PlatformSubscriptionsComponent implements OnInit {
  private api = inject(ApiService);
  metrics = signal<PlatformSubscriptionMetrics | null>(null);
  list = signal<PlatformSubscriptionList | null>(null);
  loading = signal(true); error = signal(''); history = signal<PlatformBillingHistory | null>(null);
  historyTenant = signal<PlatformSubscriptionRow | null>(null); historyLoading = signal(false);
  search=''; statusFilter=''; planFilter=''; healthFilter=''; page=1; pageSize=25;
  ngOnInit():void{this.load()}
  load():void{this.loading.set(true);this.error.set('');forkJoin({metrics:this.api.getPlatformSubscriptionMetrics(),list:this.api.getPlatformSubscriptions({search:this.search,status:this.statusFilter,plan:this.planFilter,health:this.healthFilter,page:this.page,pageSize:this.pageSize})}).subscribe({next:({metrics,list})=>{this.metrics.set(metrics);this.list.set(list);this.loading.set(false)},error:(err)=>{this.error.set(err?.error?.detail||'Could not load subscriptions');this.loading.set(false)}})}
  applyFilters():void{this.page=1;this.load()} clearFilters():void{this.search='';this.statusFilter='';this.planFilter='';this.healthFilter='';this.applyFilters()} goPage(page:number):void{this.page=page;this.load()}
  money(cents:number,currency='gbp'):string{return new Intl.NumberFormat('en-GB',{style:'currency',currency:(currency||'gbp').toUpperCase()}).format((cents||0)/100)}
  date(value?:string|null):string{return value?new Date(value).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'}):'Not available'}
  statusLabel(row:PlatformSubscriptionRow):string{return row.status.replaceAll('_',' ')}
  changePlan(row:PlatformSubscriptionRow,event:Event):void{const plan=(event.target as HTMLSelectElement).value;if(!confirm(`Synchronise ${row.tenant_name} to ${plan.toUpperCase()} with Stripe prorations?`)){(event.target as HTMLSelectElement).value=row.plan_code;return}this.api.updatePlatformTenantPlan(row.tenant_id,plan,row.extra_tables,'create_prorations').subscribe({next:()=>this.load(),error:(err)=>this.error.set(err?.error?.detail||'Plan update failed')})}
  changeExtraTables(row:PlatformSubscriptionRow,event:Event):void{const count=Math.max(0,Number((event.target as HTMLInputElement).value)||0);this.api.updatePlatformTenantPlan(row.tenant_id,row.plan_code,count,'create_prorations').subscribe({next:()=>this.load(),error:(err)=>this.error.set(err?.error?.detail||'Extra-table update failed')})}
  action(row:PlatformSubscriptionRow,action:string,immediate=false):void{if(action==='cancel'){const prompt=immediate?`Cancel ${row.tenant_name} immediately? Access and billing can end now.`:`Schedule cancellation for ${row.tenant_name} at period end?`;if(!confirm(prompt))return}else if(!confirm(`${action} subscription access for ${row.tenant_name}?`))return;this.api.runPlatformSubscriptionAction(row.tenant_id,action,immediate).subscribe({next:()=>this.load(),error:(err)=>this.error.set(err?.error?.detail||'Subscription action failed')})}
  showHistory(row:PlatformSubscriptionRow):void{this.historyTenant.set(row);this.history.set(null);this.historyLoading.set(true);this.api.getPlatformBillingHistory(row.tenant_id).subscribe({next:(data)=>{this.history.set(data);this.historyLoading.set(false)},error:(err)=>{this.error.set(err?.error?.detail||'Billing history failed');this.historyLoading.set(false)}})} closeHistory():void{this.historyTenant.set(null);this.history.set(null)}
  field(row:Record<string,unknown>,key:string):unknown{return row[key]} stringField(row:Record<string,unknown>,key:string):string{return String(row[key]||'')} numberField(row:Record<string,unknown>,key:string):number{return Number(row[key]||0)}
}
