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
  KitchenHeartbeatDiagnosticEvent,
  KitchenStockProduct,
  KitchenStation,
  OperationalLocation,
  Order,
  OrderItem,
  OrderLineModifiers,
} from '../services/api.service';
import { AudioService } from '../services/audio.service';
import { PermissionService } from '../services/permission.service';
import { Subscription } from 'rxjs';
import { FocusFirstInputDirective } from '../shared/focus-first-input.directive';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ScanakiBrandComponent } from '../shared/scanaki-brand.component';

const REFRESH_INTERVAL_MS = 15000;
const ORDER_EVENT_REFRESH_DEBOUNCE_MS = 180;
const HEARTBEAT_INTERVAL_MS = 10000;
const HEARTBEAT_FAILURE_THRESHOLD = 3;
const HEARTBEAT_OFFLINE_AFTER_MS = 25000;
const HEARTBEAT_DIAGNOSTICS_STORAGE_KEY = 'scanaki-kds-heartbeat-diagnostics';
const ORDER_SWIPE_COMPLETE_THRESHOLD = 0.72;
const DEFAULT_ORDER_HOLD_SECONDS = 1;
const DEFAULT_ORDER_COOLDOWN_SECONDS = 2;
const SOUND_STORAGE_KEY = 'kitchen-display-sound';
const DEVICE_KEY_STORAGE_KEY = 'one-table-kds-device-key';
const STATION_STORAGE_PREFIX = 'one-table-kds-station';
const LONG_TICKET_REVIEW_THRESHOLD = 5;
const TICKET_BOTTOM_TOLERANCE_PX = 10;

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
type KitchenOrderStatus = 'pending' | 'preparing' | 'ready' | 'completed';
type KitchenOrderHistoryStatus = KitchenOrderStatus | 'cancelled';
type KitchenDisplaySettings = {
  yellow_minutes: number;
  orange_minutes: number;
  red_minutes: number;
  routing_mode: KdsRoutingMode;
  action_hold_seconds: number;
  action_cooldown_seconds: number;
};

type TicketReviewState = {
  itemCount: number;
  remainingBelow: number;
  hasOverflow: boolean;
  reviewed: boolean;
  measured: boolean;
};

type OrderSwipeState = {
  orderId: number;
  pointerId: number;
  startX: number;
  offsetPx: number;
  maxOffsetPx: number;
  progress: number;
};

