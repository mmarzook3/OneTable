import {
  Component,
  inject,
  signal,
  computed,
  OnInit,
  OnDestroy,
  AfterViewInit,
  ChangeDetectionStrategy,
  ViewChild,
  ElementRef,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import {
  ApiService,
  KitchenStockProduct,
  KitchenStation,
  OperationalLocation,
  Order,
  OrderItem,
  OrderLineModifiers,
} from '../services/api.service';
import { AudioService } from '../services/audio.service';
import { PermissionService } from '../services/permission.service';
import { forkJoin, Subscription } from 'rxjs';
import { FocusFirstInputDirective } from '../shared/focus-first-input.directive';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

const REFRESH_INTERVAL_MS = 15000;
const HEARTBEAT_INTERVAL_MS = 30000;
const SOUND_STORAGE_KEY = 'kitchen-display-sound';
const DEVICE_KEY_STORAGE_KEY = 'one-table-kds-device-key';
const STATION_STORAGE_PREFIX = 'one-table-kds-station';

type FullscreenCapableElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  mozRequestFullScreen?: () => Promise<void> | void;
  msRequestFullscreen?: () => Promise<void> | void;
};

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  mozFullScreenElement?: Element | null;
  msFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  mozCancelFullScreen?: () => Promise<void> | void;
  msExitFullscreen?: () => Promise<void> | void;
};

type KdsRoutingMode = 'split' | 'kitchen_all';
type KitchenDisplaySettings = {
  yellow_minutes: number;
  orange_minutes: number;
  red_minutes: number;
  routing_mode: KdsRoutingMode;
};

function getFullscreenElement(): Element | null {
  const d = document as FullscreenDocument;
  return (
    document.fullscreenElement ??
    d.webkitFullscreenElement ??
    d.mozFullScreenElement ??
    d.msFullscreenElement ??
    null
  );
}

function requestFullscreenOnElement(el: HTMLElement): Promise<void> | void {
  const e = el as FullscreenCapableElement;
  if (typeof e.requestFullscreen === 'function') {
    return e.requestFullscreen();
  }
  if (typeof e.webkitRequestFullscreen === 'function') {
    return Promise.resolve(e.webkitRequestFullscreen());
  }
  if (typeof e.mozRequestFullScreen === 'function') {
    return Promise.resolve(e.mozRequestFullScreen());
  }
  if (typeof e.msRequestFullscreen === 'function') {
    return Promise.resolve(e.msRequestFullscreen());
  }
}

function exitDocumentFullscreen(): Promise<void> | void {
  const d = document as FullscreenDocument;
  if (typeof document.exitFullscreen === 'function') {
    return document.exitFullscreen();
  }
  if (typeof d.webkitExitFullscreen === 'function') {
    return Promise.resolve(d.webkitExitFullscreen());
  }
  if (typeof d.mozCancelFullScreen === 'function') {
    return Promise.resolve(d.mozCancelFullScreen());
  }
  if (typeof d.msExitFullscreen === 'function') {
    return Promise.resolve(d.msExitFullscreen());
  }
}

/** Category filter: kitchen = main course only, bar = beverages only. */
const VIEW_CATEGORY: Record<string, string> = {
  kitchen: 'Main Course',
  bar: 'Beverages',
};

