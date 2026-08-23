import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ApiErrorMessageService } from '../services/api-error-message.service';
import { ApiService, SmartPlaque } from '../services/api.service';

@Component({
  selector: 'app-platform-smart-plaques',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TranslateModule],
  template: `
    <main class="plaque-page">
      <header class="page-header">
        <div>
          <a routerLink="/platform" class="back-link">← {{ 'SMART_PLAQUES.BACK' | translate }}</a>
          <p class="eyebrow">{{ 'SMART_PLAQUES.OPERATOR_EYEBROW' | translate }}</p>
          <h1>{{ 'SMART_PLAQUES.INVENTORY_TITLE' | translate }}</h1>
          <p class="lede">{{ 'SMART_PLAQUES.INVENTORY_HINT' | translate }}</p>
        </div>
      </header>

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
                    <td>{{ plaque.batch_label || '—' }}</td>
                    <td><span class="status" [attr.data-status]="plaque.status">{{ plaque.status }}</span></td>
                    <td>{{ plaque.table_name || ('SMART_PLAQUES.UNASSIGNED' | translate) }}</td>
                    <td>
                      <button type="button" class="copy-link" (click)="copyUrl(plaque)">
                        {{ copiedId() === plaque.id ? ('COMMON.COPIED' | translate) : ('COMMON.COPY_LINK' | translate) }}
                      </button>
                    </td>
                    <td class="row-actions">
                      @if (plaque.status === 'assigned') {
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
    .plaque-page { max-width: 1180px; margin: 0 auto; padding: var(--space-6); color: var(--color-text); }
    .page-header { margin-bottom: var(--space-6); }
    .back-link { color: var(--color-text-muted); text-decoration: none; font-size: .875rem; }
    .eyebrow { margin: var(--space-5) 0 var(--space-1); color: var(--color-primary); font-size: .75rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(1.75rem, 4vw, 2.5rem); letter-spacing: -.035em; }
    .lede { max-width: 700px; color: var(--color-text-muted); line-height: 1.6; }
    .create-card, .inventory-card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); padding: var(--space-5); box-shadow: var(--shadow-sm); }
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
    .copy-link { border: 0; background: transparent; color: var(--color-primary); cursor: pointer; font-weight: 600; }
    .row-actions { white-space: nowrap; }
    .action-button { border: 0; background: transparent; color: var(--color-primary); cursor: pointer; font-weight: 650; }
    .action-button.danger { color: var(--color-error); }
    .empty-state { text-align: center; padding: var(--space-8); border: 1px dashed var(--color-border); border-radius: var(--radius-md); }
    .muted { color: var(--color-text-muted); }
    .error-banner { margin-bottom: var(--space-4); padding: var(--space-3); color: var(--color-error); background: rgba(220,38,38,.08); border-radius: var(--radius-md); }
    @media (max-width: 760px) {
      .plaque-page { padding: var(--space-4); }
      .create-card { grid-template-columns: 1fr; }
      .batch-form { grid-template-columns: 1fr; }
    }
  `],
})
export class PlatformSmartPlaquesComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly apiErrors = inject(ApiErrorMessageService);
  private readonly translate = inject(TranslateService);

  plaques = signal<SmartPlaque[]>([]);
  loading = signal(true);
  creating = signal(false);
  error = signal('');
  copiedId = signal<number | null>(null);
  batchLabel = '';
  count = 10;

  ngOnInit(): void {
    this.loadPlaques();
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
