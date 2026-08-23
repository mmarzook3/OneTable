import { Component, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ApiService, CustomerInfo, CustomerOrderSummary } from '../services/api.service';
import { ApiErrorMessageService } from '../services/api-error-message.service';

@Component({
  selector: 'app-customer-home',
  standalone: true,
  imports: [RouterLink, TranslateModule],
  template: `
    <div class="page" data-testid="customer-home">
      <header class="page-header">
        <div>
          <h1>{{ 'CUSTOMER_HOME.TITLE' | translate }}</h1>
          @if (me()) {
            <p class="muted">
              {{ 'CUSTOMER_HOME.SIGNED_IN_AS' | translate }}
              <strong>{{ me()!.email }}</strong>
              ·
              @if (me()!.email_verified) {
                <span class="ok">{{ 'CUSTOMER_HOME.EMAIL_VERIFIED' | translate }}</span>
              } @else {
                <span class="warn">{{ 'CUSTOMER_HOME.EMAIL_UNVERIFIED' | translate }}</span>
              }
            </p>
          }
        </div>
        <button type="button" class="btn-logout" (click)="logout()" data-testid="customer-logout">
          {{ 'CUSTOMER_HOME.LOGOUT' | translate }}
        </button>
      </header>

      @if (me() && !me()!.email_verified) {
        <div class="banner-warn" data-testid="customer-unverified-banner">
          <p>{{ 'CUSTOMER_AUTH.EMAIL_NOT_VERIFIED' | translate }}</p>
          <button type="button" class="btn-link" [disabled]="resendLoading()" (click)="resend()" data-testid="customer-resend-verification">
            {{ 'CUSTOMER_AUTH.RESEND_VERIFICATION' | translate }}
          </button>
          @if (resendMsg()) {
            <p class="muted">{{ resendMsg() }}</p>
          }
        </div>
      }

      <section class="orders">
        <h2>{{ 'CUSTOMER_HOME.ORDERS_TITLE' | translate }}</h2>
        <p class="muted">{{ 'CUSTOMER_HOME.ORDERS_HINT' | translate }}</p>
        @if (ordersError()) {
          <div class="error-banner">{{ ordersError() }}</div>
        } @else if (!orders().length) {
          <p data-testid="customer-orders-empty">{{ 'CUSTOMER_HOME.ORDERS_EMPTY' | translate }}</p>
        } @else {
          <table data-testid="customer-orders-table">
            <thead>
              <tr>
                <th>{{ 'CUSTOMER_HOME.COL_ID' | translate }}</th>
                <th>{{ 'CUSTOMER_HOME.COL_STATUS' | translate }}</th>
                <th>{{ 'CUSTOMER_HOME.COL_CHANNEL' | translate }}</th>
                <th>{{ 'CUSTOMER_HOME.COL_DATE' | translate }}</th>
              </tr>
            </thead>
            <tbody>
              @for (o of orders(); track o.id) {
                <tr>
                  <td>#{{ o.id }}</td>
                  <td>{{ o.status }}</td>
                  <td>{{ o.order_channel }}</td>
                  <td>{{ o.created_at || '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>

      <p class="foot">
        <a routerLink="/">One Table</a>
      </p>
    </div>
  `,
  styles: [`
    .page { max-width: 720px; margin: 0 auto; padding: var(--space-6) var(--space-5); }
    .page-header {
      display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-4);
      margin-bottom: var(--space-6);
    }
    h1 { font-size: 1.75rem; font-weight: 600; margin: 0 0 var(--space-2); }
    h2 { font-size: 1.25rem; font-weight: 600; margin: 0 0 var(--space-2); }
    .muted { color: var(--color-text-muted); font-size: 0.9375rem; }
    .ok { color: var(--color-success, #15803d); }
    .warn { color: var(--color-warning, #b45309); }
    .btn-logout {
      padding: var(--space-2) var(--space-4);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
      cursor: pointer;
    }
    .banner-warn {
      background: rgba(245, 158, 11, 0.12);
      border-radius: var(--radius-md);
      padding: var(--space-4);
      margin-bottom: var(--space-5);
    }
    .btn-link {
      background: none; border: none; color: var(--color-primary);
      font-weight: 500; cursor: pointer; padding: 0; margin-top: var(--space-2);
    }
    .btn-link:disabled { opacity: 0.6; }
    table { width: 100%; border-collapse: collapse; margin-top: var(--space-3); }
    th, td { text-align: left; padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-border); }
    .error-banner {
      background: rgba(220, 38, 38, 0.1);
      color: var(--color-error);
      padding: var(--space-3);
      border-radius: var(--radius-md);
    }
    .foot { margin-top: var(--space-8); text-align: center; }
    .foot a { color: var(--color-primary); }
  `],
})
export class CustomerHomeComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  private apiErr = inject(ApiErrorMessageService);
  private translate = inject(TranslateService);

  me = signal<CustomerInfo | null>(null);
  orders = signal<CustomerOrderSummary[]>([]);
  ordersError = signal('');
  resendLoading = signal(false);
  resendMsg = signal('');

  ngOnInit(): void {
    this.api.getCustomerMe().subscribe({
      next: (me) => {
        this.me.set(me);
        this.loadOrders();
      },
      error: () => void this.router.navigate(['/customer/login']),
    });
  }

  private loadOrders(): void {
    this.api.getCustomerOrders().subscribe({
      next: (res) => this.orders.set(res.orders || []),
      error: (err) =>
        this.ordersError.set(this.apiErr.fromHttpError(err, 'CUSTOMER_HOME.ORDERS_EMPTY')),
    });
  }

  resend(): void {
    const email = this.me()?.email;
    if (!email) return;
    this.resendLoading.set(true);
    this.resendMsg.set('');
    this.api.customerResendVerification(email).subscribe({
      next: () => {
        this.resendLoading.set(false);
        this.resendMsg.set(this.translate.instant('CUSTOMER_AUTH.RESEND_SENT'));
      },
      error: () => {
        this.resendLoading.set(false);
        this.resendMsg.set(this.translate.instant('CUSTOMER_AUTH.RESEND_SENT'));
      },
    });
  }

  logout(): void {
    this.api.customerLogout().subscribe({
      next: () => void this.router.navigate(['/customer/login']),
      error: () => void this.router.navigate(['/customer/login']),
    });
  }
}
