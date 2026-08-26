import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { ApiService, SmartPlaqueRequest } from '../services/api.service';
import { ApiErrorMessageService } from '../services/api-error-message.service';
import { SidebarComponent } from '../shared/sidebar.component';

@Component({
  selector: 'app-smart-plaque-requests',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, SidebarComponent],
  template: `
    <app-sidebar>
      <main class="page-shell">
        <header class="hero">
          <div>
            <p class="eyebrow">QR + NFC supplies</p>
            <h1>Smart plaque requests</h1>
            <p class="hero-copy">
              Request permanent Scanaki plaques, follow delivery, then scan each plaque to assign it to a room or table.
            </p>
          </div>
          <a routerLink="/locations" class="secondary-link">Manage rooms and tables</a>
        </header>

        <section class="how-it-works" aria-label="Plaque request steps">
          @for (step of steps; track step.number) {
            <div>
              <span>{{ step.number }}</span>
              <strong>{{ step.title }}</strong>
              <small>{{ step.detail }}</small>
            </div>
          }
        </section>

        @if (error()) {
          <div class="alert" role="alert">{{ error() }}</div>
        }

        <div class="content-grid">
          <section class="card request-card">
            <div class="section-heading">
              <div>
                <p class="eyebrow">New supply request</p>
                <h2>Order reusable plaques</h2>
              </div>
              @if (activeRequest(); as active) {
                <span class="status" [attr.data-status]="active.status">{{ statusLabel(active.status) }}</span>
              }
            </div>

            @if (activeRequest(); as active) {
              <div class="active-notice">
                <strong>Request #{{ active.id }} is already in progress</strong>
                <p>Track it on this page. You can submit another request after this delivery is completed or declined.</p>
              </div>
            } @else {
              <form (submit)="submitRequest($event)" data-testid="plaque-request-form">
                <div class="form-grid">
                  <label>
                    <span>Quantity</span>
                    <input type="number" min="1" max="100" [(ngModel)]="form.quantity" name="quantity" required data-testid="plaque-request-quantity">
                    <small>One plaque is normally required for each room or table.</small>
                  </label>
                  <label>
                    <span>Delivery contact</span>
                    <input [(ngModel)]="form.delivery_contact_name" name="deliveryContact" maxlength="160" required placeholder="Full name" data-testid="plaque-request-contact">
                  </label>
                  <label class="wide">
                    <span>Delivery address</span>
                    <textarea [(ngModel)]="form.delivery_address" name="deliveryAddress" maxlength="500" required placeholder="Building, street, town/city and postcode" data-testid="plaque-request-address"></textarea>
                  </label>
                  <label class="wide">
                    <span>Notes for Scanaki <em>optional</em></span>
                    <textarea [(ngModel)]="form.restaurant_notes" name="restaurantNotes" maxlength="500" placeholder="For example: hotel room plaques, lounge tables or preferred delivery timing"></textarea>
                  </label>
                </div>
                <div class="request-summary">
                  <span>{{ form.quantity || 0 }} permanent QR/NFC {{ form.quantity === 1 ? 'plaque' : 'plaques' }}</span>
                  <button class="primary-button" type="submit" [disabled]="submitting()" data-testid="plaque-request-submit">
                    {{ submitting() ? 'Sending request…' : 'Request plaques' }}
                  </button>
                </div>
              </form>
            }
          </section>

          <aside class="card safety-card">
            <p class="eyebrow">Why plaques are reusable</p>
            <h2>One permanent address</h2>
            <p>The QR and embedded NFC tag always use a secure Scanaki plaque address. The room or table assignment stays inside Scanaki.</p>
            <ul>
              <li>Move a plaque without reprinting the QR.</li>
              <li>Locked NFC tags never need rewriting.</li>
              <li>Old baskets are invalidated after reassignment.</li>
              <li>Cross-restaurant transfers require Scanaki approval.</li>
            </ul>
          </aside>
        </div>

        <section class="card history-card">
          <div class="section-heading">
            <div>
              <p class="eyebrow">Request history</p>
              <h2>Delivery and installation progress</h2>
            </div>
            <button type="button" class="text-button" (click)="loadRequests()" [disabled]="loading()">Refresh</button>
          </div>

          @if (loading()) {
            <div class="loading-state">Loading plaque requests…</div>
          } @else if (requests().length === 0) {
            <div class="empty-state">
              <strong>No plaque requests yet</strong>
              <p>Your first request will appear here with approval, shipping and installation progress.</p>
            </div>
          } @else {
            <div class="request-list">
              @for (request of requests(); track request.id) {
                <article class="request-row" [attr.data-request-id]="request.id" data-testid="plaque-request-row">
                  <header>
                    <div>
                      <span class="request-number">Request #{{ request.id }}</span>
                      <strong>{{ request.quantity }} {{ request.quantity === 1 ? 'plaque' : 'plaques' }}</strong>
                      <small>Requested {{ formatDate(request.requested_at) }}</small>
                    </div>
                    <span class="status" [attr.data-status]="request.status">{{ statusLabel(request.status) }}</span>
                  </header>

                  <div class="progress" aria-label="Request progress">
                    @for (stage of requestStages; track stage.key) {
                      <div [class.reached]="stageReached(request, stage.key)">
                        <span></span><small>{{ stage.label }}</small>
                      </div>
                    }
                  </div>

                  <div class="request-meta">
                    <div><span>Deliver to</span><strong>{{ request.delivery_contact_name }}</strong><small>{{ request.delivery_address }}</small></div>
                    <div><span>Allocated</span><strong>{{ request.allocated_count }}/{{ request.quantity }}</strong><small>{{ request.installed_count }} installed</small></div>
                    <div><span>Tracking</span><strong>{{ request.tracking_reference || 'Not available yet' }}</strong><small>{{ request.platform_notes || 'Updates from Scanaki appear here.' }}</small></div>
                  </div>

                  @if (request.plaques.length) {
                    <details class="plaque-list">
                      <summary>{{ request.plaques.length }} allocated plaque {{ request.plaques.length === 1 ? 'ID' : 'IDs' }}</summary>
                      @for (plaque of request.plaques; track plaque.id) {
                        <div><code>{{ plaque.public_code }}</code><span>{{ statusLabel(plaque.status) }}</span></div>
                      }
                    </details>
                  }

                  <footer>
                    @if (request.status === 'requested') {
                      <button type="button" class="danger-button" (click)="cancelRequest(request)" [disabled]="updatingId() === request.id">Cancel request</button>
                    }
                    @if (request.status === 'shipped') {
                      <button type="button" class="primary-button" (click)="confirmDelivery(request)" [disabled]="updatingId() === request.id" data-testid="plaque-confirm-delivery">Confirm plaques received</button>
                    }
                    @if (request.status === 'delivered' || request.status === 'completed') {
                      <a routerLink="/tables" class="primary-link">Assign plaques to rooms/tables</a>
                    }
                  </footer>
                </article>
              }
            </div>
          }
        </section>
      </main>
    </app-sidebar>
  `,
  styles: [`
    :host{display:block}.page-shell{max-width:1320px;margin:0 auto;padding:32px;color:#20292f}.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:24px}.eyebrow{margin:0 0 6px;color:#c95032;font-size:.72rem;font-weight:850;letter-spacing:.12em;text-transform:uppercase}.hero h1{margin:0;font-size:clamp(2rem,4vw,3.15rem);letter-spacing:-.045em}.hero-copy{max-width:720px;margin:9px 0 0;color:#68737b;line-height:1.6}.secondary-link,.primary-link{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 16px;border:1px solid #cfd6da;border-radius:9px;background:#fff;color:#29333a;font-weight:750;text-decoration:none}.primary-link{border-color:#c95032;background:#c95032;color:#fff}.how-it-works{display:grid;grid-template-columns:repeat(4,1fr);margin-bottom:22px;overflow:hidden;border:1px solid #dce2e5;border-radius:13px;background:#dce2e5;gap:1px}.how-it-works div{display:grid;grid-template-columns:32px 1fr;column-gap:10px;padding:16px;background:#fff}.how-it-works span{grid-row:1/3;display:grid;width:28px;height:28px;place-items:center;border-radius:50%;background:#26343d;color:#fff;font-size:.74rem;font-weight:850}.how-it-works strong{font-size:.9rem}.how-it-works small{margin-top:3px;color:#748089;line-height:1.4}.alert{margin-bottom:18px;padding:13px 15px;border-radius:10px;background:#fee9e5;color:#8f2d1c}.content-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(280px,.75fr);gap:18px;margin-bottom:18px}.card{border:1px solid #dce2e5;border-radius:13px;background:#fff;box-shadow:0 4px 18px rgba(26,34,40,.04)}.request-card,.safety-card,.history-card{padding:22px}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}.section-heading h2,.safety-card h2{margin:0;font-size:1.25rem}.form-grid{display:grid;grid-template-columns:150px 1fr;gap:14px}.form-grid label{display:grid;gap:6px;color:#3c474f;font-size:.82rem;font-weight:750}.form-grid label.wide{grid-column:1/-1}.form-grid em{color:#7d878e;font-weight:450}.form-grid input,.form-grid textarea{box-sizing:border-box;width:100%;min-height:44px;padding:10px 12px;border:1px solid #cbd3d8;border-radius:9px;background:#fff;color:#1f292f;font:inherit}.form-grid textarea{min-height:82px;resize:vertical}.form-grid small{color:#78838a;font-weight:450;line-height:1.35}.request-summary{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:16px;padding-top:16px;border-top:1px solid #edf0f2;font-weight:750}.primary-button,.danger-button,.text-button{min-height:42px;padding:0 16px;border:0;border-radius:9px;background:#c95032;color:#fff;font:inherit;font-weight:800;cursor:pointer}.danger-button{border:1px solid #e3b9b1;background:#fff;color:#9b3825}.text-button{min-height:auto;padding:8px;background:transparent;color:#b44329}.primary-button:disabled,.danger-button:disabled,.text-button:disabled{cursor:wait;opacity:.55}.active-notice{padding:18px;border-left:4px solid #d79820;border-radius:5px 10px 10px 5px;background:#fff7df}.active-notice p{margin:6px 0 0;color:#6c6552;line-height:1.5}.safety-card{background:#26343d;color:#fff}.safety-card .eyebrow{color:#ff9a79}.safety-card p{color:#d4dce0;line-height:1.6}.safety-card ul{display:grid;gap:10px;margin:18px 0 0;padding-left:19px;color:#edf2f4;line-height:1.45}.history-card{padding-bottom:8px}.loading-state,.empty-state{padding:38px;text-align:center;color:#6f7a82}.empty-state strong{color:#26323a}.empty-state p{margin:6px 0 0}.request-list{display:grid}.request-row{padding:20px 0;border-top:1px solid #e7ebed}.request-row>header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.request-row>header>div{display:grid;gap:3px}.request-number{color:#a54831;font-size:.75rem;font-weight:850;text-transform:uppercase}.request-row header small{color:#7a858c}.status{display:inline-flex;padding:6px 10px;border-radius:999px;background:#edf0f2;color:#59656d;font-size:.74rem;font-weight:850;text-transform:capitalize}.status[data-status=requested]{background:#fff0c9;color:#725300}.status[data-status=approved],.status[data-status=preparing]{background:#e2edff;color:#28528b}.status[data-status=shipped]{background:#e8e2ff;color:#533b91}.status[data-status=delivered],.status[data-status=completed],.status[data-status=installed]{background:#dff3e6;color:#256342}.status[data-status=declined],.status[data-status=cancelled]{background:#f4e4e1;color:#8c3b2e}.progress{display:grid;grid-template-columns:repeat(5,1fr);gap:3px;margin:18px 0}.progress div{display:grid;gap:6px;color:#939ca2;font-size:.7rem}.progress div span{height:5px;border-radius:5px;background:#e3e7e9}.progress div.reached{color:#2f6849}.progress div.reached span{background:#4f9a70}.request-meta{display:grid;grid-template-columns:1.1fr .5fr 1fr;gap:14px;padding:14px;border-radius:10px;background:#f6f7f8}.request-meta div{display:grid;align-content:start;gap:4px}.request-meta span{color:#79848b;font-size:.68rem;font-weight:800;text-transform:uppercase}.request-meta small{color:#6f7a82;line-height:1.35;white-space:pre-line}.plaque-list{margin-top:12px;border:1px solid #e0e5e8;border-radius:9px}.plaque-list summary{padding:11px 13px;font-weight:750;cursor:pointer}.plaque-list div{display:flex;justify-content:space-between;gap:12px;padding:9px 13px;border-top:1px solid #edf0f2}.plaque-list code{font-size:.76rem}.plaque-list span{color:#66727a;font-size:.76rem;text-transform:capitalize}.request-row footer{display:flex;justify-content:flex-end;gap:10px;margin-top:14px}@media(max-width:900px){.page-shell{padding:24px 16px}.hero{align-items:flex-start;flex-direction:column}.content-grid{grid-template-columns:1fr}.how-it-works{grid-template-columns:1fr 1fr}.request-meta{grid-template-columns:1fr 1fr}.request-meta div:last-child{grid-column:1/-1}}@media(max-width:600px){.page-shell{padding:18px 10px}.how-it-works,.form-grid,.request-meta{grid-template-columns:1fr}.form-grid label.wide,.request-meta div:last-child{grid-column:auto}.request-summary,.section-heading{align-items:stretch;flex-direction:column}.progress small{display:none}.request-row footer{align-items:stretch;flex-direction:column}.primary-link{width:auto}}
  `],
})
export class SmartPlaqueRequestsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly apiErrors = inject(ApiErrorMessageService);

  readonly steps = [
    { number: 1, title: 'Request', detail: 'Choose quantity and delivery address.' },
    { number: 2, title: 'Scanaki prepares', detail: 'Unique IDs are reserved or generated.' },
    { number: 3, title: 'Receive', detail: 'Confirm the delivered plaque batch.' },
    { number: 4, title: 'Assign', detail: 'Scan each plaque at its room or table.' },
  ];
  readonly requestStages = [
    { key: 'requested', label: 'Requested' },
    { key: 'approved', label: 'Approved' },
    { key: 'shipped', label: 'Shipped' },
    { key: 'delivered', label: 'Received' },
    { key: 'completed', label: 'Installed' },
  ];

  requests = signal<SmartPlaqueRequest[]>([]);
  loading = signal(true);
  submitting = signal(false);
  updatingId = signal<number | null>(null);
  error = signal('');
  activeRequest = computed(() =>
    this.requests().find((row) => ['requested', 'approved', 'preparing', 'shipped'].includes(row.status)) || null,
  );
  form = { quantity: 1, delivery_contact_name: '', delivery_address: '', restaurant_notes: '' };

  ngOnInit(): void { this.loadRequests(); }

  loadRequests(): void {
    this.loading.set(true); this.error.set('');
    this.api.getSmartPlaqueRequests().subscribe({
      next: (rows) => { this.requests.set(rows); this.loading.set(false); },
      error: (err) => { this.error.set(this.apiErrors.fromHttpError(err, 'COMMON.API_REQUEST_FAILED')); this.loading.set(false); },
    });
  }

  submitRequest(event: Event): void {
    event.preventDefault();
    if (!this.form.delivery_contact_name.trim() || !this.form.delivery_address.trim() || this.form.quantity < 1) return;
    this.submitting.set(true); this.error.set('');
    this.api.createSmartPlaqueRequest({
      quantity: this.form.quantity,
      delivery_contact_name: this.form.delivery_contact_name.trim(),
      delivery_address: this.form.delivery_address.trim(),
      restaurant_notes: this.form.restaurant_notes.trim() || null,
    }).subscribe({
      next: (row) => { this.requests.update((rows) => [row, ...rows]); this.submitting.set(false); this.form = { quantity: 1, delivery_contact_name: '', delivery_address: '', restaurant_notes: '' }; },
      error: (err) => { this.error.set(this.apiError(err)); this.submitting.set(false); },
    });
  }

  cancelRequest(request: SmartPlaqueRequest): void {
    if (!window.confirm(`Cancel plaque request #${request.id}?`)) return;
    this.updatingId.set(request.id);
    this.api.cancelSmartPlaqueRequest(request.id).subscribe({ next: (row) => this.replace(row), error: (err) => { this.error.set(this.apiError(err)); this.updatingId.set(null); } });
  }

  confirmDelivery(request: SmartPlaqueRequest): void {
    if (!window.confirm(`Confirm that all ${request.quantity} plaques were received?`)) return;
    this.updatingId.set(request.id);
    this.api.confirmSmartPlaqueDelivery(request.id).subscribe({ next: (row) => this.replace(row), error: (err) => { this.error.set(this.apiError(err)); this.updatingId.set(null); } });
  }

  private replace(row: SmartPlaqueRequest): void {
    this.requests.update((rows) => rows.map((item) => item.id === row.id ? row : item));
    this.updatingId.set(null);
  }

  statusLabel(status: string): string { return status.replaceAll('_', ' '); }
  formatDate(value: string): string { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
  stageReached(request: SmartPlaqueRequest, stage: string): boolean {
    const order = ['requested', 'approved', 'preparing', 'shipped', 'delivered', 'completed'];
    const current = request.status === 'preparing' ? 'approved' : request.status;
    return !['declined', 'cancelled'].includes(request.status) && order.indexOf(current) >= order.indexOf(stage);
  }
  private apiError(err: any): string {
    const detail = err?.error?.detail;
    return typeof detail === 'string' ? detail : detail?.message || this.apiErrors.fromHttpError(err, 'COMMON.API_REQUEST_FAILED');
  }
}