type NavigatorWithConnection = Navigator & {
  connection?: { type?: string; effectiveType?: string };
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
  imports: [RouterLink, TranslateModule, FormsModule, FocusFirstInputDirective, ScanakiBrandComponent],
  template: `
    <div class="kitchen-view" #kitchenRoot>
      <header class="kitchen-header">
        <a routerLink="/staff/orders" class="back-link">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15,18 9,12 15,6"/>
          </svg>
          {{ 'KITCHEN_DISPLAY.BACK_TO_ORDERS' | translate }}
        </a>
        <div class="kitchen-title-actions">
          <app-scanaki-brand [size]="34" [showName]="false"></app-scanaki-brand>
          <h1 class="kitchen-title">{{ pageTitle() }}</h1>
          <button
            type="button"
            class="all-orders-btn"
            data-testid="kitchen-all-orders-button"
            (click)="openAllOrdersModal()"
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M3 6h18M3 12h18M3 18h18"/>
            </svg>
            All orders
          </button>
        </div>
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
              <select class="station-filter-select" [ngModel]="locationSelection()" (ngModelChange)="onLocationSelectChange($event)">
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
          <div
            class="order-grid"
            #orderScroller
            data-testid="kitchen-order-scroller"
            (scroll)="scheduleOrderNavigationUpdate()"
          >
            @for (order of activeOrders(); track order.id; let position = $index) {
              <article
                class="order-card production-{{ getProductionStatus(order) }} {{ getTimerColorClass(order) }}"
                [class.order-card-urgent]="order.staff_urgent"
                [attr.data-order-id]="order.id"
              >
                <header class="order-header">
                  <div class="order-sequence">
                    <span class="fifo-position">FIFO {{ position + 1 }}</span>
                    <span class="order-id">#{{ order.id }}</span>
                    <span class="production-status-badge">{{ getProductionStatusLabel(order) }}</span>
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
                <div
                  class="ticket-review-summary"
                  [class.ticket-review-summary-needed]="ticketRequiresReview(order)"
                  [class.ticket-review-summary-complete]="ticketReviewComplete(order)"
                  [attr.data-testid]="'kitchen-ticket-summary-' + order.id"
                >
                  {{ ticketReviewBadge(order) }}
                </div>
                <div
                  class="order-card-scroll"
                  [class.order-card-scroll-needs-review]="ticketRequiresReview(order)"
                  tabindex="0"
                  [attr.aria-label]="'Items and requests for order ' + order.id"
                  [attr.data-order-scroll]="order.id"
                  (scroll)="onTicketScroll(order.id)"
                >
                  <ul class="order-items">
                    @for (item of getSortedItems(order.items); track item.id) {
                      @if (!item.removed_by_customer) {
                        <li class="order-item" [attr.data-item-key]="itemReviewKey(item)">
                          <span class="item-qty">{{ item.quantity }}×</span>
                          <span class="item-copy">
                            <span class="item-name-row">
                              <strong class="item-name">{{ item.product_name }}</strong>
                              @if (isNewOrderItem(order.id, item)) {
                                <span class="item-new-badge">NEW</span>
                              }
                            </span>
                            @if (hasCustomization(item)) {
                              <small class="item-customization">
                                <strong>Modifiers:</strong> {{ formatCustomizationItem(item) }}
                              </small>
                            }
                            @if (item.notes) {
                              <small class="item-notes"><strong>{{ 'KITCHEN_DISPLAY.ITEM_COMMENT' | translate }}:</strong> {{ item.notes }}</small>
                            }
                          </span>
                        </li>
                      }
                    }
                  </ul>
                  @if (cleanKitchenNotes(order.notes); as visibleNotes) {
                    <section
                      class="customer-request"
                      [attr.data-testid]="'kitchen-customer-request-' + order.id"
                    >
                      <strong class="customer-request-label">Customer request</strong>
                      <p>{{ visibleNotes }}</p>
                    </section>
                  }
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
                    </section>
                  }
                </div>
                @if (ticketRequiresReview(order)) {
                  <button
                    type="button"
                    class="ticket-review-more"
                    [attr.data-testid]="'kitchen-review-more-' + order.id"
                    (click)="reviewNextTicketItems(order)"
                  >
                    {{ ticketReviewButtonLabel(order) }}
                  </button>
                }
                <footer class="order-actions">
                  @if (getOrderActionTarget(order)) {
                    @if (ticketRequiresReview(order)) {
                      <button
                        type="button"
                        class="order-primary-action order-action-review"
                        [attr.data-testid]="'kitchen-order-action-' + order.id"
                        (click)="reviewNextTicketItems(order)"
                      >
                        <span class="order-action-label">Review remaining items</span>
                      </button>
                    } @else {
                      <button
                        type="button"
                        class="order-swipe-action"
                        [class]="getOrderSwipeClass(order)"
                        [class.order-swipe-dragging]="isOrderSwipeActive(order.id)"
                        [disabled]="isOrderInteractionDisabled(order.id)"
                        [attr.aria-label]="'Swipe right to ' + getOrderActionLabel(order)"
                        [attr.data-testid]="'kitchen-order-action-' + order.id"
                        (pointerdown)="startOrderSwipe($event, order)"
                        (pointermove)="moveOrderSwipe($event, order)"
                        (pointerup)="finishOrderSwipe($event, order)"
                        (pointercancel)="cancelOrderSwipe(order.id)"
                        (keydown.enter)="activateOrderSwipeFromKeyboard($event, order)"
                        (keydown.space)="activateOrderSwipeFromKeyboard($event, order)"
                        (contextmenu)="$event.preventDefault()"
                      >
                        <span
                          class="order-swipe-fill"
                          [style.width.%]="orderSwipeProgress(order.id) * 100"
                          aria-hidden="true"
                        ></span>
                        <span
                          class="order-swipe-handle"
                          [style.transform]="'translateX(' + orderSwipeOffset(order.id) + 'px)'"
                          aria-hidden="true"
                        >
                          <span class="order-swipe-handle-arrow">→</span>
                        </span>
                        <span class="order-swipe-label">{{ getOrderSwipeLabel(order) }}</span>
                        <span class="order-swipe-hint" aria-hidden="true"><i>›</i><i>›</i><i>›</i></span>
                      </button>
                    }
                  }
                  <button type="button" class="order-details-toggle" (click)="toggleOrderDetails(order.id)" [attr.aria-expanded]="isOrderDetailsOpen(order.id)">
                    {{ isOrderDetailsOpen(order.id) ? 'Show less' : 'Show more' }}
                  </button>
                </footer>
              </article>
            }
          </div>
          <nav class="order-navigation" aria-label="Order ticket navigation" data-testid="kitchen-order-navigation">
            <button
              type="button"
              class="order-navigation-button"
              data-testid="kitchen-orders-left"
              [disabled]="ordersToLeft() === 0"
              [attr.aria-label]="ordersToLeft() + ' order' + (ordersToLeft() === 1 ? '' : 's') + ' to the left'"
              (click)="scrollOrders(-1)"
            >
              <span class="order-navigation-arrow" aria-hidden="true">&#8592;</span>
              <span><strong>{{ ordersToLeft() }}</strong> left</span>
            </button>
            <div class="order-navigation-position" aria-live="polite">
              <strong data-testid="kitchen-visible-order-range">
                {{ visibleOrderStart() }}&ndash;{{ visibleOrderEnd() }}
              </strong>
              <span>of {{ activeOrders().length }} orders</span>
            </div>
            <button
              type="button"
              class="order-navigation-button order-navigation-button-next"
              data-testid="kitchen-orders-right"
              [disabled]="ordersToRight() === 0"
              [attr.aria-label]="ordersToRight() + ' order' + (ordersToRight() === 1 ? '' : 's') + ' to the right'"
              (click)="scrollOrders(1)"
            >
              <span><strong>{{ ordersToRight() }}</strong> right</span>
              <span class="order-navigation-arrow" aria-hidden="true">&#8594;</span>
            </button>
          </nav>
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
      @if (allOrdersModalOpen()) {
        <div class="modal-backdrop history-backdrop" (click)="closeAllOrdersModal()"></div>
        <section
          class="order-history-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="order-history-title"
          data-testid="kitchen-all-orders-modal"
        >
          <header class="order-history-header">
            <div>
              <h2 id="order-history-title">All orders</h2>
              <p>Review active and completed orders, then correct a Kitchen status if needed.</p>
            </div>
            <button type="button" class="history-close" (click)="closeAllOrdersModal()" aria-label="Close all orders">Close</button>
          </header>

          <div class="order-history-toolbar">
            <label>
              <span>Search</span>
              <input
                [ngModel]="orderHistorySearch()"
                (ngModelChange)="orderHistorySearch.set($event)"
                placeholder="Order, table, location or item"
                data-testid="kitchen-order-history-search"
              >
            </label>
            <label>
              <span>Status</span>
              <select [ngModel]="orderHistoryStatusFilter()" (ngModelChange)="orderHistoryStatusFilter.set($event)">
                <option value="all">All statuses</option>
                <option value="pending">New</option>
                <option value="preparing">Preparing</option>
                <option value="ready">Ready</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
            <div class="history-result-count">
              <strong>{{ filteredAllOrders().length }}</strong>
              <span>order{{ filteredAllOrders().length === 1 ? '' : 's' }}</span>
            </div>
          </div>

          @if (orderHistoryNotice()) {
            <p class="history-notice" role="status">{{ orderHistoryNotice() }}</p>
          }
          @if (orderHistoryError()) {
            <p class="history-error" role="alert">{{ orderHistoryError() }}</p>
          }

          <div class="order-history-list">
            @if (filteredAllOrders().length === 0) {
              <div class="history-empty">
                <h3>No orders found</h3>
                <p>Try a different search or status.</p>
              </div>
            } @else {
              @for (order of filteredAllOrders(); track order.id) {
                <article class="history-order-row" [attr.data-order-id]="order.id">
                  <div class="history-order-main">
                    <div class="history-order-heading">
                      <strong>#{{ order.id }}</strong>
                      <span class="history-status status-chip-{{ getProductionStatus(order) }}">
                        {{ getProductionStatusLabel(order) }}
                      </span>
                      <span class="history-payment" [class.history-payment-paid]="isOrderPaid(order)">
                        {{ isOrderPaid(order) ? 'Paid' : 'Not paid' }}
                      </span>
                    </div>
                    <div class="history-destination">
                      <strong>{{ order.service_point_label || order.table_name }}</strong>
                      @if (order.location_name) { <span>{{ order.location_name }}</span> }
                    </div>
                    <p class="history-items">{{ getOrderItemsSummary(order) }}</p>
                    <time [title]="formatExactTime(getKitchenStart(order))">{{ formatOrderTime(getKitchenStart(order)) }}</time>
                  </div>

                  @if (getProductionStatus(order) === 'cancelled') {
                    <div class="history-cancelled-note">Cancelled orders are read-only</div>
                  } @else {
                    <div class="history-status-control">
                      <label>
                        <span>Change Kitchen status</span>
                        <select
                          [ngModel]="getProductionStatus(order)"
                          (ngModelChange)="requestOrderStatusChange(order, $event)"
                          [disabled]="isOrderActionBusy(order.id)"
                          [attr.data-testid]="'kitchen-order-status-select-' + order.id"
                        >
                          <option value="pending">New</option>
                          <option value="preparing">Preparing</option>
                          <option value="ready">Ready</option>
                          <option value="completed">Completed</option>
                        </select>
                      </label>
                      @if (isOrderStatusChangePending(order.id)) {
                        <div class="history-confirm" role="alert">
                          <span>Move order #{{ order.id }} to <strong>{{ pendingOrderStatusLabel() }}</strong>?</span>
                          <div>
                            <button type="button" class="history-cancel" (click)="cancelOrderStatusChange()">Cancel</button>
                            <button
                              type="button"
                              class="history-confirm-btn"
                              data-testid="kitchen-confirm-status-change"
                              (click)="confirmOrderStatusChange(order)"
                            >Confirm</button>
                          </div>
                        </div>
                      }
                    </div>
                  }
                </article>
              }
            }
          </div>
        </section>
      }
    </div>
  `,
  styles: [`
    .kitchen-view {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100vh;
      height: 100dvh;
      min-height: 0;
      overflow: hidden;
      overscroll-behavior: none;
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
      position: sticky;
      top: 0;
      z-index: 30;
      flex: 0 0 auto;
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
      flex: 0 0 auto;
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
      font-size: clamp(1.5rem, 4vw, 2.25rem);
      font-weight: 700;
      color: var(--color-text);
      margin: 0;
    }
    .kitchen-title-actions {
      grid-area: title;
      justify-self: end;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .all-orders-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 44px;
      padding: 0 14px;
      border: 1px solid #d4d4d8;
      border-radius: 10px;
      background: #fff;
      color: #27272a;
      font: inherit;
      font-size: .9rem;
      font-weight: 600;
      white-space: nowrap;
      cursor: pointer;
    }
    .all-orders-btn:hover { border-color: #a1a1aa; background: #fafafa; }
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
      min-height: 0;
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      padding: var(--space-5) var(--space-6) 0;
      overflow: hidden;
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
      display: flex;
      flex-wrap: nowrap;
      gap: 16px;
      align-items: stretch;
      min-width: 0;
      min-height: 0;
      padding: 0 2px 14px;
      overflow-x: auto;
      overflow-y: hidden;
      overscroll-behavior: contain;
      scroll-behavior: smooth;
      scroll-snap-type: x proximity;
      scrollbar-gutter: stable;
    }
    .order-card {
      --ticket-background: #3a3020;
      --ticket-panel: #302719;
      --ticket-border: #8a6829;
      display: flex;
      flex-direction: column;
      flex: 0 0 clamp(320px, 31vw, 430px);
      height: 100%;
      min-width: 320px;
      min-height: 0;
      scroll-snap-align: start;
      background: var(--ticket-background);
      border: 2px solid var(--ticket-border);
      border-left: 6px solid var(--color-warning);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: var(--shadow-md);
    }
    .order-card.production-pending {
      --ticket-background: #3a3020;
      --ticket-panel: #302719;
      --ticket-border: #8a6829;
    }
    .order-card.production-preparing {
      --ticket-background: #1f3a5a;
      --ticket-panel: #182f4a;
      --ticket-border: #3b82f6;
    }
    .order-card.production-ready {
      --ticket-background: #1e4938;
      --ticket-panel: #173a2c;
      --ticket-border: #22c55e;
    }
    .order-navigation {
      z-index: 15;
      display: grid;
      grid-template-columns: minmax(132px, 1fr) auto minmax(132px, 1fr);
      align-items: center;
      gap: 16px;
      min-height: 68px;
      margin-inline: calc(var(--space-6) * -1);
      padding: 10px var(--space-6);
      border-top: 1px solid #343b48;
      background: #11151d;
      box-shadow: 0 -10px 24px rgba(0, 0, 0, .22);
      color: #f8fafc;
    }
    .order-navigation-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      justify-self: start;
      gap: 10px;
      min-width: 132px;
      min-height: 46px;
      padding: 0 16px;
      border: 1px solid #4b5563;
      border-radius: 10px;
      background: #242a35;
      color: #f8fafc;
      font: inherit;
      font-size: .9rem;
      font-weight: 500;
      cursor: pointer;
      touch-action: manipulation;
    }
    .order-navigation-button-next { justify-self: end; }
    .order-navigation-button:hover:not(:disabled) {
      border-color: #64748b;
      background: #303745;
    }
    .order-navigation-button:focus-visible {
      outline: 3px solid rgba(96, 165, 250, .8);
      outline-offset: 2px;
    }
    .order-navigation-button:disabled {
      border-color: #2d3440;
      color: #6b7280;
      background: #181c24;
      cursor: default;
    }
    .order-navigation-button strong {
      font-size: 1.05rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .order-navigation-arrow {
      font-size: 1.45rem;
      line-height: 1;
    }
    .order-navigation-position {
      display: flex;
      align-items: baseline;
      justify-content: center;
      gap: 6px;
      color: #aeb8c7;
      white-space: nowrap;
    }
    .order-navigation-position strong {
      color: #fff;
      font-size: 1.05rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .order-card.production-preparing { border-left-color: #60a5fa; }
    .order-card.production-ready { border-left-color: #4ade80; }
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
    .production-status-badge {
      padding: 4px 8px;
      border: 1px solid rgba(255, 255, 255, .22);
      border-radius: 5px;
      background: rgba(0, 0, 0, .2);
      color: #fff;
      font-size: .7rem;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .order-sequence {
      display: flex;
      align-items: center;
      min-width: 0;
      gap: 10px;
    }
    .order-timer-bar-wrap {
      flex: 0 0 auto;
      padding: 0 16px 12px;
      background: var(--ticket-panel);
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
    .ticket-review-summary {
      flex: 0 0 auto;
      padding: 8px 16px;
      border-bottom: 1px solid var(--ticket-border);
      background: rgba(15, 23, 42, .36);
      color: #cbd5e1;
      font-size: .75rem;
      font-weight: 700;
      letter-spacing: .045em;
      text-align: center;
      text-transform: uppercase;
    }
    .ticket-review-summary-needed {
      border-block-color: #f59e0b;
      background: #78350f;
      color: #fef3c7;
    }
    .ticket-review-summary-complete {
      background: rgba(20, 83, 45, .72);
      color: #dcfce7;
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
      flex: 0 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 14px 16px 10px;
      background: var(--ticket-panel);
    }
    .order-id {
      font-size: 1.2rem;
      font-weight: 700;
      color: #f8fafc;
      white-space: nowrap;
    }
    .order-destination {
      flex: 0 0 auto;
      display: grid;
      min-width: 0;
      gap: 4px;
      padding: 4px 16px 14px;
      background: var(--ticket-panel);
      border-bottom: 1px solid var(--ticket-border);
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
    .order-card-scroll {
      flex: 1 1 auto;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior-x: auto;
      overscroll-behavior-y: contain;
      scrollbar-color: rgba(226, 232, 240, .62) rgba(15, 23, 42, .3);
      scrollbar-gutter: stable;
      scrollbar-width: thin;
      touch-action: auto;
      -webkit-overflow-scrolling: touch;
    }
    .order-card-scroll-needs-review {
      box-shadow: inset 0 -30px 24px -24px rgba(245, 158, 11, .95);
    }
    .order-card-scroll:focus-visible {
      outline: 2px solid #93c5fd;
      outline-offset: -3px;
    }
    .order-card-scroll::-webkit-scrollbar { width: 12px; }
    .order-card-scroll::-webkit-scrollbar-track { background: rgba(15, 23, 42, .3); }
    .order-card-scroll::-webkit-scrollbar-thumb {
      border: 2px solid transparent;
      border-radius: 8px;
      background: rgba(226, 232, 240, .78);
      background-clip: padding-box;
    }
    .order-card-scroll-needs-review::-webkit-scrollbar-thumb { background: #f59e0b; }
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
      border-bottom: 1px solid var(--ticket-border);
    }
    .order-item:last-child { border-bottom: none; }
    .item-qty {
      font-weight: 600;
      color: var(--color-primary);
      font-size: 1.125rem;
    }
    .item-copy { display: grid; min-width: 0; gap: 5px; }
    .item-name-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 9px;
      min-width: 0;
    }
    .item-name {
      overflow-wrap: anywhere;
      color: #f8fafc;
      font-size: 1.125rem;
      font-weight: 600;
      line-height: 1.35;
    }
    .item-new-badge {
      flex: 0 0 auto;
      padding: 3px 7px;
      border: 1px solid #fbbf24;
      border-radius: 5px;
      background: #f59e0b;
      color: #271300;
      font-size: .66rem;
      font-weight: 700;
      letter-spacing: .05em;
      line-height: 1.2;
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
      padding: 6px 8px;
      border-left: 3px solid #60a5fa;
      border-radius: 5px;
      background: rgba(15, 23, 42, .48);
      color: #dbeafe;
      font-size: .88rem;
      line-height: 1.35;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .customer-request {
      margin: 0 16px 12px;
      padding: 10px 12px;
      border: 1px solid #f59e0b;
      border-left-width: 5px;
      border-radius: 8px;
      background: rgba(15, 23, 42, .86);
      color: #f8fafc;
    }
    .customer-request-label {
      display: block;
      margin-bottom: 4px;
      color: #fbbf24;
      font-size: .72rem;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    .customer-request p {
      margin: 0;
      font-size: .94rem;
      font-weight: 600;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .ticket-review-more {
      flex: 0 0 auto;
      min-height: 48px;
      margin: 0;
      border: 0;
      border-top: 1px solid #f59e0b;
      border-bottom: 1px solid #f59e0b;
      background: #92400e;
      box-shadow: 0 -10px 24px rgba(15, 23, 42, .52);
      color: #fff7d6;
      font: inherit;
      font-size: .9rem;
      font-weight: 700;
      letter-spacing: .015em;
      cursor: pointer;
      touch-action: manipulation;
    }
    .ticket-review-more:active { background: #78350f; transform: translateY(1px); }
    .ticket-review-more:focus-visible {
      outline: 3px solid #fde68a;
      outline-offset: -4px;
    }
    .order-actions {
      flex: 0 0 auto;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      padding: 12px 16px 14px;
      border-top: 1px solid var(--ticket-border);
      background: var(--ticket-panel);
    }
    .order-primary-action,
    .order-swipe-action,
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
    .order-primary-action {
      position: relative;
      isolation: isolate;
      overflow: hidden;
      border: 1px solid #2563eb;
      background: #2563eb;
      color: #fff;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
    }
    .order-action-label { position: relative; z-index: 2; pointer-events: none; }
    .order-swipe-action {
      position: relative;
      isolation: isolate;
      overflow: hidden;
      min-height: 60px;
      padding: 0 62px;
      border: 1px solid #3b82f6;
      background: #172033;
      color: #fff;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
    }
    .order-swipe-fill {
      position: absolute;
      z-index: 0;
      inset: 0 auto 0 0;
      width: 0;
      background: rgba(59, 130, 246, .34);
      pointer-events: none;
      transition: width .2s ease-out;
    }
    .order-swipe-dragging .order-swipe-fill { transition: none; }
    .order-swipe-handle {
      position: absolute;
      z-index: 3;
      top: 5px;
      bottom: 5px;
      left: 5px;
      display: grid;
      place-items: center;
      width: 50px;
      border: 1px solid rgba(255, 255, 255, .7);
      border-radius: 8px;
      background: #2563eb;
      box-shadow: 0 4px 12px rgba(0, 0, 0, .28);
      color: #fff;
      font-size: 1.45rem;
      line-height: 1;
      pointer-events: none;
      transition: transform .24s cubic-bezier(.2, .8, .2, 1);
    }
    .order-swipe-dragging .order-swipe-handle { transition: none; }
    .order-swipe-handle-arrow { animation: kitchen-swipe-handle-hint 1.35s ease-in-out infinite; }
    .order-swipe-label {
      position: relative;
      z-index: 2;
      pointer-events: none;
    }
    .order-swipe-hint {
      position: absolute;
      z-index: 2;
      top: 0;
      right: 16px;
      bottom: 0;
      display: flex;
      align-items: center;
      gap: 1px;
      color: rgba(255, 255, 255, .56);
      font-size: 1.35rem;
      pointer-events: none;
    }
    .order-swipe-hint i { font-style: normal; animation: kitchen-swipe-chevron 1.45s ease-in-out infinite; }
    .order-swipe-hint i:nth-child(2) { animation-delay: .14s; }
    .order-swipe-hint i:nth-child(3) { animation-delay: .28s; }
    .order-swipe-action.order-swipe-ready { border-color: #22c55e; }
    .order-swipe-ready .order-swipe-handle { background: #16a34a; }
    .order-swipe-ready .order-swipe-fill { background: rgba(34, 197, 94, .35); }
    .order-swipe-action.order-swipe-complete { border-color: #94a3b8; }
    .order-swipe-complete .order-swipe-handle { background: #475569; }
    .order-swipe-complete .order-swipe-fill { background: rgba(148, 163, 184, .32); }
    @keyframes kitchen-swipe-handle-hint {
      0%, 100% { transform: translateX(0); }
      45% { transform: translateX(7px); }
    }
    @keyframes kitchen-swipe-chevron {
      0%, 100% { opacity: .22; transform: translateX(-3px); }
      50% { opacity: 1; transform: translateX(3px); }
    }
    .order-primary-action.order-action-review {
      border-color: #f59e0b;
      background: #92400e;
      color: #fff7d6;
    }
    .order-primary-action:disabled,
    .order-swipe-action:disabled { cursor: wait; opacity: .55; }
    .order-details-toggle {
      min-width: 102px;
      padding: 0 12px;
      border: 1px solid #64748b;
      background: transparent;
      color: #e2e8f0;
      font-size: .9375rem;
    }
    .order-primary-action:active,.order-details-toggle:active { transform: translateY(1px); }
    .order-details {
      padding: 12px 16px 16px;
      border-top: 1px solid var(--ticket-border);
      background: var(--ticket-panel);
    }
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
      .kitchen-title-actions { align-items: flex-end; flex-direction: column; gap: 7px; }
      .all-orders-btn { min-height: 40px; padding-inline: 11px; }
      .kds-overview { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .kds-clock { grid-column: 1 / -1; border-left: 0; border-bottom: 1px solid var(--color-border); }
      .kds-overview-item { min-height: 48px; padding: 6px 8px; }
      .kds-overview-item:nth-child(2) { border-left: 0; }
      .kds-clock-value { font-size: 1.25rem; }
      .kds-overview-value { font-size: 1.125rem; }
      .header-actions { gap: 10px; }
      .kitchen-main { padding-inline: 12px; }
      .order-card {
        flex-basis: min(86vw, 380px);
        min-width: min(86vw, 320px);
      }
      .order-navigation {
        grid-template-columns: minmax(100px, 1fr) auto minmax(100px, 1fr);
        gap: 8px;
        margin-inline: -12px;
        padding-inline: 12px;
      }
      .order-navigation-button { min-width: 0; padding-inline: 10px; }
      .order-navigation-position { align-items: center; flex-direction: column; gap: 0; font-size: .75rem; }
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
    .history-backdrop { background: rgba(3, 7, 18, .72); }
    .order-history-modal {
      position: fixed;
      inset: 3vh 3vw;
      z-index: 1001;
      display: grid;
      grid-template-rows: auto auto auto minmax(0, 1fr);
      overflow: hidden;
      border: 1px solid #d8dde5;
      border-radius: 16px;
      background: #f6f7f9;
      color: #1f2937;
      box-shadow: 0 24px 80px rgba(0, 0, 0, .38);
    }
    .order-history-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 20px;
      border-bottom: 1px solid #dfe3e8;
      background: #fff;
    }
    .order-history-header h2 { margin: 0; font-size: 1.4rem; }
    .order-history-header p { margin: 4px 0 0; color: #6b7280; font-size: .88rem; }
    .history-close {
      min-height: 40px;
      padding: 0 13px;
      border: 1px solid #d8dde5;
      border-radius: 9px;
      background: #fff;
      color: #374151;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    .order-history-toolbar {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) minmax(170px, 230px) auto;
      align-items: end;
      gap: 14px;
      padding: 12px 20px;
      border-bottom: 1px solid #dfe3e8;
      background: #fff;
    }
    .order-history-toolbar label { display: grid; gap: 5px; color: #6b7280; font-size: .72rem; font-weight: 600; }
    .order-history-toolbar input,
    .order-history-toolbar select,
    .history-status-control select {
      min-height: 44px;
      padding: 0 12px;
      border: 1px solid #ccd2da;
      border-radius: 9px;
      background: #fff;
      color: #111827;
      font: inherit;
    }
    .order-history-toolbar input:focus,
    .order-history-toolbar select:focus,
    .history-status-control select:focus {
      border-color: #d35233;
      outline: 3px solid rgba(211, 82, 51, .14);
    }
    .history-result-count { display: grid; min-width: 76px; padding-bottom: 3px; text-align: right; }
    .history-result-count strong { font-size: 1.15rem; font-variant-numeric: tabular-nums; }
    .history-result-count span { color: #6b7280; font-size: .72rem; }
    .history-notice,
    .history-error { margin: 10px 20px 0; padding: 10px 12px; border-radius: 8px; font-size: .85rem; font-weight: 600; }
    .history-notice { background: #dcfce7; color: #166534; }
    .history-error { background: #fee2e2; color: #991b1b; }
    .order-history-list {
      display: grid;
      align-content: start;
      gap: 10px;
      overflow: auto;
      padding: 14px 20px 20px;
    }
    .history-order-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(260px, 330px);
      gap: 18px;
      padding: 14px 16px;
      border: 1px solid #dfe3e8;
      border-radius: 12px;
      background: #fff;
      box-shadow: 0 1px 2px rgba(15, 23, 42, .04);
    }
    .history-order-main { display: grid; min-width: 0; gap: 6px; }
    .history-order-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
    .history-order-heading>strong { font-size: 1.05rem; font-variant-numeric: tabular-nums; }
    .history-status,
    .history-payment {
      display: inline-flex;
      align-items: center;
      min-height: 25px;
      padding: 0 8px;
      border-radius: 999px;
      background: #f4f4f5;
      color: #52525b;
      font-size: .7rem;
      font-weight: 600;
    }
    .status-chip-pending { background: #fef3c7; color: #92400e; }
    .status-chip-preparing { background: #dbeafe; color: #1d4ed8; }
    .status-chip-ready { background: #dcfce7; color: #166534; }
    .status-chip-completed { background: #e5e7eb; color: #374151; }
    .status-chip-cancelled { background: #fee2e2; color: #991b1b; }
    .history-payment { background: #fee2e2; color: #991b1b; }
    .history-payment-paid { background: #dcfce7; color: #166534; }
    .history-destination { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; }
    .history-destination strong { color: #111827; font-size: .95rem; }
    .history-destination span { color: #6b7280; font-size: .78rem; }
    .history-items {
      display: -webkit-box;
      overflow: hidden;
      margin: 0;
      color: #374151;
      font-size: .83rem;
      line-height: 1.35;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    .history-order-main time { color: #6b7280; font-size: .72rem; }
    .history-status-control { display: grid; align-content: center; gap: 9px; }
    .history-status-control>label { display: grid; gap: 5px; color: #6b7280; font-size: .72rem; font-weight: 600; }
    .history-status-control select { width: 100%; }
    .history-confirm {
      display: grid;
      gap: 9px;
      padding: 10px;
      border: 1px solid #f5b6a7;
      border-radius: 9px;
      background: #fff7ed;
      color: #7c2d12;
      font-size: .78rem;
    }
    .history-confirm>div { display: flex; justify-content: flex-end; gap: 7px; }
    .history-confirm button {
      min-height: 36px;
      padding: 0 11px;
      border-radius: 8px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    .history-cancel { border: 1px solid #d8dde5; background: #fff; color: #374151; }
    .history-confirm-btn { border: 1px solid #c84a2e; background: #c84a2e; color: #fff; }
    .history-cancelled-note { align-self: center; color: #7f1d1d; font-size: .78rem; font-weight: 600; text-align: right; }
    .history-empty { padding: 70px 20px; color: #6b7280; text-align: center; }
    .history-empty h3 { margin: 0; color: #374151; }
    .history-empty p { margin: 5px 0 0; }
    @media (max-width: 760px) {
      .order-history-modal { inset: 0; border: 0; border-radius: 0; }
      .order-history-toolbar { grid-template-columns: 1fr; padding: 10px 12px; }
      .history-result-count { min-width: 0; text-align: left; }
      .order-history-list { padding: 12px; }
      .history-order-row { grid-template-columns: 1fr; gap: 12px; }
      .order-history-header { padding-inline: 12px; }
      .history-cancelled-note { text-align: left; }
    }
  `],
})
export class KitchenDisplayComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('kitchenRoot', { read: ElementRef }) kitchenRootRef?: ElementRef<HTMLElement>;
  @ViewChild('orderScroller', { read: ElementRef }) orderScrollerRef?: ElementRef<HTMLElement>;

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
  private ordersRequestInFlight = false;
  private queuedOrdersRefresh = false;
  private orderEventRefreshTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private stockNoticeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private knownActiveOrderIds = new Set<number>();
  private orderAlertsReady = false;
  private lastOrderAlertAt = 0;
  private orderNavigationFrameId: number | null = null;
  private ticketReviewFrameId: number | null = null;
  private knownTicketItemKeys = new Map<number, Set<string>>();
  private pendingTicketReviewResets = new Set<number>();
  private heartbeatInFlight = false;
  private heartbeatConsecutiveFailures = 0;
  private heartbeatLastSuccessAt = Date.now();
  private pendingHeartbeatDiagnostics: KitchenHeartbeatDiagnosticEvent[] = [];
  private heartbeatDiagnosticsUploadInFlight = false;

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
    action_hold_seconds: DEFAULT_ORDER_HOLD_SECONDS,
    action_cooldown_seconds: DEFAULT_ORDER_COOLDOWN_SECONDS,
  });
  timerSettingsModalOpen = signal(false);
  timerSettingsForm = signal<KitchenDisplaySettings>({
    yellow_minutes: 5,
    orange_minutes: 10,
    red_minutes: 15,
    routing_mode: 'split',
    action_hold_seconds: DEFAULT_ORDER_HOLD_SECONDS,
    action_cooldown_seconds: DEFAULT_ORDER_COOLDOWN_SECONDS,
  });
  private tickIntervalId: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;
  private deviceKey = '';
  private wakeLock: { release: () => Promise<void> } | null = null;
  kdsOnline = signal(true);
  strictFifo = signal(true);
  expandedOrderDetails = signal<Set<number>>(new Set());
  orderActionBusy = signal<Set<number>>(new Set());
  orderSwipe = signal<OrderSwipeState | null>(null);
  allOrdersModalOpen = signal(false);
  orderHistorySearch = signal('');
  orderHistoryStatusFilter = signal<'all' | KitchenOrderHistoryStatus>('all');
  pendingOrderStatusChange = signal<{ orderId: number; status: KitchenOrderStatus } | null>(null);
  orderHistoryNotice = signal('');
  orderHistoryError = signal('');
  ordersToLeft = signal(0);
  ordersToRight = signal(0);
  visibleOrderStart = signal(0);
  visibleOrderEnd = signal(0);
  ticketReviewStates = signal<Record<number, TicketReviewState>>({});
  newTicketItemKeys = signal<Record<number, string[]>>({});

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
  filteredAllOrders = computed(() => {
    const query = this.orderHistorySearch().trim().toLowerCase();
    const statusFilter = this.orderHistoryStatusFilter();
    return [...this.orders()]
      .filter((order) => {
        const productionStatus = this.getProductionStatus(order);
        if (statusFilter !== 'all' && productionStatus !== statusFilter) return false;
        if (!query) return true;
        const itemNames = (order.items || []).map((item) => item.product_name).join(' ');
        const searchable = [
          order.id,
          order.table_name,
          order.service_point_label,
          order.location_name,
          order.customer_name,
          itemNames,
        ]
          .filter((value) => value != null)
          .join(' ')
          .toLowerCase();
        return searchable.includes(query);
      })
      .sort((a, b) => {
        const aTime = new Date(a.kitchen_released_at || a.created_at).getTime();
        const bTime = new Date(b.kitchen_released_at || b.created_at).getTime();
        return bTime - aTime;
      });
  });
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
    this.pendingHeartbeatDiagnostics = this.loadHeartbeatDiagnostics();
    const stored = localStorage.getItem(SOUND_STORAGE_KEY);
    this.soundEnabled.set(stored !== 'false');
    this.audio.setEnabled(this.soundEnabled());
    this.audio.prepare();

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
          if (['new_order', 'items_added'].includes(type)) {
            this.triggerNewOrderAlert();
          }
          this.scheduleOrderEventRefresh();
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
    window.addEventListener('resize', this.onWindowResize);
  }

  ngAfterViewInit(): void {
    this.syncFullscreenState();
    void this.requestScreenWakeLock();
    this.scheduleOrderNavigationUpdate();
    this.scheduleTicketReviewMeasurement();
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
    if (this.orderEventRefreshTimeoutId) {
      clearTimeout(this.orderEventRefreshTimeoutId);
      this.orderEventRefreshTimeoutId = null;
    }
    this.orderSwipe.set(null);
    this.wsSub?.unsubscribe();
    this.routeDataSub?.unsubscribe();
    this.queryParamSub?.unsubscribe();
    document.removeEventListener('click', this.closeItemStatusDropdown);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', this.onFullscreenChange);
    document.removeEventListener('mozfullscreenchange', this.onFullscreenChange);
    document.removeEventListener('MSFullscreenChange', this.onFullscreenChange);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('resize', this.onWindowResize);
    if (this.orderNavigationFrameId != null) {
      window.cancelAnimationFrame(this.orderNavigationFrameId);
      this.orderNavigationFrameId = null;
    }
    if (this.ticketReviewFrameId != null) {
      window.cancelAnimationFrame(this.ticketReviewFrameId);
      this.ticketReviewFrameId = null;
    }
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
    this.resetOrderScroller();
  }

  onLocationSelectChange(value: number | 'all'): void {
    this.locationSelection.set(value);
    this.resetOrderScroller();
  }

  scheduleOrderNavigationUpdate(): void {
    if (this.orderNavigationFrameId != null) return;
    this.orderNavigationFrameId = window.requestAnimationFrame(() => {
      this.orderNavigationFrameId = null;
      this.updateOrderNavigation();
    });
  }

  updateOrderNavigation(): void {
    const scroller = this.orderScrollerRef?.nativeElement;
    if (!scroller) {
      this.ordersToLeft.set(0);
      this.ordersToRight.set(0);
      this.visibleOrderStart.set(0);
      this.visibleOrderEnd.set(0);
      return;
    }

    const cards = Array.from(scroller.querySelectorAll<HTMLElement>('.order-card'));
    if (cards.length === 0) {
      this.ordersToLeft.set(0);
      this.ordersToRight.set(0);
      this.visibleOrderStart.set(0);
      this.visibleOrderEnd.set(0);
      return;
    }

    const viewport = scroller.getBoundingClientRect();
    const tolerance = 8;
    const rects = cards.map((card) => card.getBoundingClientRect());
    const visibleIndexes = rects
      .map((rect, index) => ({ rect, index }))
      .filter(({ rect }) => rect.right > viewport.left + tolerance && rect.left < viewport.right - tolerance)
      .map(({ index }) => index);

    const firstVisible = visibleIndexes[0] ?? 0;
    const lastVisible = visibleIndexes[visibleIndexes.length - 1] ?? firstVisible;
    this.ordersToLeft.set(rects.filter((rect) => rect.left < viewport.left - tolerance).length);
    this.ordersToRight.set(rects.filter((rect) => rect.right > viewport.right + tolerance).length);
    this.visibleOrderStart.set(firstVisible + 1);
    this.visibleOrderEnd.set(lastVisible + 1);
  }

  scrollOrders(direction: -1 | 1): void {
    const scroller = this.orderScrollerRef?.nativeElement;
    if (!scroller) return;
    const firstCard = scroller.querySelector<HTMLElement>('.order-card');
    const cardStep = (firstCard?.getBoundingClientRect().width ?? 320) + 16;
    const pageStep = Math.max(cardStep, scroller.clientWidth * 0.72);
    scroller.scrollBy({ left: direction * pageStep, behavior: 'smooth' });
  }

  itemReviewKey(item: OrderItem): string {
    if (item.id != null) return String(item.id);
    return [
      item.product_name,
      item.quantity,
      item.notes || '',
      item.customization_summary || '',
      item.line_modifiers_summary || '',
    ].join('|');
  }

  isNewOrderItem(orderId: number, item: OrderItem): boolean {
    return (this.newTicketItemKeys()[orderId] || []).includes(this.itemReviewKey(item));
  }

  ticketRequiresReview(order: Order): boolean {
    const state = this.ticketReviewState(order);
    return this.ticketNewItemCount(order.id) > 0 || (state.hasOverflow && !state.reviewed);
  }

  ticketReviewComplete(order: Order): boolean {
    const state = this.ticketReviewState(order);
    return state.hasOverflow && state.reviewed && this.ticketNewItemCount(order.id) === 0;
  }

  ticketReviewBadge(order: Order): string {
    const state = this.ticketReviewState(order);
    const itemWord = state.itemCount === 1 ? 'ITEM' : 'ITEMS';
    const newCount = this.ticketNewItemCount(order.id);
    if (this.ticketRequiresReview(order)) {
      const below = state.remainingBelow > 0
        ? ` – ${state.remainingBelow} MORE BELOW`
        : state.hasOverflow
          ? ' – MORE BELOW'
          : '';
      const added = newCount > 0 ? ` · ${newCount} NEW` : '';
      return `${state.itemCount} ${itemWord}${below}${added}`;
    }
    if (state.hasOverflow && state.reviewed) return `${state.itemCount} ${itemWord} · REVIEWED`;
    return `${state.itemCount} ${itemWord}`;
  }

  ticketReviewButtonLabel(order: Order): string {
    const state = this.ticketReviewState(order);
    if (state.remainingBelow > 0) {
      const word = state.remainingBelow === 1 ? 'item' : 'items';
      return `↓ Review ${state.remainingBelow} more ${word}`;
    }
    const newCount = this.ticketNewItemCount(order.id);
    if (newCount === 0) return '↓ Review remaining details';
    const word = newCount === 1 ? 'item' : 'items';
    return `Review ${newCount} new ${word}`;
  }

  onTicketScroll(_orderId: number): void {
    this.scheduleTicketReviewMeasurement();
  }

  reviewNextTicketItems(order: Order): void {
    const scroller = this.getTicketScroller(order.id);
    const state = this.ticketReviewState(order);
    if (!scroller || !state.hasOverflow || state.remainingBelow === 0) {
      this.markTicketReviewed(order.id);
      return;
    }

    const viewport = scroller.getBoundingClientRect();
    const itemElements = Array.from(scroller.querySelectorAll<HTMLElement>('.order-item'));
    const firstBelow = itemElements.find(
      (item) => item.getBoundingClientRect().bottom > viewport.bottom + 4,
    );
    const desiredStep = Math.max(scroller.clientHeight * 0.72, 96);
    const targetDelta = firstBelow
      ? Math.max(firstBelow.getBoundingClientRect().top - viewport.top - 12, desiredStep)
      : desiredStep;
    scroller.scrollBy({ top: targetDelta, behavior: 'smooth' });
    window.setTimeout(() => this.scheduleTicketReviewMeasurement(), 360);
  }

  private ticketReviewState(order: Order): TicketReviewState {
    const itemCount = this.getSortedItems(order.items || []).length;
    const saved = this.ticketReviewStates()[order.id];
    if (saved && saved.itemCount === itemCount) return saved;
    const estimatedBelow = Math.max(0, itemCount - (LONG_TICKET_REVIEW_THRESHOLD - 1));
    return {
      itemCount,
      remainingBelow: estimatedBelow,
      hasOverflow: itemCount >= LONG_TICKET_REVIEW_THRESHOLD,
      reviewed: itemCount < LONG_TICKET_REVIEW_THRESHOLD,
      measured: false,
    };
  }

  private ticketNewItemCount(orderId: number): number {
    return (this.newTicketItemKeys()[orderId] || []).length;
  }

  private reconcileTicketItemChanges(orders: Order[]): Set<number> {
    const activeOrderIds = new Set(orders.map((order) => order.id));
    const resetReviewOrderIds = new Set<number>();
    const nextNewItems: Record<number, string[]> = {};

    for (const order of orders) {
      const keys = new Set(this.getSortedItems(order.items || []).map((item) => this.itemReviewKey(item)));
      const previous = this.knownTicketItemKeys.get(order.id);
      const retainedNew = (this.newTicketItemKeys()[order.id] || []).filter((key) => keys.has(key));
      const additions = previous ? [...keys].filter((key) => !previous.has(key)) : [];
      const combinedNew = [...new Set([...retainedNew, ...additions])];
      if (combinedNew.length > 0) nextNewItems[order.id] = combinedNew;
      if (additions.length > 0) resetReviewOrderIds.add(order.id);
      this.knownTicketItemKeys.set(order.id, keys);
    }

    for (const orderId of [...this.knownTicketItemKeys.keys()]) {
      if (!activeOrderIds.has(orderId)) this.knownTicketItemKeys.delete(orderId);
    }
    this.newTicketItemKeys.set(nextNewItems);

    if (resetReviewOrderIds.size > 0) {
      this.ticketReviewStates.update((current) => {
        const next = { ...current };
        for (const orderId of resetReviewOrderIds) {
          const order = orders.find((row) => row.id === orderId);
          const itemCount = order ? this.getSortedItems(order.items || []).length : 0;
          next[orderId] = {
            itemCount,
            remainingBelow: Math.max(0, itemCount - (LONG_TICKET_REVIEW_THRESHOLD - 1)),
            hasOverflow: itemCount >= LONG_TICKET_REVIEW_THRESHOLD,
            reviewed: false,
            measured: false,
          };
        }
        return next;
      });
    }

    return resetReviewOrderIds;
  }

  private scheduleTicketReviewMeasurement(resetOrderIds: Set<number> = new Set()): void {
    for (const orderId of resetOrderIds) this.pendingTicketReviewResets.add(orderId);
    if (this.ticketReviewFrameId != null) return;
    this.ticketReviewFrameId = window.requestAnimationFrame(() => {
      this.ticketReviewFrameId = window.requestAnimationFrame(() => {
        this.ticketReviewFrameId = null;
        const resets = new Set(this.pendingTicketReviewResets);
        this.pendingTicketReviewResets.clear();
        for (const orderId of resets) {
          const scroller = this.getTicketScroller(orderId);
          if (scroller) scroller.scrollTop = 0;
        }
        for (const order of this.activeOrders()) this.measureTicketReview(order);
      });
    });
  }

  private measureTicketReview(order: Order): void {
    const scroller = this.getTicketScroller(order.id);
    if (!scroller) return;
    const itemElements = Array.from(scroller.querySelectorAll<HTMLElement>('.order-item'));
    const itemCount = itemElements.length;
    const hasOverflow = scroller.scrollHeight > scroller.clientHeight + TICKET_BOTTOM_TOLERANCE_PX;
    const atBottom =
      !hasOverflow ||
      scroller.scrollTop + scroller.clientHeight >=
        scroller.scrollHeight - TICKET_BOTTOM_TOLERANCE_PX;
    const viewport = scroller.getBoundingClientRect();
    const remainingBelow = hasOverflow
      ? itemElements.filter((item) => item.getBoundingClientRect().bottom > viewport.bottom + 4).length
      : 0;
    const previous = this.ticketReviewStates()[order.id];
    const hasNewItems = this.ticketNewItemCount(order.id) > 0;
    const reviewed = hasOverflow
      ? !!previous?.reviewed || atBottom
      : hasNewItems
        ? !!previous?.reviewed
        : true;
    const nextState: TicketReviewState = {
      itemCount,
      remainingBelow,
      hasOverflow,
      reviewed,
      measured: true,
    };
    if (
      !previous ||
      previous.itemCount !== nextState.itemCount ||
      previous.remainingBelow !== nextState.remainingBelow ||
      previous.hasOverflow !== nextState.hasOverflow ||
      previous.reviewed !== nextState.reviewed ||
      previous.measured !== nextState.measured
    ) {
      this.ticketReviewStates.update((current) => ({ ...current, [order.id]: nextState }));
    }
    if (atBottom && hasOverflow && hasNewItems) this.clearNewItemMarkers(order.id);
  }

  private markTicketReviewed(orderId: number): void {
    const previous = this.ticketReviewStates()[orderId];
    if (previous) {
      this.ticketReviewStates.update((current) => ({
        ...current,
        [orderId]: { ...previous, remainingBelow: 0, reviewed: true, measured: true },
      }));
    }
    this.clearNewItemMarkers(orderId);
    this.vibrate([45]);
  }

  private clearNewItemMarkers(orderId: number): void {
    if (!(this.newTicketItemKeys()[orderId] || []).length) return;
    this.newTicketItemKeys.update((current) => {
      const next = { ...current };
      delete next[orderId];
      return next;
    });
  }

  private getTicketScroller(orderId: number): HTMLElement | null {
    return (
      this.kitchenRootRef?.nativeElement.querySelector<HTMLElement>(
        `[data-order-scroll="${orderId}"]`,
      ) ?? null
    );
  }

  private resetOrderScroller(): void {
    window.requestAnimationFrame(() => {
      const scroller = this.orderScrollerRef?.nativeElement;
      if (scroller) scroller.scrollLeft = 0;
      this.scheduleOrderNavigationUpdate();
      this.scheduleTicketReviewMeasurement();
    });
  }

  private onWindowResize = (): void => {
    this.scheduleOrderNavigationUpdate();
    this.scheduleTicketReviewMeasurement();
  };

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
    if (this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    const startedAt = Date.now();
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
      next: (response) => {
        this.heartbeatInFlight = false;
        const durationMs = Date.now() - startedAt;
        if (this.heartbeatConsecutiveFailures > 0) {
          this.recordHeartbeatDiagnostic({
            source: 'web',
            outcome: 'recovered',
            occurred_at: new Date().toISOString(),
            status_code: 200,
            duration_ms: durationMs,
            consecutive_failures: this.heartbeatConsecutiveFailures,
            network_type: this.currentBrowserNetworkType(),
            network_validated: typeof navigator === 'undefined' ? null : navigator.onLine,
            detail: response.server_gap_seconds
              ? `Heartbeat recovered after a server-observed gap of ${response.server_gap_seconds}s.`
              : 'Heartbeat recovered.',
          });
        }
        this.heartbeatConsecutiveFailures = 0;
        this.heartbeatLastSuccessAt = Date.now();
        this.kdsOnline.set(true);
        this.flushHeartbeatDiagnostics();
        this.api.getOrderingStatus().subscribe({
          next: (status) => this.strictFifo.set(status.strict_fifo_kds !== false),
          error: () => {},
        });
      },
      error: (error: unknown) => {
        this.heartbeatInFlight = false;
        this.heartbeatConsecutiveFailures += 1;
        const httpError = error as { status?: number; name?: string; message?: string };
        const statusCode = Number.isFinite(httpError?.status) ? Number(httpError.status) : null;
        const elapsedSinceSuccess = Date.now() - this.heartbeatLastSuccessAt;
        const outcome = statusCode === 401 || statusCode === 403 ? 'auth_failure' : 'failure';
        this.recordHeartbeatDiagnostic({
          source: 'web',
          outcome,
          occurred_at: new Date().toISOString(),
          status_code: statusCode,
          duration_ms: Date.now() - startedAt,
          consecutive_failures: this.heartbeatConsecutiveFailures,
          network_type: this.currentBrowserNetworkType(),
          network_validated: typeof navigator === 'undefined' ? null : navigator.onLine,
          detail: `${httpError?.name || 'HeartbeatError'}: ${httpError?.message || 'Request failed'}`,
        });
        if (
          this.heartbeatConsecutiveFailures >= HEARTBEAT_FAILURE_THRESHOLD &&
          elapsedSinceSuccess >= HEARTBEAT_OFFLINE_AFTER_MS
        ) {
          this.kdsOnline.set(false);
        }
      },
    });
  }

  private currentBrowserNetworkType(): string | null {
    if (typeof navigator === 'undefined') return null;
    const connection = (navigator as NavigatorWithConnection).connection;
    return connection?.type || connection?.effectiveType || (navigator.onLine ? 'online' : 'offline');
  }

  private loadHeartbeatDiagnostics(): KitchenHeartbeatDiagnosticEvent[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(HEARTBEAT_DIAGNOSTICS_STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.slice(-50) : [];
    } catch {
      return [];
    }
  }

  private recordHeartbeatDiagnostic(event: KitchenHeartbeatDiagnosticEvent): void {
    this.pendingHeartbeatDiagnostics = [...this.pendingHeartbeatDiagnostics, event].slice(-50);
    try {
      localStorage.setItem(
        HEARTBEAT_DIAGNOSTICS_STORAGE_KEY,
        JSON.stringify(this.pendingHeartbeatDiagnostics),
      );
    } catch {
      // In-memory diagnostics still upload after recovery when storage is unavailable.
    }
    if (event.outcome !== 'recovered') {
      console.warn('Scanaki KDS heartbeat diagnostic', event);
    }
  }

  private flushHeartbeatDiagnostics(): void {
    if (this.heartbeatDiagnosticsUploadInFlight || this.pendingHeartbeatDiagnostics.length === 0) return;
    const sending = this.pendingHeartbeatDiagnostics.slice(0, 50);
    this.heartbeatDiagnosticsUploadInFlight = true;
    this.api.recordKitchenHeartbeatDiagnostics(this.deviceKey, sending).subscribe({
      next: () => {
        this.heartbeatDiagnosticsUploadInFlight = false;
        this.pendingHeartbeatDiagnostics = this.pendingHeartbeatDiagnostics.slice(sending.length);
        try {
          localStorage.setItem(
            HEARTBEAT_DIAGNOSTICS_STORAGE_KEY,
            JSON.stringify(this.pendingHeartbeatDiagnostics),
          );
        } catch {
          // The server already has the diagnostic batch.
        }
        if (this.pendingHeartbeatDiagnostics.length > 0) this.flushHeartbeatDiagnostics();
      },
      error: () => {
        this.heartbeatDiagnosticsUploadInFlight = false;
      },
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
    if (this.ordersRequestInFlight) {
      this.queuedOrdersRefresh = true;
      return;
    }
    this.pendingBackgroundRefresh = false;
    this.ordersRequestInFlight = true;

    if (isInitial) {
      this.loading.set(true);
    }

    this.api.getKitchenOrders().subscribe({
      next: (list) => {
        this.orders.set(list);
        const resetReviewOrderIds = this.reconcileTicketItemChanges(this.activeOrders());
        this.scheduleTicketReviewMeasurement(resetReviewOrderIds);
        this.scheduleOrderNavigationUpdate();
        const activeIds = new Set(this.activeOrders().map((order) => order.id));
        if (
          this.orderAlertsReady &&
          [...activeIds].some((id) => !this.knownActiveOrderIds.has(id)) &&
          Date.now() - this.lastOrderAlertAt > 3500
        ) {
          this.triggerNewOrderAlert();
        }
        this.knownActiveOrderIds = activeIds;
        this.orderAlertsReady = true;
        this.lastRefreshAt.set(new Date());
        if (isInitial) {
          this.loading.set(false);
          this.initialLoadDone = true;
        }
        this.finishOrdersRequest();
      },
      error: () => {
        if (isInitial) {
          this.loading.set(false);
          this.initialLoadDone = true;
        }
        this.finishOrdersRequest();
      },
    });
  }

  private scheduleOrderEventRefresh(): void {
    if (this.orderEventRefreshTimeoutId) clearTimeout(this.orderEventRefreshTimeoutId);
    this.orderEventRefreshTimeoutId = setTimeout(() => {
      this.orderEventRefreshTimeoutId = null;
      this.loadOrders({ background: true });
    }, ORDER_EVENT_REFRESH_DEBOUNCE_MS);
  }

  private finishOrdersRequest(): void {
    this.ordersRequestInFlight = false;
    if (!this.queuedOrdersRefresh) return;
    this.queuedOrdersRefresh = false;
    this.loadOrders({ background: true });
  }

  openAllOrdersModal(): void {
    this.allOrdersModalOpen.set(true);
    this.orderHistorySearch.set('');
    this.orderHistoryStatusFilter.set('all');
    this.pendingOrderStatusChange.set(null);
    this.orderHistoryNotice.set('');
    this.orderHistoryError.set('');
    this.loadOrders({ background: true });
  }

  closeAllOrdersModal(): void {
    this.allOrdersModalOpen.set(false);
    this.pendingOrderStatusChange.set(null);
    this.orderHistoryNotice.set('');
    this.orderHistoryError.set('');
  }

  getProductionStatus(order: Order): KitchenOrderHistoryStatus {
    if (order.status === 'cancelled') return 'cancelled';
    const statuses = (order.items || [])
      .filter(
        (item) =>
          !item.removed_by_customer &&
          item.status !== 'cancelled',
      )
      .map((item) => item.status || 'pending');
    if (statuses.includes('pending')) return 'pending';
    if (statuses.includes('preparing')) return 'preparing';
    if (statuses.includes('ready')) return 'ready';
    if (statuses.length > 0 && statuses.every((status) => status === 'delivered')) return 'completed';
    if (order.status === 'completed') return 'completed';
    if (order.status === 'ready') return 'ready';
    if (order.status === 'preparing') return 'preparing';
    return 'pending';
  }

  getProductionStatusLabel(order: Order): string {
    return this.kitchenOrderStatusLabel(this.getProductionStatus(order));
  }

  getOrderItemsSummary(order: Order): string {
    const items = (order.items || [])
      .filter((item) => !item.removed_by_customer && item.status !== 'cancelled')
      .map((item) => `${item.quantity}× ${item.product_name}`);
    return items.length ? items.join(' · ') : 'No active items';
  }

  requestOrderStatusChange(order: Order, status: KitchenOrderStatus): void {
    if (!['pending', 'preparing', 'ready', 'completed'].includes(status)) return;
    if (this.getProductionStatus(order) === status) {
      this.pendingOrderStatusChange.set(null);
      return;
    }
    this.orderHistoryNotice.set('');
    this.orderHistoryError.set('');
    this.pendingOrderStatusChange.set({ orderId: order.id, status });
  }

  isOrderStatusChangePending(orderId: number): boolean {
    return this.pendingOrderStatusChange()?.orderId === orderId;
  }

  pendingOrderStatusLabel(): string {
    const pending = this.pendingOrderStatusChange();
    return pending ? this.kitchenOrderStatusLabel(pending.status) : '';
  }

  cancelOrderStatusChange(): void {
    this.pendingOrderStatusChange.set(null);
  }

  confirmOrderStatusChange(order: Order): void {
    const pending = this.pendingOrderStatusChange();
    if (
      !pending ||
      pending.orderId !== order.id ||
      this.isOrderActionBusy(order.id)
    ) return;
    const itemStatus = pending.status === 'completed' ? 'delivered' : pending.status;
    const label = this.kitchenOrderStatusLabel(pending.status);
    this.orderActionBusy.update((current) => new Set(current).add(order.id));
    this.orderHistoryError.set('');
    this.api.updateOrderKitchenStatus(order.id, itemStatus).subscribe({
      next: () => {
        this.pendingOrderStatusChange.set(null);
        this.orderHistoryNotice.set(`Order #${order.id} moved to ${label}. Payment status was not changed.`);
        this.completeOrderStatusFeedback();
        this.finishOrderAction(order.id);
      },
      error: (err) => {
        this.pendingOrderStatusChange.set(null);
        this.orderHistoryError.set(err?.error?.detail || `Could not update order #${order.id}.`);
        this.orderActionBusy.update((current) => {
          const next = new Set(current);
          next.delete(order.id);
          return next;
        });
      },
    });
  }

  private kitchenOrderStatusLabel(status: KitchenOrderHistoryStatus): string {
    const labels: Record<KitchenOrderHistoryStatus, string> = {
      pending: 'New',
      preparing: 'Preparing',
      ready: 'Ready',
      completed: 'Completed',
      cancelled: 'Cancelled',
    };
    return labels[status];
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
    if (checked) this.audio.playKitchenStatusConfirmed();
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

  getOrderSwipeLabel(order: Order): string {
    if (this.isOrderActionBusy(order.id)) return 'Updating...';
    if (this.orderSwipeProgress(order.id) >= ORDER_SWIPE_COMPLETE_THRESHOLD) {
      return `Release to ${this.getOrderActionLabel(order)}`;
    }
    return `Swipe to ${this.getOrderActionLabel(order)}`;
  }

  isOrderSwipeActive(orderId: number): boolean {
    return this.orderSwipe()?.orderId === orderId;
  }

  orderSwipeProgress(orderId: number): number {
    const swipe = this.orderSwipe();
    return swipe?.orderId === orderId ? swipe.progress : 0;
  }

  orderSwipeOffset(orderId: number): number {
    const swipe = this.orderSwipe();
    return swipe?.orderId === orderId ? swipe.offsetPx : 0;
  }

  isOrderInteractionDisabled(orderId: number): boolean {
    return (
      this.isOrderActionBusy(orderId) ||
      !this.canUpdateItemStatus()
    );
  }

  startOrderSwipe(event: PointerEvent, order: Order): void {
    if (this.ticketRequiresReview(order)) {
      this.reviewNextTicketItems(order);
      return;
    }
    if (event.button !== 0 || this.isOrderInteractionDisabled(order.id)) return;
    event.preventDefault();
    const control = event.currentTarget as HTMLElement | null;
    const maxOffsetPx = Math.max(1, (control?.clientWidth || 1) - 60);
    try {
      control?.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is an enhancement; pointer-up still safely validates progress.
    }
    this.orderSwipe.set({
      orderId: order.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      offsetPx: 0,
      maxOffsetPx,
      progress: 0,
    });
  }

  moveOrderSwipe(event: PointerEvent, order: Order): void {
    const swipe = this.orderSwipe();
    if (!swipe || swipe.orderId !== order.id || swipe.pointerId !== event.pointerId) return;
    event.preventDefault();
    const offsetPx = Math.max(0, Math.min(swipe.maxOffsetPx, event.clientX - swipe.startX));
    this.orderSwipe.set({
      ...swipe,
      offsetPx,
      progress: Math.max(0, Math.min(1, offsetPx / swipe.maxOffsetPx)),
    });
  }

  finishOrderSwipe(event: PointerEvent, order: Order): void {
    const swipe = this.orderSwipe();
    if (!swipe || swipe.orderId !== order.id || swipe.pointerId !== event.pointerId) return;
    event.preventDefault();
    const offsetPx = Math.max(0, Math.min(swipe.maxOffsetPx, event.clientX - swipe.startX));
    const progress = Math.max(0, Math.min(1, offsetPx / swipe.maxOffsetPx));
    try {
      (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture may already have been released by Android WebView.
    }
    this.orderSwipe.set(null);
    if (progress >= ORDER_SWIPE_COMPLETE_THRESHOLD) {
      this.vibrate([45]);
      this.advanceOrder(order);
    }
  }

  cancelOrderSwipe(orderId: number): void {
    if (this.orderSwipe()?.orderId === orderId) this.orderSwipe.set(null);
  }

  activateOrderSwipeFromKeyboard(event: Event, order: Order): void {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.repeat || this.isOrderInteractionDisabled(order.id)) return;
    keyboardEvent.preventDefault();
    if (this.ticketRequiresReview(order)) this.reviewNextTicketItems(order);
    else this.advanceOrder(order);
  }

  getOrderSwipeClass(order: Order): string {
    const target = this.getOrderActionTarget(order);
    if (target === 'ready') return 'order-swipe-action order-swipe-ready';
    if (target === 'delivered') return 'order-swipe-action order-swipe-complete';
    return 'order-swipe-action order-swipe-start';
  }

  advanceOrder(order: Order): void {
    if (this.ticketRequiresReview(order)) {
      this.reviewNextTicketItems(order);
      return;
    }
    const target = this.getOrderActionTarget(order);
    if (!target || this.isOrderInteractionDisabled(order.id)) return;
    const sourceStatus = target === 'preparing' ? 'pending' : target === 'ready' ? 'preparing' : 'ready';
    const hasMatchingItems = (order.items || []).some(
      (item) => !item.removed_by_customer && (item.status || 'pending') === sourceStatus,
    );
    if (!hasMatchingItems) return;
    this.orderActionBusy.update((current) => new Set(current).add(order.id));
    this.api.updateOrderKitchenStatus(order.id, target).subscribe({
      next: () => {
        this.completeOrderStatusFeedback();
        this.finishOrderAction(order.id);
      },
      error: () => {
        this.showStockNotice(`Could not update order #${order.id}. Please try again.`);
        this.finishOrderAction(order.id);
      },
    });
  }

  private completeOrderStatusFeedback(): void {
    if (this.soundEnabled()) this.audio.playKitchenStatusConfirmed();
    this.vibrate([90, 45, 150]);
  }

  private triggerNewOrderAlert(): void {
    if (Date.now() - this.lastOrderAlertAt < 1500) return;
    this.lastOrderAlertAt = Date.now();
    if (this.soundEnabled()) this.audio.playKitchenNewOrderAlert();
    this.vibrate([260, 120, 260, 120, 420]);
  }

  private vibrate(pattern: number[]): void {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(pattern);
      }
    } catch {
      // Vibration is optional on browsers/tablets that do not expose it.
    }
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
      next: () => {
        this.completeOrderStatusFeedback();
        this.loadOrders({ background: true });
      },
      error: () => this.loadOrders({ background: true }),
    });
  }
}