@Component({
  selector: 'app-kitchen-display',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TranslateModule, FormsModule, FocusFirstInputDirective],
  template: `
    <div class="kitchen-view" #kitchenRoot>
      <header class="kitchen-header">
        <a routerLink="/staff/orders" class="back-link">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15,18 9,12 15,6"/>
          </svg>
          {{ 'KITCHEN_DISPLAY.BACK_TO_ORDERS' | translate }}
        </a>
        <h1 class="kitchen-title">{{ pageTitle() }}</h1>
        <section class="kds-overview" aria-label="Kitchen service summary">
          <div class="kds-overview-item kds-clock">
            <span class="kds-overview-label">Local time</span>
            <time class="kds-clock-value" data-testid="kds-current-time">{{ currentClockTime() }}</time>
          </div>
          <div class="kds-overview-item">
            <span class="kds-overview-label">Active</span>
            <strong class="kds-overview-value" data-testid="kds-active-count">{{ activeOrderCount() }}</strong>
          </div>
          <div class="kds-overview-item">
            <span class="kds-overview-label">Pending</span>
            <strong class="kds-overview-value" data-testid="kds-pending-count">{{ pendingOrderCount() }}</strong>
          </div>
          <div class="kds-overview-item">
            <span class="kds-overview-label">Preparing</span>
            <strong class="kds-overview-value" data-testid="kds-preparing-count">{{ preparingOrderCount() }}</strong>
          </div>
          <div class="kds-overview-item kds-ready-summary">
            <span class="kds-overview-label">Ready</span>
            <strong class="kds-overview-value" data-testid="kds-ready-count">{{ readyOrderCount() }}</strong>
          </div>
        </section>
        <div class="header-actions">
          @if (operationalLocations().length > 1) {
            <label class="station-filter">
              <span class="station-filter-label">Location</span>
              <select class="station-filter-select" [ngModel]="locationSelection()" (ngModelChange)="locationSelection.set($event)">
                <option [ngValue]="'all'">All locations</option>
                @for (location of operationalLocations(); track location.id) {
                  <option [ngValue]="location.id">{{ location.display_name }}</option>
                }
              </select>
            </label>
          }
          @if (stationsForCurrentView().length > 0) {
            <label class="station-filter">
              <span class="station-filter-label">{{ 'KITCHEN_DISPLAY.STATION' | translate }}</span>
              <select
                class="station-filter-select"
                [ngModel]="stationSelection()"
                (ngModelChange)="onStationSelectChange($event)"
              >
                <option [ngValue]="'all'">{{ 'KITCHEN_DISPLAY.ALL_STATIONS' | translate }}</option>
                @for (s of stationsForCurrentView(); track s.id) {
                  <option [ngValue]="s.id">{{ s.name }}</option>
                }
              </select>
            </label>
          }
          @if (canManageStock()) {
            <button type="button" class="stock-btn" data-testid="kitchen-stock-button" (click)="openStockModal()">
              Stock
            </button>
          }
          <button
            type="button"
            class="fullscreen-btn"
            data-testid="kitchen-fullscreen-toggle"
            (click)="toggleFullscreen()"
            [title]="(isFullscreen() ? 'COMMON.EXIT_FULLSCREEN' : 'COMMON.ENTER_FULLSCREEN') | translate"
          >
            @if (isFullscreen()) {
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>
              </svg>
              {{ 'COMMON.EXIT_FULLSCREEN' | translate }}
            } @else {
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
              </svg>
              {{ 'COMMON.ENTER_FULLSCREEN' | translate }}
            }
          </button>
          <button type="button" class="timer-settings-btn" (click)="openTimerSettingsModal()" title="Display settings">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            Display settings
          </button>
          <label class="sound-toggle">
            <input type="checkbox" [checked]="soundEnabled()" (change)="toggleSound($event)" />
            <span class="sound-label">{{ soundEnabled() ? ('KITCHEN_DISPLAY.SOUND_ON' | translate) : ('KITCHEN_DISPLAY.SOUND_OFF' | translate) }}</span>
          </label>
          <span class="last-refresh" [title]="lastRefreshExact()">{{ 'KITCHEN_DISPLAY.LAST_REFRESH' | translate }}: {{ lastRefreshRelative() }}</span>
        </div>
      </header>

      @if (!kdsOnline()) {
        <div class="kds-connection-banner" role="status">
          Kitchen connection lost - retrying automatically. Customer ordering may be paused.
        </div>
      }
      @if (stockNotice()) {
        <div class="stock-notice" role="status">{{ stockNotice() }}</div>
      }

      <main class="kitchen-main">
        @if (loading()) {
          <div class="empty-state">
            <p>{{ 'ORDERS.LOADING' | translate }}</p>
          </div>
        } @else if (activeOrders().length === 0) {
          <div class="empty-state">
            <div class="empty-icon">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14,2 14,8 20,8"/>
              </svg>
            </div>
            <h2>{{ 'KITCHEN_DISPLAY.NO_ACTIVE_ORDERS' | translate }}</h2>
            <p>{{ 'KITCHEN_DISPLAY.NO_ACTIVE_ORDERS_DESC' | translate }}</p>
          </div>
        } @else {
          <div class="order-grid">
            @for (order of activeOrders(); track order.id; let position = $index) {
              <article class="order-card status-{{ order.status }} {{ getTimerColorClass(order) }}" [class.order-card-urgent]="order.staff_urgent">
                <header class="order-header">
                  <div class="order-sequence">
                    <span class="fifo-position">FIFO {{ position + 1 }}</span>
                    <span class="order-id">#{{ order.id }}</span>
                    @if (order.staff_urgent) {
                      <span class="urgent-badge">{{ 'KITCHEN_DISPLAY.URGENT' | translate }}</span>
                    }
                  </div>
                  <span class="payment-badge" [class.payment-badge-paid]="isOrderPaid(order)">
                    {{ isOrderPaid(order) ? 'PAID' : 'NOT PAID' }}
                  </span>
                </header>
                <section class="order-destination">
                  @if (order.location_name) { <span class="order-location">{{ order.location_name }}</span> }
                  <div class="order-destination-row">
                    <strong class="order-table">{{ order.service_point_label || order.table_name }}</strong>
                    <span class="order-waiting" aria-label="Elapsed wait time">
                      <span>Waiting</span>
                      <time>{{ formatWaitingTime(getKitchenStart(order)) }}</time>
                    </span>
                  </div>
                </section>
                <div class="order-timer-bar-wrap" [attr.aria-label]="'KITCHEN_DISPLAY.TIMER_BAR_HINT' | translate">
                  <div class="order-timer-bar-track">
                    <div class="order-timer-bar-fill" [class]="getTimerBarFillClass(order)" [style.width.%]="getTimerBarPercent(order)"></div>
                  </div>
                </div>
                <ul class="order-items">
                  @for (item of getSortedItems(order.items); track item.id) {
                    @if (!item.removed_by_customer) {
                      <li class="order-item">
                        <span class="item-qty">{{ item.quantity }}×</span>
                        <span class="item-copy">
                          <strong class="item-name">{{ item.product_name }}</strong>
                          @if (hasCustomization(item)) {
                            <small class="item-customization">{{ formatCustomizationItem(item) }}</small>
                          }
                          @if (item.notes) {
                            <small class="item-notes"><strong>{{ 'KITCHEN_DISPLAY.ITEM_COMMENT' | translate }}:</strong> {{ item.notes }}</small>
                          }
                        </span>
                      </li>
                    }
                  }
                </ul>
                <footer class="order-actions">
                  @if (getOrderActionTarget(order)) {
                    <button
                      type="button"
                      class="order-primary-action"
                      [class]="getOrderActionClass(order)"
                      [disabled]="isOrderActionBusy(order.id) || !canUpdateItemStatus()"
                      (click)="advanceOrder(order)"
                    >
                      {{ isOrderActionBusy(order.id) ? 'Updating...' : getOrderActionLabel(order) }}
                    </button>
                  }
                  <button type="button" class="order-details-toggle" (click)="toggleOrderDetails(order.id)" [attr.aria-expanded]="isOrderDetailsOpen(order.id)">
                    {{ isOrderDetailsOpen(order.id) ? 'Show less' : 'Show more' }}
                  </button>
                </footer>
                @if (isOrderDetailsOpen(order.id)) {
                  <section class="order-details">
                    <dl>
                      @if (order.customer_name) { <div><dt>Customer</dt><dd>{{ order.customer_name }}</dd></div> }
                      <div><dt>Received</dt><dd>{{ formatOrderTime(getKitchenStart(order)) }}</dd></div>
                      <div><dt>Status</dt><dd>{{ getStatusLabel(order.status) }}</dd></div>
                    </dl>
                    <div class="item-status-summary">
                      @for (item of getSortedItems(order.items); track item.id) {
                        @if (!item.removed_by_customer) {
                          <span>{{ item.product_name }}: {{ getItemStatusLabel(item.status || 'pending') }}</span>
                        }
                      }
                    </div>
                    @if (cleanKitchenNotes(order.notes); as visibleNotes) {
                      <div class="order-notes">{{ 'KITCHEN_DISPLAY.NOTES' | translate }}: {{ visibleNotes }}</div>
                    }
                  </section>
                }
              </article>
            }
          </div>
        }
      </main>
      @if (stockModalOpen()) {
        <div class="modal-backdrop stock-backdrop" (click)="closeStockModal()"></div>
        <section class="stock-modal" role="dialog" aria-modal="true" aria-labelledby="stock-modal-title" appFocusFirstInput data-testid="kitchen-stock-modal">
          <header class="stock-modal-header">
            <div>
              <h2 id="stock-modal-title">Stock</h2>
              <p>{{ stockScopeLabel() }}. Uncheck an item to stop customers ordering it.</p>
            </div>
            <button type="button" class="stock-close" (click)="closeStockModal()" aria-label="Close stock">Close</button>
          </header>

          <div class="stock-toolbar">
            <label>Search menu
              <input
                [ngModel]="stockSearch()"
                (ngModelChange)="stockSearch.set($event)"
                placeholder="Search by item or category"
                data-testid="kitchen-stock-search"
              >
            </label>
            <div class="stock-summary">
              <strong>{{ availableStockCount() }}/{{ filteredStockProducts().length }}</strong>
              <span>available in this view</span>
            </div>
          </div>

          @if (stockError()) { <p class="stock-error" role="alert">{{ stockError() }}</p> }
          @if (stockLoading()) {
            <div class="stock-loading" aria-label="Loading stock">
              @for (item of [1,2,3,4,5,6]; track item) { <span></span> }
            </div>
          } @else if (filteredStockProducts().length === 0) {
            <div class="stock-empty"><h3>No menu items found</h3><p>Try another search or station.</p></div>
          } @else {
            <div class="stock-grid">
              @for (product of filteredStockProducts(); track product.id) {
                <label class="stock-card" [class.stock-card--unavailable]="!stockDraft()[product.id!]" [attr.data-product-id]="product.id">
                  <span class="stock-image">
                    <span class="stock-image-placeholder">No image</span>
                    @if (stockImageUrl(product); as imageUrl) {
                      <img [src]="imageUrl" [alt]="product.name" (error)="hideBrokenStockImage($event)">
                    }
                  </span>
                  <span class="stock-copy"><strong>{{ product.name }}</strong><small>{{ product.category || 'Uncategorised' }}</small></span>
                  <input
                    type="checkbox"
                    [checked]="stockDraft()[product.id!]"
                    (change)="setStockAvailability(product.id!, $event)"
                    [attr.aria-label]="product.name + ' available'"
                  >
                  <span class="stock-state">{{ stockDraft()[product.id!] ? 'Available' : 'Sold out' }}</span>
                </label>
              }
            </div>
          }

          <footer class="stock-actions">
            <span>{{ stockChangedCount() }} unsaved change{{ stockChangedCount() === 1 ? '' : 's' }}</span>
            <div>
              <button type="button" class="btn-secondary" (click)="closeStockModal()">Cancel</button>
              <button type="button" class="btn-primary" data-testid="kitchen-stock-save" (click)="saveStock()" [disabled]="stockSaving() || stockChangedCount() === 0">
                {{ stockSaving() ? 'Saving...' : 'Save stock' }}
              </button>
            </div>
          </footer>
        </section>
      }
      @if (timerSettingsModalOpen()) {
        <div class="modal-backdrop" (click)="closeTimerSettingsModal()"></div>
        <div class="modal timer-settings-modal" role="dialog" aria-labelledby="timer-settings-title" appFocusFirstInput>
          <h2 id="timer-settings-title" class="modal-title">Display settings</h2>
          <p class="modal-desc">Set order routing and wait-time colours.</p>
          <label class="routing-mode-control">
            <span>Order display routing</span>
            <select [ngModel]="timerSettingsForm().routing_mode" (ngModelChange)="updateTimerFormRouting($event)">
              <option [ngValue]="'kitchen_all'">All items in Kitchen</option>
              <option [ngValue]="'split'">Split Kitchen and Bar</option>
            </select>
            <small>Use one combined kitchen queue or send drinks separately to Bar.</small>
          </label>
          <div class="timer-settings-form">
            <label>
              <span>{{ 'KITCHEN_DISPLAY.TIMER_YELLOW_MINUTES' | translate }}</span>
              <input type="number" min="0" step="1" [ngModel]="timerSettingsForm().yellow_minutes" (ngModelChange)="updateTimerFormYellow($event)" />
            </label>
            <label>
              <span>{{ 'KITCHEN_DISPLAY.TIMER_ORANGE_MINUTES' | translate }}</span>
              <input type="number" min="0" step="1" [ngModel]="timerSettingsForm().orange_minutes" (ngModelChange)="updateTimerFormOrange($event)" />
            </label>
            <label>
              <span>{{ 'KITCHEN_DISPLAY.TIMER_RED_MINUTES' | translate }}</span>
              <input type="number" min="0" step="1" [ngModel]="timerSettingsForm().red_minutes" (ngModelChange)="updateTimerFormRed($event)" />
            </label>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-secondary" (click)="closeTimerSettingsModal()">{{ 'COMMON.CANCEL' | translate }}</button>
            <button type="button" class="btn-primary" (click)="saveTimerSettings()">{{ 'COMMON.SAVE' | translate }}</button>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .kitchen-view {
      min-height: 100vh;
      background: var(--color-bg);
      display: flex;
      flex-direction: column;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-synthesis: none;
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    .kitchen-header {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      grid-template-areas:
        'back overview title'
        'actions actions actions';
      align-items: center;
      gap: var(--space-4);
      padding: var(--space-4) var(--space-6);
      background: var(--color-surface);
      border-bottom: 2px solid var(--color-border);
      box-shadow: var(--shadow-sm);
    }
    .kds-connection-banner {
      padding: 12px 24px;
      background: #7f1d1d;
      color: #fff;
      font-weight: 700;
      text-align: center;
    }
    .back-link {
      grid-area: back;
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      color: var(--color-primary);
      font-weight: 500;
      text-decoration: none;
      font-size: 1rem;
    }
    .back-link:hover { text-decoration: underline; }
    .kitchen-title {
      grid-area: title;
      justify-self: end;
      font-size: clamp(1.5rem, 4vw, 2.25rem);
      font-weight: 700;
      color: var(--color-text);
      margin: 0;
    }
    .header-actions {
      grid-area: actions;
      display: flex;
      align-items: center;
      gap: var(--space-5);
      flex-wrap: wrap;
    }
    .kds-overview {
      grid-area: overview;
      justify-self: center;
      display: grid;
      grid-template-columns: minmax(118px, auto) repeat(4, minmax(68px, auto));
      overflow: hidden;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: #fafaf9;
    }
    .kds-overview-item {
      display: grid;
      align-content: center;
      min-height: 54px;
      padding: 7px 13px;
      border-left: 1px solid var(--color-border);
      text-align: center;
    }
    .kds-overview-item:first-child { border-left: 0; }
    .kds-overview-label {
      color: var(--color-text-muted);
      font-size: .7rem;
      font-weight: 500;
      line-height: 1.2;
    }
    .kds-overview-value,
    .kds-clock-value {
      color: var(--color-text);
      font-weight: 700;
      font-feature-settings: 'tnum' 1;
      font-variant-numeric: tabular-nums;
      line-height: 1.15;
    }
    .kds-overview-value { font-size: 1.25rem; }
    .kds-clock-value { font-size: 1.35rem; letter-spacing: -.02em; }
    .kds-ready-summary .kds-overview-value { color: #15803d; }
    .stock-btn,
    .timer-settings-btn,
    .fullscreen-btn {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
      font-size: 0.9375rem;
      font-weight: 500;
      color: var(--color-primary);
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      cursor: pointer;
    }
    .stock-btn:hover,
    .timer-settings-btn:hover,
    .fullscreen-btn:hover { background: var(--color-bg); }
    .stock-btn {
      min-height: 42px;
      padding-inline: var(--space-4);
      color: #fff;
      background: #1f2937;
      border-color: #1f2937;
      font-weight: 600;
    }
    .stock-btn:hover { background: #111827; }
    .sound-toggle {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      cursor: pointer;
      font-size: 1rem;
      font-weight: 500;
      color: var(--color-text);
    }
    .sound-toggle input { cursor: pointer; width: 18px; height: 18px; }
    .last-refresh {
      font-size: 0.875rem;
      color: var(--color-text-muted);
    }
    .station-filter {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: 0.9375rem;
      font-weight: 500;
      color: var(--color-text);
    }
    .station-filter-label { white-space: nowrap; }
    .station-filter-select {
      min-width: 160px;
      padding: var(--space-2) var(--space-3);
      font-size: 1rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
      color: var(--color-text);
    }
    .kitchen-main {
      flex: 1;
      padding: var(--space-5) var(--space-6);
      overflow: auto;
      background: #090b10;
    }
    .empty-state {
      text-align: center;
      padding: var(--space-8);
      background: var(--color-surface);
      border: 1px dashed var(--color-border);
      border-radius: var(--radius-lg);
    }
    .empty-state .empty-icon { color: var(--color-text-muted); margin-bottom: var(--space-4); }
    .empty-state h2 { margin: 0 0 var(--space-2); font-size: 1.5rem; color: var(--color-text); }
    .empty-state p { margin: 0; color: var(--color-text-muted); }
    .order-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
      gap: 16px;
      align-items: start;
    }
    .order-card {
      display: grid;
      min-width: 0;
      background: #292e39;
      border: 2px solid #414959;
      border-left: 6px solid var(--color-warning);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: var(--shadow-md);
    }
    .order-card.status-preparing { border-left-color: #3B82F6; }
    .order-card.status-ready { border-left-color: var(--color-success); }
    .order-card-urgent {
      box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.45), var(--shadow-sm);
    }
    .urgent-badge {
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      background: rgba(220, 38, 38, 0.15);
      color: #b91c1c;
    }
    .fifo-position {
      align-self: center;
      padding: 3px 8px;
      border-radius: 4px;
      background: #111827;
      color: #fff;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.04em;
    }
    .order-sequence {
      display: flex;
      align-items: center;
      min-width: 0;
      gap: 10px;
    }
    .order-timer-bar-wrap {
      padding: 0 16px 12px;
      background: #20242d;
    }
    .order-timer-bar-track {
      height: 8px;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.08);
      overflow: hidden;
    }
    .order-timer-bar-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.35s ease-out, background 0.25s;
      min-width: 0;
    }
    .timer-fill-green { background: linear-gradient(90deg, #16a34a, #22c55e); }
    .timer-fill-yellow { background: linear-gradient(90deg, #ca8a04, #eab308); }
    .timer-fill-orange { background: linear-gradient(90deg, #ea580c, #f97316); }
    .timer-fill-red { background: linear-gradient(90deg, #b91c1c, #ef4444); }
    .order-card.timer-green { border-left-color: #22c55e; }
    .order-card.timer-yellow { border-left-color: #eab308; }
    .order-card.timer-orange { border-left-color: #f97316; }
    .order-card.timer-red { border-left-color: #ef4444; }
    .order-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 14px 16px 10px;
      background: #20242d;
    }
    .order-id {
      font-size: 1.2rem;
      font-weight: 700;
      color: #f8fafc;
      white-space: nowrap;
    }
    .order-destination {
      display: grid;
      min-width: 0;
      gap: 4px;
      padding: 4px 16px 14px;
      background: #20242d;
      border-bottom: 1px solid #414959;
    }
    .order-destination-row {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }
    .order-table {
      overflow-wrap: anywhere;
      font-size: clamp(1.35rem, 2vw, 1.625rem);
      line-height: 1.15;
      font-weight: 700;
      color: #f2c66d;
    }
    .order-location {
      color: #bfdbfe;
      font-size: .75rem;
      font-weight: 600;
      letter-spacing: .035em;
      text-transform: uppercase;
      overflow-wrap: anywhere;
    }
    .order-waiting {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: baseline;
      gap: 6px;
      padding: 4px 7px;
      border: 1px solid #475569;
      border-radius: 6px;
      background: #171a21;
      color: #aeb8c7;
      font-size: .75rem;
      font-weight: 500;
      line-height: 1;
      white-space: nowrap;
    }
    .order-waiting time {
      color: #f8fafc;
      font-size: .9375rem;
      font-weight: 600;
      font-feature-settings: 'tnum' 1;
      font-variant-numeric: tabular-nums;
    }
    .payment-badge {
      flex: 0 0 auto;
      padding: 8px 11px;
      border: 1px solid #7f1d1d;
      border-radius: 8px;
      background: #451a1a;
      color: #fecaca;
      font-size: .78rem;
      font-weight: 700;
      letter-spacing: .04em;
      white-space: nowrap;
    }
    .payment-badge-paid { border-color: #166534; background: #14532d; color: #dcfce7; }
    .order-items {
      list-style: none;
      margin: 0;
      padding: 10px 16px;
    }
    .order-item {
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr);
      align-items: start;
      gap: 10px;
      min-width: 0;
      padding: 13px 0;
      font-size: 1.1rem;
      line-height: 1.25;
      border-bottom: 1px solid #414959;
    }
    .order-item:last-child { border-bottom: none; }
    .item-qty {
      font-weight: 600;
      color: var(--color-primary);
      font-size: 1.125rem;
    }
    .item-copy { display: grid; min-width: 0; gap: 5px; }
    .item-name {
      overflow-wrap: anywhere;
      color: #f8fafc;
      font-size: 1.125rem;
      font-weight: 600;
      line-height: 1.35;
    }
    .item-notes {
      display: block;
      font-size: .9rem;
      font-weight: 600;
      color: #fde68a;
      background: rgba(245, 158, 11, 0.12);
      padding: 7px 9px;
      border-radius: 7px;
      border-left: 3px solid var(--color-warning);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .item-customization {
      display: block;
      font-size: .85rem;
      line-height: 1.3;
      color: #cbd5e1;
    }
    .order-actions {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      padding: 12px 16px 14px;
      border-top: 1px solid #414959;
      background: #20242d;
    }
    .order-primary-action,
    .order-details-toggle {
      min-width: 0;
      min-height: 56px;
      border-radius: 9px;
      font: inherit;
      font-size: 1rem;
      font-weight: 600;
      white-space: nowrap;
      cursor: pointer;
      touch-action: manipulation;
    }
    .order-primary-action { border: 1px solid #2563eb; background: #2563eb; color: #fff; }
    .order-primary-action.order-action-ready { border-color: #16a34a; background: #16a34a; }
    .order-primary-action.order-action-complete { border-color: #64748b; background: #475569; }
    .order-primary-action:disabled { cursor: wait; opacity: .55; }
    .order-details-toggle {
      min-width: 102px;
      padding: 0 12px;
      border: 1px solid #64748b;
      background: transparent;
      color: #e2e8f0;
      font-size: .9375rem;
    }
    .order-primary-action:active,.order-details-toggle:active { transform: translateY(1px); }
    .order-details { padding: 12px 16px 16px; border-top: 1px solid #414959; background: #171a21; }
    .order-details dl { display: grid; grid-template-columns: 1fr 1fr; gap: 9px 14px; margin: 0; }
    .order-details dl div { min-width: 0; }
    .order-details dt {
      color: #94a3b8;
      font-size: .7rem;
      font-weight: 600;
      letter-spacing: .03em;
      text-transform: uppercase;
    }
    .order-details dd { overflow-wrap: anywhere; margin: 2px 0 0; color: #f8fafc; font-weight: 600; }
    .item-status-summary { display: grid; gap: 5px; margin-top: 12px; color: #cbd5e1; font-size: .78rem; }
    .order-notes {
      margin-top: 12px;
      padding: 10px 11px;
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, .26);
      border-radius: 8px;
      font-size: .82rem;
      font-weight: 600;
      color: #f8fafc;
      white-space: pre-wrap;
      word-break: break-word;
    }
    @media (max-width: 520px) {
      .order-destination-row { align-items: flex-start; flex-direction: column; }
      .order-actions { grid-template-columns: 1fr; }
      .order-details-toggle { width: 100%; }
      .order-details dl { grid-template-columns: 1fr; }
    }
    @media (max-width: 1100px) {
      .kitchen-header {
        grid-template-columns: minmax(0, 1fr) auto;
        grid-template-areas:
          'back title'
          'overview overview'
          'actions actions';
      }
      .kds-overview { justify-self: stretch; }
      .kds-overview-item { padding-inline: 10px; }
    }
    @media (max-width: 640px) {
      .kitchen-header { padding: 14px 16px; }
      .kds-overview { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .kds-clock { grid-column: 1 / -1; border-left: 0; border-bottom: 1px solid var(--color-border); }
      .kds-overview-item { min-height: 48px; padding: 6px 8px; }
      .kds-overview-item:nth-child(2) { border-left: 0; }
      .kds-clock-value { font-size: 1.25rem; }
      .kds-overview-value { font-size: 1.125rem; }
      .header-actions { gap: 10px; }
    }
    .stock-notice {
      padding: 10px 24px;
      background: #dcfce7;
      color: #166534;
      font-weight: 700;
      text-align: center;
    }
    .modal-backdrop.stock-backdrop { background: rgba(3, 7, 18, .72); }
    .stock-modal {
      position: fixed;
      inset: 3vh 3vw;
      z-index: 1001;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      overflow: hidden;
      border: 1px solid #d8dde5;
      border-radius: 16px;
      background: #f6f7f9;
      color: #1f2937;
      box-shadow: 0 24px 80px rgba(0, 0, 0, .35);
    }
    .stock-modal-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 20px;
      border-bottom: 1px solid #dfe3e8;
      background: #fff;
    }
    .stock-modal-header h2 { margin: 0; font-size: 1.4rem; }
    .stock-modal-header p { margin: 4px 0 0; color: #6b7280; font-size: .88rem; }
    .stock-close {
      min-height: 40px;
      padding: 0 13px;
      border: 1px solid #d8dde5;
      border-radius: 9px;
      background: #fff;
      color: #374151;
      font-weight: 700;
    }
    .stock-toolbar {
      display: flex;
      align-items: end;
      gap: 16px;
      padding: 12px 20px;
      border-bottom: 1px solid #dfe3e8;
      background: #fff;
    }
    .stock-toolbar label { display: grid; flex: 1; gap: 4px; color: #6b7280; font-size: .72rem; font-weight: 700; }
    .stock-toolbar input {
      width: 100%;
      min-height: 44px;
      padding: 0 12px;
      border: 1px solid #ccd2da;
      border-radius: 9px;
      background: #fff;
      color: #111827;
      font: inherit;
    }
    .stock-toolbar input:focus { border-color: #d35233; outline: 3px solid rgba(211, 82, 51, .15); }
    .stock-summary { display: grid; min-width: 150px; text-align: right; }
    .stock-summary strong { font-size: 1.1rem; font-variant-numeric: tabular-nums; }
    .stock-summary span { color: #6b7280; font-size: .7rem; }
    .stock-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 12px;
      align-content: start;
      overflow: auto;
      padding: 16px 20px;
    }
    .stock-card {
      position: relative;
      display: grid;
      grid-template-columns: 74px minmax(0, 1fr) auto;
      grid-template-rows: 1fr auto;
      gap: 7px 11px;
      min-height: 96px;
      padding: 10px;
      border: 2px solid #86b89a;
      border-radius: 12px;
      background: #fff;
      cursor: pointer;
      transition: border-color .15s ease, opacity .15s ease;
    }
    .stock-card--unavailable { border-color: #d8dde5; opacity: .66; }
    .stock-image { position: relative; grid-row: 1 / 3; overflow: hidden; width: 74px; height: 74px; border-radius: 9px; background: #e9ecf0; }
    .stock-image-placeholder { position: absolute; inset: 0; display: grid; place-items: center; color: #7b8490; font-size: .65rem; }
    .stock-image img { position: relative; z-index: 1; width: 100%; height: 100%; object-fit: cover; }
    .stock-copy { display: grid; align-content: center; min-width: 0; }
    .stock-copy strong {
      display: -webkit-box;
      overflow: hidden;
      color: #111827;
      font-size: .9rem;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    .stock-copy small { margin-top: 4px; color: #6b7280; font-size: .7rem; }
    .stock-card>input { width: 26px; height: 26px; margin: 2px; accent-color: #16834f; cursor: pointer; }
    .stock-state { grid-column: 2 / 4; color: #167248; font-size: .7rem; font-weight: 700; }
    .stock-card--unavailable .stock-state { color: #9f312b; }
    .stock-loading { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; overflow: hidden; padding: 16px 20px; }
    .stock-loading span { height: 96px; border-radius: 12px; background: #e8ebef; }
    .stock-empty { display: grid; place-items: center; align-content: center; min-height: 220px; color: #6b7280; text-align: center; }
    .stock-empty h3 { margin: 0; color: #374151; }
    .stock-empty p { margin: 5px 0 0; }
    .stock-error { margin: 12px 20px 0; padding: 10px; border-radius: 8px; background: #fee2e2; color: #991b1b; }
    .stock-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 20px;
      border-top: 1px solid #dfe3e8;
      background: #fff;
    }
    .stock-actions>span { color: #6b7280; font-size: .8rem; }
    .stock-actions>div { display: flex; gap: 9px; }
    .stock-actions button { min-height: 44px; padding: 0 16px; border-radius: 9px; font-weight: 600; }
    @media (max-width: 700px) {
      .stock-modal { inset: 0; border: 0; border-radius: 0; }
      .stock-grid { grid-template-columns: 1fr; padding: 12px; }
      .stock-toolbar { align-items: stretch; flex-direction: column; padding: 10px 12px; }
      .stock-summary { min-width: 0; text-align: left; }
      .stock-modal-header,.stock-actions { padding-inline: 12px; }
      .stock-actions { align-items: stretch; flex-direction: column; }
      .stock-actions>div,.stock-actions button { width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) { .stock-card { transition: none; } }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.4);
      z-index: 1000;
    }
    .modal {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: var(--color-surface);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-md);
      padding: var(--space-6);
      z-index: 1001;
      min-width: 320px;
      max-width: 90vw;
    }
    .modal-title { margin: 0 0 var(--space-2); font-size: 1.25rem; }
    .modal-desc { margin: 0 0 var(--space-4); color: var(--color-text-muted); font-size: 0.9375rem; }
    .routing-mode-control {
      display: grid;
      gap: 6px;
      margin-bottom: 18px;
      color: var(--color-text);
      font-weight: 700;
    }
    .routing-mode-control select {
      width: 100%;
      min-height: 44px;
      padding: 0 11px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-bg);
      color: var(--color-text);
      font: inherit;
    }
    .routing-mode-control small { color: var(--color-text-muted); font-size: .78rem; font-weight: 500; }
    .timer-settings-form {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      margin-bottom: var(--space-5);
    }
    .timer-settings-form label {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }
    .timer-settings-form label span { min-width: 140px; font-weight: 500; }
    .timer-settings-form input {
      width: 80px;
      padding: var(--space-2) var(--space-3);
      font-size: 1rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--space-3);
    }
    .modal-actions .btn-primary, .modal-actions .btn-secondary {
      padding: var(--space-2) var(--space-4);
      font-size: 1rem;
      font-weight: 500;
      border-radius: var(--radius-md);
      cursor: pointer;
    }
    .modal-actions .btn-primary {
      background: var(--color-primary);
      color: white;
      border: none;
    }
    .modal-actions .btn-secondary {
      background: var(--color-bg);
      color: var(--color-text);
      border: 1px solid var(--color-border);
    }
  `],
})
export class KitchenDisplayComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('kitchenRoot', { read: ElementRef }) kitchenRootRef?: ElementRef<HTMLElement>;

  private api = inject(ApiService);
  private audio = inject(AudioService);
  private translate = inject(TranslateService);
  private permissions = inject(PermissionService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  private refreshIntervalId: ReturnType<typeof setInterval> | null = null;
  private wsSub: Subscription | null = null;
  private routeDataSub: Subscription | null = null;
  private queryParamSub: Subscription | null = null;
  private initialLoadDone = false;
  private pendingBackgroundRefresh = false;
  private stockNoticeTimeoutId: ReturnType<typeof setTimeout> | null = null;

  orders = signal<Order[]>([]);
  loading = signal(true);
  lastRefreshAt = signal<Date | null>(null);
  soundEnabled = signal(true);
  itemStatusDropdownOpen = signal<string | null>(null);
  /** 'kitchen' = cocina (Main Course), 'bar' = beverages only */
  viewMode = signal<'kitchen' | 'bar'>('kitchen');
  /** Loaded prep stations; filtered per view by display_route */
  kitchenStations = signal<KitchenStation[]>([]);
  operationalLocations = signal<OperationalLocation[]>([]);
  locationSelection = signal<number | 'all'>('all');
  /** KDS station filter when tenant has stations for this view */
  stationSelection = signal<number | 'all'>('all');
  stockModalOpen = signal(false);
  stockLoading = signal(false);
  stockSaving = signal(false);
  stockError = signal('');
  stockNotice = signal('');
  stockSearch = signal('');
  stockProducts = signal<KitchenStockProduct[]>([]);
  stockOriginal = signal<Record<number, boolean>>({});
  stockDraft = signal<Record<number, boolean>>({});
  /** Current time for live timer (updates every second). */
  now = signal(Date.now());
  /** Timer thresholds (minutes) for card color. Defaults 5, 10, 15. */
  timerSettings = signal<KitchenDisplaySettings>({
    yellow_minutes: 5,
    orange_minutes: 10,
    red_minutes: 15,
    routing_mode: 'split',
  });
  timerSettingsModalOpen = signal(false);
  timerSettingsForm = signal<KitchenDisplaySettings>({
    yellow_minutes: 5,
    orange_minutes: 10,
    red_minutes: 15,
    routing_mode: 'split',
  });
  private tickIntervalId: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;
  private deviceKey = '';
  private wakeLock: { release: () => Promise<void> } | null = null;
  kdsOnline = signal(true);
  strictFifo = signal(true);
  expandedOrderDetails = signal<Set<number>>(new Set());
  orderActionBusy = signal<Set<number>>(new Set());

  /** True when this view’s root element is the browser fullscreen element. */
  isFullscreen = signal(false);

  canUpdateItemStatus = computed(() =>
    this.permissions.hasPermission(this.permissions.getCurrentUser(), 'order:item_status')
  );

  canManageStock = computed(() =>
    this.permissions.hasPermission(this.permissions.getCurrentUser(), 'product:availability')
  );

  pageTitle = computed(() =>
    this.viewMode() === 'bar'
      ? this.translate.instant('BAR_DISPLAY.TITLE')
      : this.translate.instant('KITCHEN_DISPLAY.TITLE')
  );

  stationsForCurrentView = computed(() => {
    const route = this.viewMode() === 'bar' ? 'bar' : 'kitchen';
    return [...this.kitchenStations()]
      .filter((s) => s.display_route === route)
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  });

  stockProductsForView = computed(() => {
    const route = this.viewMode();
    const selection = this.stationSelection();
    return this.stockProducts().filter((product) => {
      if (product.kitchen_station_route !== route) return false;
      if (selection === 'all') return true;
      return product.resolved_kitchen_station_id === selection;
    });
  });

  filteredStockProducts = computed(() => {
    const query = this.stockSearch().trim().toLowerCase();
    const products = this.stockProductsForView();
    if (!query) return products;
    return products.filter((product) =>
      `${product.name} ${product.category || ''} ${product.subcategory || ''}`.toLowerCase().includes(query)
    );
  });

  availableStockCount = computed(() =>
    this.filteredStockProducts().filter((product) => !!this.stockDraft()[product.id!]).length
  );

  stockChangedCount = computed(() => {
    const original = this.stockOriginal();
    const draft = this.stockDraft();
    return this.stockProducts().filter(
      (product) => product.id != null && original[product.id] !== draft[product.id]
    ).length;
  });

  /** Orders that are active (including paid but not yet delivered); category or station filter. */
  activeOrders = computed(() => {
    const view = this.viewMode();
    const category = VIEW_CATEGORY[view] ?? '';
    const routeKey = view === 'bar' ? 'bar' : 'kitchen';
    const useStations = this.stationsForCurrentView().length > 0;
    const sel = this.stationSelection();

    const itemVisible = (i: OrderItem): boolean => {
      if (i.removed_by_customer) return false;
      if (!(i.status === 'pending' || i.status === 'preparing' || i.status === 'ready')) return false;
      if (!useStations) {
        return i.category === category;
      }
      const kr =
        i.kitchen_station_route ||
        (i.category === 'Beverages' ? 'bar' : 'kitchen');
      if (kr !== routeKey) return false;
      if (sel === 'all') return true;
      return i.kitchen_station_id === sel;
    };

    const list = this.orders().filter((o) => {
      if (this.locationSelection() !== 'all' && o.location_id !== this.locationSelection()) return false;
      if (!['pending', 'preparing', 'ready', 'partially_delivered', 'paid'].includes(o.status)) return false;
      const items = (o.items ?? []).filter(itemVisible);
      return items.length > 0;
    });
    const mapped = list.map((o) => ({
      ...o,
      staff_urgent: !!o.staff_urgent,
      items: (o.items ?? []).filter(itemVisible),
    }));
    return mapped.sort((a, b) => {
      if (!this.strictFifo() && !!a.staff_urgent !== !!b.staff_urgent) {
        return a.staff_urgent ? -1 : 1;
      }
      const ta = new Date(a.kitchen_released_at || a.created_at).getTime();
      const tb = new Date(b.kitchen_released_at || b.created_at).getTime();
      return ta - tb;
    });
  });

  activeOrderCount = computed(() => this.activeOrders().length);
  pendingOrderCount = computed(
    () => this.activeOrders().filter((order) => this.getOrderActionTarget(order) === 'preparing').length,
  );
  preparingOrderCount = computed(
    () => this.activeOrders().filter((order) => this.getOrderActionTarget(order) === 'ready').length,
  );
  readyOrderCount = computed(
    () => this.activeOrders().filter((order) => this.getOrderActionTarget(order) === 'delivered').length,
  );
  currentClockTime = computed(() =>
    new Date(this.now()).toLocaleTimeString('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }),
  );

  lastRefreshRelative = computed(() => {
    const at = this.lastRefreshAt();
    if (!at) return '-';
    const sec = Math.floor((Date.now() - at.getTime()) / 1000);
    if (sec < 10) return '< 10s';
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    return `${min}m`;
  });

  lastRefreshExact = computed(() => {
    const at = this.lastRefreshAt();
    return at ? at.toLocaleTimeString() : '';
  });

  ngOnInit(): void {
    this.deviceKey = this.getOrCreateDeviceKey();
    const stored = localStorage.getItem(SOUND_STORAGE_KEY);
    this.soundEnabled.set(stored !== 'false');
    this.audio.setEnabled(this.soundEnabled());

    const view = (this.route.snapshot.data['view'] as 'kitchen' | 'bar') || 'kitchen';
    this.viewMode.set(view);
    this.routeDataSub = this.route.data.subscribe((data) => {
      const v = (data['view'] as 'kitchen' | 'bar') || 'kitchen';
      this.viewMode.set(v);
    });

    this.queryParamSub = this.route.queryParamMap.subscribe((qm) => {
      const s = qm.get('station');
      if (s == null || s === '' || s === 'all') {
        const stored = localStorage.getItem(`${STATION_STORAGE_PREFIX}-${this.viewMode()}`);
        const storedNumber = stored ? Number.parseInt(stored, 10) : Number.NaN;
        this.stationSelection.set(Number.isFinite(storedNumber) ? storedNumber : 'all');
      } else {
        const n = Number.parseInt(s, 10);
        if (Number.isFinite(n)) {
          this.stationSelection.set(n);
        }
      }
    });

    this.api.getKitchenStations().subscribe({
      next: (list) => this.kitchenStations.set(list),
      error: () => this.kitchenStations.set([]),
    });
    this.api.getOperationalLocations().subscribe({
      next: (list) => this.operationalLocations.set(list.filter((row) => row.is_active)),
      error: () => this.operationalLocations.set([]),
    });

    this.loadTimerSettings();
    this.sendHeartbeat();
    this.heartbeatIntervalId = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.loadOrders({ initial: true });
    this.refreshIntervalId = setInterval(
      () => this.loadOrders({ background: true }),
      REFRESH_INTERVAL_MS
    );
    this.tickIntervalId = setInterval(() => this.now.set(Date.now()), 1000);

    try {
      this.api.connectWebSocket();
      this.wsSub = this.api.orderUpdates$.subscribe((update: unknown) => {
        if (update && typeof update === 'object' && 'type' in update) {
          const type = (update as { type: string }).type;
          if (this.soundEnabled() && ['new_order', 'items_added'].includes(type)) {
            this.audio.playRestaurantOrderChange();
          }
          this.loadOrders({ background: true });
        }
      });
    } catch {
      // continue without WebSocket
    }

    document.addEventListener('click', this.closeItemStatusDropdown);

    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', this.onFullscreenChange);
    document.addEventListener('mozfullscreenchange', this.onFullscreenChange);
    document.addEventListener('MSFullscreenChange', this.onFullscreenChange);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  ngAfterViewInit(): void {
    this.syncFullscreenState();
    void this.requestScreenWakeLock();
  }

  ngOnDestroy(): void {
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
    }
    if (this.tickIntervalId) {
      clearInterval(this.tickIntervalId);
      this.tickIntervalId = null;
    }
    if (this.heartbeatIntervalId) {
      clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
    }
    if (this.stockNoticeTimeoutId) {
      clearTimeout(this.stockNoticeTimeoutId);
      this.stockNoticeTimeoutId = null;
    }
    this.wsSub?.unsubscribe();
    this.routeDataSub?.unsubscribe();
    this.queryParamSub?.unsubscribe();
    document.removeEventListener('click', this.closeItemStatusDropdown);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', this.onFullscreenChange);
    document.removeEventListener('mozfullscreenchange', this.onFullscreenChange);
    document.removeEventListener('MSFullscreenChange', this.onFullscreenChange);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    void this.releaseScreenWakeLock();
    void this.exitFullscreenIfActive();
  }

  onStationSelectChange(value: number | 'all'): void {
    this.stationSelection.set(value);
    const storageKey = `${STATION_STORAGE_PREFIX}-${this.viewMode()}`;
    if (value === 'all') localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, String(value));
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { station: value === 'all' ? undefined : value },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    this.sendHeartbeat();
  }

  stockScopeLabel(): string {
    const selection = this.stationSelection();
    if (selection !== 'all') {
      const station = this.kitchenStations().find((item) => item.id === selection);
      if (station) return station.name;
    }
    return this.viewMode() === 'bar' ? 'Bar menu' : 'Kitchen menu';
  }

  openStockModal(): void {
    if (!this.canManageStock()) return;
    this.stockModalOpen.set(true);
    this.stockLoading.set(true);
    this.stockError.set('');
    this.stockSearch.set('');
    this.api.getKitchenStock().subscribe({
      next: (products) => {
        const availability: Record<number, boolean> = {};
        for (const product of products) {
          if (product.id != null) availability[product.id] = product.is_available !== false;
        }
        this.stockProducts.set(products.filter((product) => product.id != null));
        this.stockOriginal.set({ ...availability });
        this.stockDraft.set({ ...availability });
        this.stockLoading.set(false);
      },
      error: (err) => {
        this.stockError.set(err?.error?.detail || 'Could not load menu stock.');
        this.stockLoading.set(false);
      },
    });
  }

  closeStockModal(): void {
    if (this.stockSaving()) return;
    this.stockModalOpen.set(false);
    this.stockError.set('');
    this.stockSearch.set('');
  }

  setStockAvailability(productId: number, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.stockDraft.update((current) => ({ ...current, [productId]: checked }));
  }

  saveStock(): void {
    if (this.stockSaving()) return;
    const original = this.stockOriginal();
    const draft = this.stockDraft();
    const changes = this.stockProducts()
      .filter((product) => product.id != null && original[product.id] !== draft[product.id])
      .map((product) => ({ product_id: product.id!, is_available: !!draft[product.id!] }));
    if (changes.length === 0) {
      this.closeStockModal();
      return;
    }
    this.stockSaving.set(true);
    this.stockError.set('');
    this.api.updateProductAvailability(changes).subscribe({
      next: (updated) => {
        const updatedById = new Map(updated.filter((item) => item.id != null).map((item) => [item.id!, item]));
        this.stockProducts.update((products) => products.map((product) => {
          const next = updatedById.get(product.id!);
          return next ? { ...product, ...next } : product;
        }));
        this.stockOriginal.set({ ...draft });
        this.stockSaving.set(false);
        this.stockModalOpen.set(false);
        this.showStockNotice(`${changes.length} item${changes.length === 1 ? '' : 's'} updated.`);
      },
      error: (err) => {
        this.stockError.set(err?.error?.detail || 'Could not save menu stock.');
        this.stockSaving.set(false);
      },
    });
  }

  stockImageUrl(product: KitchenStockProduct): string | null {
    return this.api.getProductImageUrl(product);
  }

  hideBrokenStockImage(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
  }

  private showStockNotice(message: string): void {
    this.stockNotice.set(message);
    if (this.stockNoticeTimeoutId) clearTimeout(this.stockNoticeTimeoutId);
    this.stockNoticeTimeoutId = setTimeout(() => {
      this.stockNotice.set('');
      this.stockNoticeTimeoutId = null;
    }, 4500);
  }

  private getOrCreateDeviceKey(): string {
    const existing = localStorage.getItem(DEVICE_KEY_STORAGE_KEY)?.trim();
    if (existing && existing.length >= 16) return existing;
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replaceAll('-', '')
        : `${Date.now()}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_KEY_STORAGE_KEY, generated);
    return generated;
  }

  private sendHeartbeat(): void {
    const selection = this.stationSelection();
    this.api.heartbeatKitchenDevice({
      device_key: this.deviceKey,
      name:
        typeof navigator !== 'undefined' && /\bScanakiKitchen\//i.test(navigator.userAgent)
          ? 'Scanaki Kitchen app'
          : this.viewMode() === 'bar'
            ? 'Bar tablet'
            : 'Kitchen tablet',
      display_route: this.viewMode(),
      station_id: selection === 'all' ? null : selection,
    }).subscribe({
      next: () => {
        this.kdsOnline.set(true);
        this.api.getOrderingStatus().subscribe({
          next: (status) => this.strictFifo.set(status.strict_fifo_kds !== false),
          error: () => {},
        });
      },
      error: () => this.kdsOnline.set(false),
    });
  }

  loadTimerSettings(): void {
    this.api.getKitchenDisplaySettings().subscribe({
      next: (s) => this.timerSettings.set(s),
      error: () => {},
    });
  }

  /** Kitchen time starts only when a paid order is released to production. */
  getKitchenStart(order: Order): string {
    return order.kitchen_released_at || order.created_at;
  }

  /** Elapsed minutes since the supplied queue timestamp (uses live now() for updates). */
  getElapsedMinutes(createdAt: string): number {
    const created = this.parseOrderDate(createdAt);
    if (!created) return 0;
    return (this.now() - created) / 60000;
  }

  /** CSS class for timer-based card color: timer-green, timer-yellow, timer-orange, timer-red. */
  getTimerColorClass(order: Order): string {
    const min = this.getElapsedMinutes(this.getKitchenStart(order));
    const s = this.timerSettings();
    if (min >= (s.red_minutes ?? 15)) return 'timer-red';
    if (min >= (s.orange_minutes ?? 10)) return 'timer-orange';
    if (min >= (s.yellow_minutes ?? 5)) return 'timer-yellow';
    return 'timer-green';
  }

  /** Fill width 0-100% toward red threshold (visual progress of wait time). */
  getTimerBarPercent(order: Order): number {
    const min = this.getElapsedMinutes(this.getKitchenStart(order));
    const cap = this.timerSettings().red_minutes ?? 15;
    if (cap <= 0) return 0;
    return Math.min(100, (min / cap) * 100);
  }

  getTimerBarFillClass(order: Order): string {
    return this.getTimerColorClass(order).replace('timer-', 'timer-fill-');
  }

  /** Format waiting time with seconds (mm:ss or h:mm:ss) so it ticks every second. */
  formatWaitingTime(createdAt: string): string {
    const created = this.parseOrderDate(createdAt);
    if (!created) return '-';
    const totalSeconds = Math.floor((this.now() - created) / 1000);
    if (totalSeconds < 0) return '0:00';
    const s = totalSeconds % 60;
    const m = Math.floor(totalSeconds / 60) % 60;
    const h = Math.floor(totalSeconds / 3600);
    const pad = (n: number) => (n < 10 ? '0' + n : String(n));
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${m}:${pad(s)}`;
  }

  private parseOrderDate(dateString: string): number | null {
    if (!dateString) return null;
    const str =
      dateString.endsWith('Z') || dateString.includes('+') || dateString.includes('-', 10)
        ? dateString
        : dateString + 'Z';
    const date = new Date(str).getTime();
    return isNaN(date) ? null : date;
  }

  openTimerSettingsModal(): void {
    this.timerSettingsForm.set({ ...this.timerSettings() });
    this.timerSettingsModalOpen.set(true);
  }

  closeTimerSettingsModal(): void {
    this.timerSettingsModalOpen.set(false);
  }

  updateTimerFormYellow(v: number): void {
    this.timerSettingsForm.update((f) => ({ ...f, yellow_minutes: Math.max(0, Number(v) || 0) }));
  }
  updateTimerFormOrange(v: number): void {
    this.timerSettingsForm.update((f) => ({ ...f, orange_minutes: Math.max(0, Number(v) || 0) }));
  }
  updateTimerFormRed(v: number): void {
    this.timerSettingsForm.update((f) => ({ ...f, red_minutes: Math.max(0, Number(v) || 0) }));
  }
  updateTimerFormRouting(value: KdsRoutingMode): void {
    this.timerSettingsForm.update((form) => ({
      ...form,
      routing_mode: value === 'kitchen_all' ? 'kitchen_all' : 'split',
    }));
  }

  saveTimerSettings(): void {
    const form = this.timerSettingsForm();
    this.api.updateKitchenDisplaySettings(form).subscribe({
      next: (s) => {
        this.timerSettings.set(s);
        this.closeTimerSettingsModal();
      },
      error: () => {},
    });
  }

  private closeItemStatusDropdown = (e: Event): void => {
    const target = e.target as HTMLElement;
    if (!target.closest('.item-status-control')) {
      if (this.itemStatusDropdownOpen()) {
        this.itemStatusDropdownOpen.set(null);
        this.flushPendingBackgroundRefresh();
      }
    }
  };

  private onFullscreenChange = (): void => {
    this.syncFullscreenState();
    if (this.isFullscreen()) void this.requestScreenWakeLock();
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') void this.requestScreenWakeLock();
  };

  private async requestScreenWakeLock(): Promise<void> {
    if (this.wakeLock || document.visibilityState !== 'visible') return;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
    };
    if (!nav.wakeLock) return;
    try {
      this.wakeLock = await nav.wakeLock.request('screen');
    } catch {
      this.wakeLock = null;
    }
  }

  private async releaseScreenWakeLock(): Promise<void> {
    const lock = this.wakeLock;
    this.wakeLock = null;
    if (!lock) return;
    try {
      await lock.release();
    } catch {
      // Browser already released it while the page was hidden.
    }
  }

  private syncFullscreenState(): void {
    const root = this.kitchenRootRef?.nativeElement;
    const fs = getFullscreenElement();
    this.isFullscreen.set(!!root && fs === root);
  }

  toggleFullscreen(): void {
    if (this.isFullscreen()) {
      void this.exitFullscreenIfActive();
      return;
    }
    const root = this.kitchenRootRef?.nativeElement;
    const target = root ?? document.documentElement;
    const p = requestFullscreenOnElement(target);
    void this.requestScreenWakeLock();
    if (p && typeof (p as Promise<void>).catch === 'function') {
      (p as Promise<void>).catch(() => {});
    }
  }

  private exitFullscreenIfActive(): Promise<void> | void {
    if (!getFullscreenElement()) return;
    const p = exitDocumentFullscreen();
    if (p && typeof (p as Promise<void>).catch === 'function') {
      return (p as Promise<void>).catch(() => {});
    }
    return p;
  }

  loadOrders(options?: { initial?: boolean; background?: boolean }): void {
    const isInitial = options?.initial ?? (!options?.background && !this.initialLoadDone);
    const isBackground = options?.background ?? !isInitial;

    if (isBackground && this.itemStatusDropdownOpen()) {
      this.pendingBackgroundRefresh = true;
      return;
    }
    this.pendingBackgroundRefresh = false;

    if (isInitial) {
      this.loading.set(true);
    }

    this.api.getOrders(false, true).subscribe({
      next: (list) => {
        this.orders.set(list);
        this.lastRefreshAt.set(new Date());
        if (isInitial) {
          this.loading.set(false);
          this.initialLoadDone = true;
        }
      },
      error: () => {
        if (isInitial) {
          this.loading.set(false);
          this.initialLoadDone = true;
        }
      },
    });
  }

  private flushPendingBackgroundRefresh(): void {
    if (!this.pendingBackgroundRefresh) return;
    this.pendingBackgroundRefresh = false;
    this.loadOrders({ background: true });
  }

  toggleSound(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.soundEnabled.set(checked);
    this.audio.setEnabled(checked);
    localStorage.setItem(SOUND_STORAGE_KEY, String(checked));
  }

  getStatusLabel(status: string): string {
    return this.translate.instant('ORDER_STATUS.' + status) || status;
  }

  getItemStatusLabel(status: string): string {
    return this.translate.instant('ITEM_STATUS.' + status) || status;
  }

  hasCustomization(item: OrderItem): boolean {
    if (item?.customization_summary?.trim()) return true;
    const a = item?.customization_answers;
    if (!!a && typeof a === 'object' && Object.keys(a).length > 0) return true;
    if (item?.line_modifiers_summary?.trim()) return true;
    const m = item?.line_modifiers;
    if (!m || typeof m !== 'object') return false;
    return (
      (!!m.remove && m.remove.length > 0) ||
      (!!m.add && m.add.length > 0) ||
      (!!m.substitute && m.substitute.length > 0)
    );
  }

  private formatLineModifiersFromJson(m: OrderLineModifiers | null | undefined): string {
    if (!m) return '';
    const parts: string[] = [];
    if (m.remove?.length) parts.push(`Remove: ${m.remove.join(', ')}`);
    if (m.add?.length) parts.push(`Add: ${m.add.join(', ')}`);
    if (m.substitute?.length) {
      parts.push(`Sub: ${m.substitute.map(s => `${s.from}→${s.to}`).join(', ')}`);
    }
    return parts.join(' · ');
  }

  formatCustomizationItem(item: OrderItem): string {
    const snapQ = item.customization_summary?.trim();
    let c = '';
    if (snapQ) {
      c = snapQ;
    } else {
      const answers = item.customization_answers;
      if (answers && Object.keys(answers).length > 0) {
        const parts: string[] = [];
        for (const v of Object.values(answers)) {
          if (Array.isArray(v)) parts.push(v.join(', '));
          else parts.push(String(v));
        }
        c = parts.join(' · ');
      }
    }
    const snapM = item.line_modifiers_summary?.trim();
    const m = snapM || this.formatLineModifiersFromJson(item.line_modifiers ?? undefined);
    if (c && m) return `${c} · ${m}`;
    return c || m || '';
  }

  /** Items sorted by status; show pending, preparing, and ready (hide delivered/cancelled so paid orders stay until delivered). */
  getSortedItems(items: OrderItem[]): OrderItem[] {
    const order: Record<string, number> = {
      pending: 0,
      preparing: 1,
      ready: 2,
      delivered: 3,
      cancelled: 4,
    };
    const notYetDelivered = [...items].filter(
      (i) => !i.removed_by_customer && (i.status === 'pending' || i.status === 'preparing' || i.status === 'ready')
    );
    return notYetDelivered.sort((a, b) => {
      const aOrder = order[a.status || 'pending'] ?? 5;
      const bOrder = order[b.status || 'pending'] ?? 5;
      return aOrder - bOrder;
    });
  }

  formatOrderTime(dateString: string): string {
    if (!dateString) return '-';
    const dateStr =
      dateString.endsWith('Z') || dateString.includes('+') || dateString.includes('-', 10)
        ? dateString
        : dateString + 'Z';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return '-';
    const diffMs = Date.now() - date.getTime();
    if (diffMs < 60_000) return '< 1m ago';
    if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`;
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  formatExactTime(dateString: string): string {
    if (!dateString) return '';
    const dateStr =
      dateString.endsWith('Z') || dateString.includes('+') || dateString.includes('-', 10)
        ? dateString
        : dateString + 'Z';
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? dateString : date.toLocaleString();
  }

  isOrderPaid(order: Order): boolean {
    return !!order.paid_at || ['succeeded', 'refunded'].includes(order.payment_state || '');
  }

  toggleOrderDetails(orderId: number): void {
    this.expandedOrderDetails.update((current) => {
      const next = new Set(current);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  isOrderDetailsOpen(orderId: number): boolean {
    return this.expandedOrderDetails().has(orderId);
  }

  isOrderActionBusy(orderId: number): boolean {
    return this.orderActionBusy().has(orderId);
  }

  getOrderActionTarget(order: Order): 'preparing' | 'ready' | 'delivered' | null {
    const statuses = (order.items || [])
      .filter((item) => !item.removed_by_customer)
      .map((item) => item.status || 'pending');
    if (statuses.includes('pending')) return 'preparing';
    if (statuses.includes('preparing')) return 'ready';
    if (statuses.includes('ready')) return 'delivered';
    return null;
  }

  getOrderActionLabel(order: Order): string {
    const target = this.getOrderActionTarget(order);
    if (target === 'preparing') return 'Start';
    if (target === 'ready') return 'Ready';
    if (target === 'delivered') return 'Complete';
    return '';
  }

  getOrderActionClass(order: Order): string {
    const target = this.getOrderActionTarget(order);
    if (target === 'ready') return 'order-primary-action order-action-ready';
    if (target === 'delivered') return 'order-primary-action order-action-complete';
    return 'order-primary-action order-action-start';
  }

  advanceOrder(order: Order): void {
    const target = this.getOrderActionTarget(order);
    if (!target || this.isOrderActionBusy(order.id)) return;
    const sourceStatus = target === 'preparing' ? 'pending' : target === 'ready' ? 'preparing' : 'ready';
    const itemIds = (order.items || [])
      .filter(
        (item) =>
          item.id != null &&
          !item.removed_by_customer &&
          (item.status || 'pending') === sourceStatus,
      )
      .map((item) => item.id!);
    if (itemIds.length === 0) return;
    this.orderActionBusy.update((current) => new Set(current).add(order.id));
    forkJoin(itemIds.map((itemId) => this.api.updateOrderItemStatus(order.id, itemId, target))).subscribe({
      next: () => this.finishOrderAction(order.id),
      error: () => this.finishOrderAction(order.id),
    });
  }

  private finishOrderAction(orderId: number): void {
    this.orderActionBusy.update((current) => {
      const next = new Set(current);
      next.delete(orderId);
      return next;
    });
    this.loadOrders({ background: true });
  }

  cleanKitchenNotes(notes?: string | null): string {
    return (notes || '')
      .split(/\r?\n/)
      .filter((line) => !/^\s*\[PAID:/i.test(line))
      .join('\n')
      .trim();
  }

  getItemStatusTransitions(currentStatus: string): { forward: string[]; backward: string[] } {
    const transitions: Record<string, { forward: string[]; backward: string[] }> = {
      pending: { forward: ['preparing'], backward: [] },
      preparing: { forward: ['ready'], backward: ['pending'] },
      ready: { forward: ['delivered'], backward: ['preparing'] },
      delivered: { forward: [], backward: ['ready'] },
      cancelled: { forward: [], backward: [] },
    };
    const key = (currentStatus ?? '').toString().toLowerCase();
    return transitions[key] ?? { forward: [], backward: [] };
  }

  getNextItemStatus(currentStatus: string): string | null {
    return this.getItemStatusTransitions(currentStatus).forward[0] ?? null;
  }

  getPreviousItemStatus(currentStatus: string): string | null {
    return this.getItemStatusTransitions(currentStatus).backward[0] ?? null;
  }

  getKitchenActionLabel(nextStatus: string): string {
    const labels: Record<string, string> = {
      preparing: 'KITCHEN_DISPLAY.ACTION_START',
      ready: 'KITCHEN_DISPLAY.ACTION_READY',
      delivered: 'KITCHEN_DISPLAY.ACTION_COMPLETE',
    };
    return labels[nextStatus] ?? `ITEM_STATUS.${nextStatus}`;
  }

  toggleItemStatusDropdown(orderId: number, itemId: number): void {
    const key = `${orderId}-${itemId}`;
    const wasOpen = this.itemStatusDropdownOpen() === key;
    this.itemStatusDropdownOpen.update((current) => (current === key ? null : key));
    if (wasOpen) {
      this.flushPendingBackgroundRefresh();
    }
  }

  updateItemStatus(orderId: number, itemId: number, status: string): void {
    this.itemStatusDropdownOpen.set(null);
    this.api.updateOrderItemStatus(orderId, itemId, status).subscribe({
      next: () => this.loadOrders({ background: true }),
      error: () => this.loadOrders({ background: true }),
    });
  }
}
