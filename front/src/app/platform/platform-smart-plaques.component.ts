import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ApiErrorMessageService } from '../services/api-error-message.service';
import { ApiService, SmartPlaque, SmartPlaqueRequest } from '../services/api.service';

@Component({
  selector: 'app-platform-smart-plaques',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  template: `
    <main class="plaque-page">
      <header class="page-header">
        <div>
          <p class="eyebrow">{{ 'SMART_PLAQUES.OPERATOR_EYEBROW' | translate }}</p>
          <h1>{{ 'SMART_PLAQUES.INVENTORY_TITLE' | translate }}</h1>
          <p class="lede">{{ 'SMART_PLAQUES.INVENTORY_HINT' | translate }}</p>
        </div>
      </header>

      <section class="request-card" data-testid="platform-plaque-requests">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Restaurant fulfilment</p>
            <h2>Plaque requests</h2>
            <p>Approve requests, reserve or generate unique IDs, record shipping and follow installation.</p>
          </div>
          <button type="button" class="btn btn-ghost" (click)="loadRequests()" [disabled]="requestsLoading()">Refresh</button>
        </div>

        @if (requestsLoading()) {
          <p class="muted">Loading restaurant requests…</p>
        } @else if (requests().length === 0) {
          <div class="empty-state compact"><h3>No requests waiting</h3><p>New restaurant plaque requests will appear here.</p></div>
        } @else {
          <div class="request-list">
            @for (request of requests(); track request.id) {
              <article class="request-row" [attr.data-request-id]="request.id" data-testid="platform-plaque-request-row">
                <header>
                  <div><span>Request #{{ request.id }}</span><strong>{{ request.tenant_name }}</strong><small>{{ request.quantity }} plaques · {{ request.requester_email || 'Restaurant owner' }}</small></div>
                  <span class="status" [attr.data-status]="request.status">{{ request.status }}</span>
                </header>
                <div class="request-details">
                  <div><span>Delivery</span><strong>{{ request.delivery_contact_name }}</strong><small>{{ request.delivery_address }}</small></div>
                  <div><span>Progress</span><strong>{{ request.allocated_count }}/{{ request.quantity }} allocated</strong><small>{{ request.installed_count }} installed</small></div>
                  <div><span>Restaurant note</span><small>{{ request.restaurant_notes || 'No note supplied.' }}</small></div>
                </div>
                @if (request.status === 'approved' || request.status === 'preparing') {
                  <label class="tracking-field">Tracking reference <input [(ngModel)]="trackingByRequest[request.id]" [name]="'tracking-' + request.id" placeholder="Courier and tracking number"></label>
                }
                @if (request.tracking_reference) { <p class="tracking-copy"><strong>Tracking:</strong> {{ request.tracking_reference }}</p> }
                <footer>
                  @if (request.allocated_count) {
                    <button type="button" class="btn btn-secondary" (click)="downloadRequestSheet(request)">Download this batch</button>
                  }
                  @if (request.status === 'requested') {
                    <button type="button" class="action-button danger" (click)="runRequestAction(request, 'decline')">Decline</button>
                    <button type="button" class="btn btn-primary" (click)="runRequestAction(request, 'approve')" [disabled]="updatingRequestId() === request.id" data-testid="platform-plaque-approve">Approve and allocate</button>
                  } @else if (request.status === 'approved') {
                    <button type="button" class="btn btn-secondary" (click)="runRequestAction(request, 'prepare')" [disabled]="updatingRequestId() === request.id">Mark preparing</button>
                    <button type="button" class="btn btn-primary" (click)="runRequestAction(request, 'ship')" [disabled]="updatingRequestId() === request.id">Mark shipped</button>
                  } @else if (request.status === 'preparing') {
                    <button type="button" class="btn btn-primary" (click)="runRequestAction(request, 'ship')" [disabled]="updatingRequestId() === request.id">Mark shipped</button>
                  } @else if (request.status === 'shipped') {
                    <button type="button" class="btn btn-secondary" (click)="runRequestAction(request, 'deliver')" [disabled]="updatingRequestId() === request.id">Mark delivered for restaurant</button>
                  } @else if (request.status === 'delivered') {
                    <button type="button" class="btn btn-primary" (click)="runRequestAction(request, 'complete')" [disabled]="request.installed_count !== request.quantity || updatingRequestId() === request.id">Complete installation</button>
                  }
                </footer>
              </article>
            }
          </div>
        }
      </section>

      <section class="create-card">
        <div>
          <h2>{{ 'SMART_PLAQUES.CREATE_BATCH' | translate }}</h2>
          <p>{{ 'SMART_PLAQUES.CREATE_BATCH_HINT' | translate }}</p>
        </div>
        <form (submit)="createBatch($event)" class="batch-form" data-testid="smart-plaque-batch-form">
          <label>
            <span>{{ 'SMART_PLAQUES.BATCH_LABEL' | translate }}</span>
            <input
              name="batchLabel"
              [(ngModel)]="batchLabel"
              maxlength="100"
              [placeholder]="'SMART_PLAQUES.BATCH_PLACEHOLDER' | translate"
              data-testid="smart-plaque-batch-label"
            />
          </label>
          <label>
            <span>{{ 'SMART_PLAQUES.QUANTITY' | translate }}</span>
            <input name="count" type="number" [(ngModel)]="count" min="1" max="100" required data-testid="smart-plaque-batch-count" />
          </label>
          <button class="btn btn-primary" type="submit" [disabled]="creating()" data-testid="smart-plaque-generate">
            {{ (creating() ? 'SMART_PLAQUES.CREATING' : 'SMART_PLAQUES.GENERATE') | translate }}
          </button>
          <button class="btn btn-secondary" type="button" (click)="downloadSheet()" [disabled]="plaques().length === 0">
            {{ 'SMART_PLAQUES.DOWNLOAD_SHEET' | translate }}
          </button>
        </form>
      </section>

      @if (error()) {
        <div class="error-banner" role="alert">{{ error() }}</div>
      }

      <section class="inventory-card">
        <div class="section-heading">
          <div>
            <h2>{{ 'SMART_PLAQUES.INVENTORY' | translate }}</h2>
            <p>{{ 'SMART_PLAQUES.INVENTORY_COUNT' | translate: { count: plaques().length } }}</p>
          </div>
          <button type="button" class="btn btn-ghost" (click)="loadPlaques()" [disabled]="loading()">
            {{ 'COMMON.REFRESH' | translate }}
          </button>
        </div>

        @if (loading()) {
          <p class="muted">{{ 'COMMON.LOADING' | translate }}</p>
        } @else if (plaques().length === 0) {
          <div class="empty-state">
            <h3>{{ 'SMART_PLAQUES.EMPTY_TITLE' | translate }}</h3>
            <p>{{ 'SMART_PLAQUES.EMPTY_HINT' | translate }}</p>
          </div>
        } @else {
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{{ 'SMART_PLAQUES.CODE' | translate }}</th>
                  <th>{{ 'SMART_PLAQUES.BATCH' | translate }}</th>
                  <th>{{ 'COMMON.STATUS' | translate }}</th>
                  <th>{{ 'SMART_PLAQUES.ASSIGNMENT' | translate }}</th>
                  <th>{{ 'SMART_PLAQUES.PERMANENT_URL' | translate }}</th>
                  <th>{{ 'COMMON.ACTIONS' | translate }}</th>
                </tr>
              </thead>
              <tbody>
                @for (plaque of plaques(); track plaque.id) {
                  <tr [attr.data-plaque-id]="plaque.id" data-testid="smart-plaque-row">
                    <td><code data-testid="smart-plaque-public-code">{{ plaque.public_code }}</code></td>
                    <td>{{ plaque.batch_label || 'Not provided' }}</td>
                    <td><span class="status" [attr.data-status]="plaque.status">{{ plaque.status }}</span></td>
                    <td>{{ plaque.table_name || ('SMART_PLAQUES.UNASSIGNED' | translate) }}</td>
                    <td>
                      <button type="button" class="copy-link" (click)="copyUrl(plaque)">
                        {{ copiedId() === plaque.id ? ('COMMON.COPIED' | translate) : ('COMMON.COPY_LINK' | translate) }}
                      </button>
                    </td>
                    <td class="row-actions">
                      @if (plaque.table_id) {
                        <button type="button" class="action-button" (click)="releasePlaque(plaque)">
                          {{ 'SMART_PLAQUES.RELEASE' | translate }}
                        </button>
                      } @else if (plaque.status === 'available') {
                        <button type="button" class="action-button danger" (click)="deletePlaque(plaque)">
                          {{ 'COMMON.DELETE' | translate }}
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    </main>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: var(--color-bg); }
    .plaque-page { max-width: 1180px; margin: 0 auto; padding: 28px 0; color: var(--color-text); }
    .page-header { margin-bottom: var(--space-6); }
    .back-link { color: var(--color-text-muted); text-decoration: none; font-size: .875rem; }
    .eyebrow { margin: var(--space-5) 0 var(--space-1); color: var(--color-primary); font-size: .75rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(1.75rem, 4vw, 2.5rem); letter-spacing: -.035em; }
    .lede { max-width: 700px; color: var(--color-text-muted); line-height: 1.6; }
    .create-card, .inventory-card, .request-card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); padding: var(--space-5); box-shadow: var(--shadow-sm); }
    .request-card { margin-bottom: var(--space-5); }
    .request-list { display: grid; gap: var(--space-3); }
    .request-row { padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg); }
    .request-row > header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
    .request-row > header > div { display: grid; gap: 3px; }
    .request-row > header span:first-child { color: var(--color-primary); font-size: .7rem; font-weight: 800; text-transform: uppercase; }
    .request-row > header small, .request-details small { color: var(--color-text-muted); line-height: 1.4; white-space: pre-line; }
    .request-details { display: grid; grid-template-columns: 1.2fr .7fr 1fr; gap: var(--space-3); margin: var(--space-3) 0; padding: var(--space-3); border-radius: var(--radius-md); background: var(--color-surface); }
    .request-details div { display: grid; align-content: start; gap: 3px; }
    .request-details span { color: var(--color-text-muted); font-size: .68rem; font-weight: 750; text-transform: uppercase; }
    .request-row footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-3); }
    .tracking-field { margin-top: var(--space-3); }
    .tracking-copy { margin: var(--space-2) 0 0; color: var(--color-text-muted); font-size: .8rem; }
    .empty-state.compact { padding: var(--space-5); }
    .create-card { display: grid; grid-template-columns: minmax(240px, .8fr) 1.2fr; gap: var(--space-6); margin-bottom: var(--space-5); }
    h2, h3 { margin: 0 0 var(--space-2); }
    .create-card p, .section-heading p { margin: 0; color: var(--color-text-muted); line-height: 1.5; }
    .batch-form { display: grid; grid-template-columns: 1.5fr .55fr; gap: var(--space-3); align-items: end; }
    label { display: grid; gap: var(--space-1); color: var(--color-text-muted); font-size: .8rem; font-weight: 600; }
    input { width: 100%; box-sizing: border-box; padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); color: var(--color-text); font: inherit; }
    .btn { border: 0; border-radius: var(--radius-md); padding: var(--space-3) var(--space-4); cursor: pointer; font-weight: 650; }
    .btn:disabled { opacity: .55; cursor: wait; }
    .btn-primary { background: var(--color-primary); color: #fff; }
    .btn-secondary { background: var(--color-bg); color: var(--color-text); border: 1px solid var(--color-border); }
    .btn-ghost { background: transparent; color: var(--color-primary); }
    .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 760px; }
    th, td { padding: var(--space-3); border-bottom: 1px solid var(--color-border); text-align: left; }
    th { color: var(--color-text-muted); font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; }
    code { font-size: .75rem; }
    .status { display: inline-flex; padding: 4px 9px; border-radius: 999px; background: var(--color-bg); font-size: .75rem; font-weight: 700; }
    .status[data-status='available'] { color: #166534; background: #dcfce7; }
    .status[data-status='assigned'] { color: #1e40af; background: #dbeafe; }
    .status[data-status='requested'] { color: #765400; background: #fff1cc; }
    .status[data-status='approved'], .status[data-status='preparing'] { color: #1e40af; background: #dbeafe; }
    .status[data-status='shipped'] { color: #5b3d91; background: #ebe4ff; }
    .status[data-status='delivered'], .status[data-status='completed'], .status[data-status='installed'] { color: #166534; background: #dcfce7; }
    .status[data-status='declined'], .status[data-status='cancelled'] { color: #8f2d1c; background: #fee9e5; }
    .copy-link { border: 0; background: transparent; color: var(--color-primary); cursor: pointer; font-weight: 600; }
    .row-actions { white-space: nowrap; }
    .action-button { border: 0; background: transparent; color: var(--color-primary); cursor: pointer; font-weight: 650; }
    .action-button.danger { color: var(--color-error); }
    .empty-state { text-align: center; padding: var(--space-8); border: 1px dashed var(--color-border); border-radius: var(--radius-md); }
    .muted { color: var(--color-text-muted); }
    .error-banner { margin-bottom: var(--space-4); padding: var(--space-3); color: var(--color-error); background: rgba(220,38,38,.08); border-radius: var(--radius-md); }
    @media (max-width: 760px) {
      .plaque-page { padding-top: 18px; }
      .create-card { grid-template-columns: 1fr; }
      .batch-form { grid-template-columns: 1fr; }
      .request-details { grid-template-columns: 1fr; }
      .request-row footer { align-items: stretch; flex-direction: column; }
    }
  `],
})
export class PlatformSmartPlaquesComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly apiErrors = inject(ApiErrorMessageService);
  private readonly translate = inject(TranslateService);

  plaques = signal<SmartPlaque[]>([]);
  requests = signal<SmartPlaqueRequest[]>([]);
  loading = signal(true);
  requestsLoading = signal(true);
  creating = signal(false);
  updatingRequestId = signal<number | null>(null);
  error = signal('');
  copiedId = signal<number | null>(null);
  batchLabel = '';
  count = 10;
  trackingByRequest: Record<number, string> = {};

  ngOnInit(): void {
    this.loadPlaques();
    this.loadRequests();
  }

  loadRequests(): void {
    this.requestsLoading.set(true);
    this.api.getPlatformSmartPlaqueRequests().subscribe({
      next: (rows) => {
        this.requests.set(rows);
        for (const row of rows) {
          if (row.tracking_reference && !this.trackingByRequest[row.id]) {
            this.trackingByRequest[row.id] = row.tracking_reference;
          }
        }
        this.requestsLoading.set(false);
      },
      error: (err) => {
        this.error.set(this.apiErrors.fromHttpError(err, 'COMMON.API_REQUEST_FAILED'));
        this.requestsLoading.set(false);
      },
    });
  }

  runRequestAction(request: SmartPlaqueRequest, action: string): void {
    if (action === 'decline' && !window.confirm(`Decline plaque request #${request.id}?`)) return;
    this.updatingRequestId.set(request.id);
    this.error.set('');
    this.api.runPlatformSmartPlaqueRequestAction(
      request.id,
      action,
      this.trackingByRequest[request.id],
    ).subscribe({
      next: (updated) => {
        this.requests.update((rows) => rows.map((row) => row.id === updated.id ? updated : row));
        this.updatingRequestId.set(null);
        this.loadPlaques();
      },
      error: (err) => {
        this.error.set(this.apiErrors.fromHttpError(err, 'COMMON.API_REQUEST_FAILED'));
        this.updatingRequestId.set(null);
      },
    });
  }

  downloadRequestSheet(request: SmartPlaqueRequest): void {
    this.api.downloadPlatformSmartPlaqueSheet(undefined, request.id).subscribe({
      next: (blob) => {
        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = `scanaki-plaque-request-${request.id}.pdf`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
      },
      error: (err) => this.error.set(this.apiErrors.fromHttpError(err, 'COMMON.API_REQUEST_FAILED')),
    });
  }

  loadPlaques(): void {
    this.loading.set(true);
    this.error.set('');
    this.api.getPlatformSmartPlaques().subscribe({
      next: (rows) => {
        this.plaques.set(rows);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(this.apiErrors.fromHttpError(err, 'COMMON.API_REQUEST_FAILED'));
        this.loading.set(false);
      },
    });
  }

  createBatch(event: Event): void {
    event.preventDefault();
    if (this.count < 1 || this.count > 100) return;
    this.creating.set(true);
    this.error.set('');
    this.api.createPlatformSmartPlaques(this.count, this.batchLabel).subscribe({
      next: (created) => {
        this.plaques.update((rows) => [...created, ...rows]);
        this.creating.set(false);
      },
      error: (err) => {
        this.error.set(this.apiErrors.fromHttpError(err, 'COMMON.API_REQUEST_FAILED'));
        this.creating.set(false);
      },
    });
  }

  downloadSheet(): void {
    this.api.downloadPlatformSmartPlaqueSheet(this.batchLabel).subscribe({
      next: (blob) => {
        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = 'scanaki-smart-plaques.pdf';
        link.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
      },
      error: (err) => this.error.set(this.apiErrors.fromHttpError(err, 'COMMON.API_REQUEST_FAILED')),
    });
  }

  copyUrl(plaque: SmartPlaque): void {
    navigator.clipboard.writeText(plaque.public_url).then(() => {
      this.copiedId.set(plaque.id);
      setTimeout(() => this.copiedId.set(null), 1800);
    });
  }

  releasePlaque(plaque: SmartPlaque): void {
    if (!window.confirm(this.translate.instant('SMART_PLAQUES.RELEASE_CONFIRM'))) return;
    this.api.releasePlatformSmartPlaque(plaque.id).subscribe({
      next: (updated) => this.plaques.update((rows) => rows.map((row) => row.id === updated.id ? updated : row)),
      error: (err) => this.error.set(this.apiErrors.fromHttpError(err, 'COMMON.API_REQUEST_FAILED')),
    });
  }

  deletePlaque(plaque: SmartPlaque): void {
    if (!window.confirm(this.translate.instant('SMART_PLAQUES.DELETE_CONFIRM'))) return;
    this.api.deletePlatformSmartPlaque(plaque.id).subscribe({
      next: () => this.plaques.update((rows) => rows.filter((row) => row.id !== plaque.id)),
      error: (err) => this.error.set(this.apiErrors.fromHttpError(err, 'COMMON.API_REQUEST_FAILED')),
    });
  }
}
