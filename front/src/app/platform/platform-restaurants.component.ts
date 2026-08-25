import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, PlatformTenantSummary } from '../services/api.service';

@Component({
  selector: 'app-platform-restaurants',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="restaurants-page">
      <header class="page-heading">
        <div><h1>Restaurants</h1><p>Manage customer accounts, onboarding progress and public venue links.</p></div>
        <a routerLink="/platform/restaurants/new" class="primary-action">Create restaurant</a>
      </header>

      <section class="summary-strip" aria-label="Restaurant summary">
        <div><span>Total restaurants</span><strong>{{ restaurants().length }}</strong></div>
        <div><span>Onboarding complete</span><strong>{{ completedCount() }}</strong></div>
        <div><span>Needs attention</span><strong>{{ attentionCount() }}</strong></div>
      </section>

      <section class="directory">
        <div class="directory-toolbar">
          <label class="search-field">Search restaurants
            <input [ngModel]="search()" (ngModelChange)="search.set($event)" placeholder="Name, owner or email" data-testid="platform-restaurant-search">
          </label>
          <label>Onboarding
            <select [ngModel]="onboardingFilter()" (ngModelChange)="onboardingFilter.set($event)">
              <option value="">All statuses</option>
              <option value="completed">Completed</option>
              <option value="in_progress">In progress</option>
              <option value="not_started">Not started</option>
            </select>
          </label>
          <button type="button" (click)="load()" [disabled]="loading()">Refresh</button>
        </div>

        @if (error()) { <p class="error-banner" role="alert">{{ error() }}</p> }
        @if (loading()) {
          <div class="loading-rows" aria-label="Loading restaurants">
            @for (row of [1,2,3,4]; track row) { <span></span> }
          </div>
        } @else if (filtered().length === 0) {
          <div class="empty-state"><h2>No restaurants found</h2><p>Clear the filters or create a new customer account.</p></div>
        } @else {
          <div class="table-scroll">
            <table>
              <thead><tr><th>Restaurant</th><th>Owner</th><th>Plan</th><th>Usage</th><th>Onboarding</th><th>Created</th><th>Actions</th></tr></thead>
              <tbody>
                @for (tenant of filtered(); track tenant.id) {
                  <tr>
                    <td><a [routerLink]="['/platform/tenants',tenant.id]" class="restaurant-name">{{ tenant.name }}</a><small>Customer ID {{ tenant.id }}</small></td>
                    <td>@if(tenant.owner_email){<a [href]="'mailto:'+tenant.owner_email">{{ tenant.owner_name || tenant.owner_email }}</a><small>{{ tenant.owner_name ? tenant.owner_email : '' }}</small>}@else{<span class="muted">Not provided</span>}</td>
                    <td><strong class="plan-name">{{ tenant.saas_plan_code }}</strong><small>{{ tenant.table_limit }} table allowance</small></td>
                    <td><strong>{{ tenant.table_count }}</strong> tables<small>{{ tenant.product_count }} products, {{ tenant.user_count }} users</small></td>
                    <td><span class="status" [attr.data-status]="tenant.onboarding_status">{{ label(tenant.onboarding_status) }}</span></td>
                    <td>{{ date(tenant.created_at) }}</td>
                    <td><div class="row-actions"><a [routerLink]="['/platform/tenants',tenant.id]">Open</a><a [href]="publicMenu(tenant.id)" target="_blank" rel="noopener noreferrer">Menu</a></div></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    </div>
  `,
  styles: [`
    .restaurants-page{max-width:1480px;margin:auto;padding:28px 0;color:var(--color-text)}.page-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:22px}.page-heading h1{margin:0;font-size:25px;letter-spacing:-.025em}.page-heading p{margin:5px 0 0;color:var(--color-text-muted);font-size:13px}.primary-action{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 14px;border-radius:8px;background:var(--color-primary);color:#fff;font-size:12px;font-weight:750;text-decoration:none;white-space:nowrap}.primary-action:hover{text-decoration:none}
    .summary-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:18px;border:1px solid var(--color-border);border-radius:12px;background:#fff}.summary-strip div{display:grid;gap:5px;padding:16px 18px;border-right:1px solid var(--color-border)}.summary-strip div:last-child{border-right:0}.summary-strip span{color:var(--color-text-muted);font-size:11px}.summary-strip strong{font-size:22px;font-variant-numeric:tabular-nums}
    .directory{overflow:hidden;border:1px solid var(--color-border);border-radius:12px;background:#fff}.directory-toolbar{display:flex;align-items:flex-end;gap:10px;padding:14px;border-bottom:1px solid var(--color-border)}label{display:grid;gap:4px;color:var(--color-text-muted);font-size:10px;font-weight:700}.search-field{flex:1;min-width:220px}input,select{min-height:38px;padding:0 10px;border:1px solid var(--color-border);border-radius:8px;background:#fff;color:var(--color-text);font:inherit;font-size:12px}input:focus,select:focus{border-color:var(--color-primary);outline:2px solid color-mix(in srgb,var(--color-primary) 18%,transparent)}.directory-toolbar button{min-height:38px;padding:0 12px;border:1px solid var(--color-border);border-radius:8px;background:#fff;color:var(--color-text);font-weight:700}
    .table-scroll{overflow:auto}table{width:100%;min-width:1050px;border-collapse:collapse}th,td{padding:12px 14px;border-bottom:1px solid #eceef1;text-align:left;vertical-align:middle;font-size:12px}th{background:#fafbfc;color:#747b86;font-size:9px;letter-spacing:.055em;text-transform:uppercase}tbody tr:hover{background:#fafbfc}tbody tr:last-child td{border-bottom:0}td small{display:block;margin-top:3px;color:var(--color-text-muted);font-size:10px}.restaurant-name{color:var(--color-text);font-weight:750}.plan-name{text-transform:capitalize}.muted{color:var(--color-text-muted)}.status{display:inline-flex;padding:4px 7px;border-radius:6px;background:#eef0f3;color:#555b65;font-size:10px;font-weight:700}.status[data-status=completed]{background:#e7f5ec;color:#24724a}.status[data-status=in_progress]{background:#fff3d9;color:#895d06}.row-actions{display:flex;gap:10px}.row-actions a{font-size:11px;font-weight:700}.error-banner{margin:12px;padding:10px;border-radius:8px;background:#feeceb;color:#a9382e}.empty-state{padding:60px 20px;text-align:center}.empty-state h2{font-size:17px}.empty-state p{margin-top:5px;color:var(--color-text-muted);font-size:12px}.loading-rows{display:grid;gap:1px;background:#eceef1}.loading-rows span{height:54px;background:linear-gradient(90deg,#fafbfc,#f3f5f7,#fafbfc);background-size:200% 100%;animation:shimmer 1.3s linear infinite}@keyframes shimmer{to{background-position:-200% 0}}
    @media(max-width:720px){.restaurants-page{padding-top:18px}.page-heading{display:block}.primary-action{margin-top:14px}.summary-strip{grid-template-columns:1fr}.summary-strip div{border-right:0;border-bottom:1px solid var(--color-border)}.summary-strip div:last-child{border-bottom:0}.directory-toolbar{align-items:stretch;flex-direction:column}.search-field{min-width:0}}
    @media(prefers-reduced-motion:reduce){.loading-rows span{animation:none}}
  `],
})
export class PlatformRestaurantsComponent implements OnInit {
  private api = inject(ApiService);
  restaurants = signal<PlatformTenantSummary[]>([]);
  loading = signal(true); error = signal(''); search = signal(''); onboardingFilter = signal('');
  completedCount = computed(() => this.restaurants().filter((row) => row.onboarding_status === 'completed').length);
  attentionCount = computed(() => this.restaurants().length - this.completedCount());
  filtered = computed(() => {
    const query = this.search().trim().toLowerCase();
    return this.restaurants().filter((row) => {
      const matchesStatus = !this.onboardingFilter() || row.onboarding_status === this.onboardingFilter();
      const haystack = `${row.name} ${row.owner_name || ''} ${row.owner_email || ''} ${row.tenant_email || ''}`.toLowerCase();
      return matchesStatus && (!query || haystack.includes(query));
    });
  });
  ngOnInit():void{this.load()}
  load():void{this.loading.set(true);this.error.set('');this.api.getPlatformTenants().subscribe({next:(rows)=>{this.restaurants.set(rows);this.loading.set(false)},error:()=>{this.error.set('Could not load restaurants.');this.loading.set(false)}})}
  label(value:string):string{return value.replaceAll('_',' ')}
  date(value:string):string{return new Date(value).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}
  publicMenu(id:number):string{return `${window.location.origin}/public-menu/${id}`}
}
