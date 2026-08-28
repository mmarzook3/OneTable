import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { KitchenDisplayComponent } from './kitchen-display.component';
import { ApiService } from '../services/api.service';
import { AudioService } from '../services/audio.service';
import { PermissionService } from '../services/permission.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { RouterTestingModule } from '@angular/router/testing';
import { of, throwError } from 'rxjs';

describe('KitchenDisplayComponent', () => {
  let orderUpdates$: Subject<unknown>;
  let mockApi: {
    getOrders: jasmine.Spy;
    connectWebSocket: jasmine.Spy;
    orderUpdates$: Subject<unknown>;
    getCurrentUser: jasmine.Spy;
    getKitchenStations: jasmine.Spy;
    getOperationalLocations: jasmine.Spy;
    getKitchenDisplaySettings: jasmine.Spy;
    updateKitchenDisplaySettings: jasmine.Spy;
    heartbeatKitchenDevice: jasmine.Spy;
    recordKitchenHeartbeatDiagnostics: jasmine.Spy;
    getOrderingStatus: jasmine.Spy;
    getKitchenStock: jasmine.Spy;
    updateProductAvailability: jasmine.Spy;
    getProductImageUrl: jasmine.Spy;
    updateOrderItemStatus: jasmine.Spy;
    updateOrderKitchenStatus: jasmine.Spy;
  };
  let mockAudio: {
    setEnabled: jasmine.Spy;
    prepare: jasmine.Spy;
    playRestaurantOrderChange: jasmine.Spy;
    playKitchenNewOrderAlert: jasmine.Spy;
    playKitchenStatusConfirmed: jasmine.Spy;
  };

  beforeEach(async () => {
    orderUpdates$ = new Subject<unknown>();
    mockApi = {
      getOrders: jasmine.createSpy('getOrders').and.returnValue(of([])),
      connectWebSocket: jasmine.createSpy('connectWebSocket'),
      orderUpdates$,
      getCurrentUser: jasmine.createSpy('getCurrentUser').and.returnValue({ id: 1, role: 'kitchen' }),
      getKitchenStations: jasmine.createSpy('getKitchenStations').and.returnValue(of([])),
      getOperationalLocations: jasmine.createSpy('getOperationalLocations').and.returnValue(of([])),
      getKitchenDisplaySettings: jasmine
        .createSpy('getKitchenDisplaySettings')
        .and.returnValue(of({
          yellow_minutes: 5,
          orange_minutes: 10,
          red_minutes: 15,
          routing_mode: 'split',
          action_hold_seconds: 1,
          action_cooldown_seconds: 2,
        })),
      updateKitchenDisplaySettings: jasmine.createSpy('updateKitchenDisplaySettings').and.returnValue(
        of({
          yellow_minutes: 5,
          orange_minutes: 10,
          red_minutes: 15,
          routing_mode: 'split',
          action_hold_seconds: 1,
          action_cooldown_seconds: 2,
        }),
      ),
      heartbeatKitchenDevice: jasmine.createSpy('heartbeatKitchenDevice').and.returnValue(of({ status: 'ok' })),
      recordKitchenHeartbeatDiagnostics: jasmine
        .createSpy('recordKitchenHeartbeatDiagnostics')
        .and.returnValue(of({ status: 'recorded', count: 1 })),
      getOrderingStatus: jasmine.createSpy('getOrderingStatus').and.returnValue(of({ strict_fifo_kds: true })),
      getKitchenStock: jasmine.createSpy('getKitchenStock').and.returnValue(of([])),
      updateProductAvailability: jasmine.createSpy('updateProductAvailability').and.returnValue(of([])),
      getProductImageUrl: jasmine.createSpy('getProductImageUrl').and.returnValue(null),
      updateOrderItemStatus: jasmine.createSpy('updateOrderItemStatus').and.returnValue(of({ status: 'ok' })),
      updateOrderKitchenStatus: jasmine.createSpy('updateOrderKitchenStatus').and.returnValue(of({ status: 'ok' })),
    };
    mockAudio = {
      setEnabled: jasmine.createSpy('setEnabled'),
      prepare: jasmine.createSpy('prepare'),
      playRestaurantOrderChange: jasmine.createSpy('playRestaurantOrderChange'),
      playKitchenNewOrderAlert: jasmine.createSpy('playKitchenNewOrderAlert'),
      playKitchenStatusConfirmed: jasmine.createSpy('playKitchenStatusConfirmed'),
    };
    localStorage.removeItem('scanaki-kds-heartbeat-diagnostics');

    await TestBed.configureTestingModule({
      imports: [
        KitchenDisplayComponent,
        TranslateModule.forRoot(),
        RouterTestingModule.withRoutes([{ path: 'orders', children: [] }]),
      ],
      providers: [
        { provide: ApiService, useValue: mockApi },
        { provide: AudioService, useValue: mockAudio },
        {
          provide: PermissionService,
          useValue: {
            getCurrentUser: () => ({ id: 1, role: 'kitchen' }),
            hasPermission: (_user: unknown, permission: string) =>
              ['product:availability', 'order:item_status'].includes(permission),
          },
        },
      ],
    }).compileComponents();

    const translate = TestBed.inject(TranslateService);
    translate.setDefaultLang('en');
    translate.use('en');
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should load orders on init', () => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    expect(mockApi.getOrders).toHaveBeenCalledWith(false, true, true);
  });

  it('should connect WebSocket on init', () => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    expect(mockApi.connectWebSocket).toHaveBeenCalled();
  });

  it('should set audio enabled from localStorage on init', () => {
    spyOn(localStorage, 'getItem').and.returnValue('false');
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    expect(mockAudio.setEnabled).toHaveBeenCalledWith(false);
  });

  it('should play sound when WebSocket emits new_order and sound is enabled', () => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    expect(mockAudio.playKitchenNewOrderAlert).not.toHaveBeenCalled();
    orderUpdates$.next({ type: 'new_order' });
    expect(mockAudio.playKitchenNewOrderAlert).toHaveBeenCalled();
  });

  it('should not play sound when sound is disabled and WebSocket emits', () => {
    spyOn(localStorage, 'getItem').and.returnValue('false');
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    mockAudio.playKitchenNewOrderAlert.calls.reset();
    orderUpdates$.next({ type: 'new_order' });
    expect(mockAudio.playKitchenNewOrderAlert).not.toHaveBeenCalled();
  });

  it('should refresh orders when WebSocket emits', fakeAsync(() => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    mockApi.getOrders.calls.reset();
    orderUpdates$.next({ type: 'items_added' });
    expect(mockApi.getOrders).not.toHaveBeenCalled();
    tick(180);
    expect(mockApi.getOrders).toHaveBeenCalledWith(false, true, true);
    fixture.destroy();
  }));

  it('should coalesce a 30-order WebSocket burst into one refresh and one alert', fakeAsync(() => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    mockApi.getOrders.calls.reset();
    mockAudio.playKitchenNewOrderAlert.calls.reset();

    for (let index = 0; index < 30; index += 1) {
      orderUpdates$.next({ type: 'new_order', order_id: 5000 + index });
    }

    expect(mockApi.getOrders).not.toHaveBeenCalled();
    expect(mockAudio.playKitchenNewOrderAlert).toHaveBeenCalledTimes(1);
    tick(180);
    expect(mockApi.getOrders).toHaveBeenCalledTimes(1);
    fixture.destroy();
  }));

  it('should filter to orders that have at least one pending or preparing item', () => {
    const orders = [
      {
        id: 1,
        status: 'pending',
        table_name: 'T1',
        created_at: new Date().toISOString(),
        items: [
          {
            id: 1,
            product_name: 'Coffee',
            quantity: 1,
            status: 'pending',
            price_cents: 100,
            category: 'Main Course',
          },
        ],
        total_cents: 100,
      },
      {
        id: 2,
        status: 'pending',
        table_name: 'T2',
        created_at: new Date().toISOString(),
        items: [
          {
            id: 2,
            product_name: 'Tea',
            quantity: 1,
            status: 'ready',
            price_cents: 80,
            category: 'Beverages',
          },
        ],
        total_cents: 80,
      },
      { id: 3, status: 'completed', table_name: 'T3', created_at: new Date().toISOString(), items: [], total_cents: 0 },
    ];
    mockApi.getOrders.and.returnValue(of(orders));
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.activeOrders().length).toBe(1);
    expect(fixture.componentInstance.activeOrders()[0].id).toBe(1);
  });

  it('should keep a long ticket inside its own scroll region', () => {
    const items = Array.from({ length: 15 }, (_, index) => ({
      id: 1000 + index,
      product_name: `Kitchen item ${index + 1}`,
      quantity: 1,
      status: 'pending',
      price_cents: 500,
      category: 'Main Course',
    }));
    mockApi.getOrders.and.returnValue(of([{
      id: 67,
      status: 'paid',
      table_name: 'Indoor Table 1',
      created_at: new Date().toISOString(),
      paid_at: new Date().toISOString(),
      items,
      total_cents: 7500,
    }]));

    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();

    const ticketScroll = fixture.nativeElement.querySelector('.order-card-scroll') as HTMLElement;
    const ticketActions = fixture.nativeElement.querySelector('.order-actions') as HTMLElement;
    const orderGrid = fixture.nativeElement.querySelector('.order-grid') as HTMLElement;

    expect(ticketScroll).withContext('long-ticket scroll region').not.toBeNull();
    expect(ticketScroll.querySelectorAll('.order-item').length).toBe(15);
    expect(ticketScroll.contains(ticketActions)).toBeFalse();
    expect(getComputedStyle(ticketScroll).overflowY).toBe('auto');
    expect(getComputedStyle(ticketScroll).touchAction).toBe('auto');
    expect(getComputedStyle(ticketScroll).overscrollBehaviorX).toBe('auto');
    expect(getComputedStyle(orderGrid).overflowY).toBe('hidden');
    expect(fixture.nativeElement.querySelector('.ticket-review-summary').textContent).toContain('15 ITEMS');
    expect(fixture.nativeElement.querySelector('.ticket-review-more')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.order-primary-action').textContent).toContain(
      'Review remaining items',
    );

    fixture.componentInstance.ticketReviewStates.set({
      67: {
        itemCount: 15,
        remainingBelow: 0,
        hasOverflow: true,
        reviewed: true,
        measured: true,
      },
    });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.ticket-review-summary').textContent).toContain(
      'REVIEWED',
    );
    expect(fixture.nativeElement.querySelector('.ticket-review-more')).toBeNull();
    expect(fixture.nativeElement.querySelector('.order-primary-action').textContent).toContain(
      'Hold to Start',
    );
  });

  it('should mark later additions as new and require acknowledgement', () => {
    const baseOrder = {
      id: 68,
      status: 'paid',
      table_name: 'Indoor Table 2',
      created_at: new Date().toISOString(),
      paid_at: new Date().toISOString(),
      items: [
        { id: 2001, product_name: 'Pie', quantity: 1, status: 'pending', price_cents: 1200, category: 'Main Course' },
        { id: 2002, product_name: 'Chips', quantity: 1, status: 'pending', price_cents: 400, category: 'Main Course' },
      ],
      total_cents: 1600,
    };
    mockApi.getOrders.and.returnValue(of([baseOrder]));
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();

    const addedItem = {
      id: 2003,
      product_name: 'Peas',
      quantity: 1,
      status: 'pending',
      price_cents: 250,
      category: 'Main Course',
    };
    mockApi.getOrders.and.returnValue(of([{
      ...baseOrder,
      items: [...baseOrder.items, addedItem],
      total_cents: 1850,
    }]));
    fixture.componentInstance.loadOrders({ background: true });
    fixture.detectChanges();

    expect(fixture.componentInstance.isNewOrderItem(68, addedItem)).toBeTrue();
    expect(fixture.nativeElement.querySelector('.item-new-badge').textContent.trim()).toBe('NEW');
    expect(fixture.nativeElement.querySelector('.ticket-review-summary').textContent).toContain('1 NEW');
    expect(fixture.nativeElement.querySelector('.order-primary-action').textContent).toContain(
      'Review remaining items',
    );

    fixture.componentInstance.reviewNextTicketItems(fixture.componentInstance.activeOrders()[0]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.item-new-badge')).toBeNull();
    expect(fixture.nativeElement.querySelector('.order-primary-action').textContent).toContain(
      'Hold to Start',
    );
  });

  it('should advance all pending ticket items with one Start action', () => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    const order = {
      id: 91,
      status: 'paid',
      table_name: 'T1',
      created_at: new Date().toISOString(),
      paid_at: new Date().toISOString(),
      items: [
        { id: 901, product_name: 'Pie', quantity: 1, status: 'pending', price_cents: 1200, category: 'Main Course' },
        { id: 902, product_name: 'Chips', quantity: 1, status: 'pending', price_cents: 400, category: 'Main Course' },
      ],
      total_cents: 1600,
    };
    fixture.componentInstance.orders.set([order]);

    expect(fixture.componentInstance.getOrderActionLabel(order)).toBe('Start');
    fixture.componentInstance.advanceOrder(order);

    expect(mockApi.updateOrderKitchenStatus).toHaveBeenCalledOnceWith(91, 'preparing');
    expect(mockApi.updateOrderItemStatus).not.toHaveBeenCalled();
  });

  it('should advance a 15-item ticket with one atomic request', () => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    const order = {
      id: 167,
      status: 'paid',
      table_name: 'Indoor Table 1',
      created_at: new Date().toISOString(),
      paid_at: new Date().toISOString(),
      items: Array.from({ length: 15 }, (_, index) => ({
        id: 3000 + index,
        product_name: `Long order item ${index + 1}`,
        quantity: 1,
        status: 'pending',
        price_cents: 500,
        category: 'Main Course',
      })),
      total_cents: 7500,
    };
    fixture.componentInstance.orders.set([order]);
    fixture.componentInstance.ticketReviewStates.set({
      167: {
        itemCount: 15,
        remainingBelow: 0,
        hasOverflow: true,
        reviewed: true,
        measured: true,
      },
    });

    fixture.componentInstance.advanceOrder(order);

    expect(mockApi.updateOrderKitchenStatus).toHaveBeenCalledOnceWith(167, 'preparing');
    expect(mockApi.updateOrderItemStatus).not.toHaveBeenCalled();
  });

  it('should require three heartbeat failures before showing offline and upload recovery logs', fakeAsync(() => {
    mockApi.heartbeatKitchenDevice.and.returnValue(
      throwError(() => ({ status: 504, name: 'GatewayTimeout', message: 'Gateway timeout' })),
    );
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance as unknown as { sendHeartbeat: () => void };

    expect(fixture.componentInstance.kdsOnline()).toBeTrue();
    tick(10_000);
    component.sendHeartbeat();
    expect(fixture.componentInstance.kdsOnline()).toBeTrue();
    tick(15_000);
    component.sendHeartbeat();
    expect(fixture.componentInstance.kdsOnline()).toBeFalse();

    mockApi.heartbeatKitchenDevice.and.returnValue(of({ status: 'ok' }));
    component.sendHeartbeat();

    expect(fixture.componentInstance.kdsOnline()).toBeTrue();
    expect(mockApi.recordKitchenHeartbeatDiagnostics).toHaveBeenCalled();
    fixture.destroy();
  }));

  it('should require a one-second hold and enforce a two-second cooldown', fakeAsync(() => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    const order = {
      id: 93,
      status: 'paid',
      table_name: 'T1',
      created_at: new Date().toISOString(),
      paid_at: new Date().toISOString(),
      items: [
        { id: 930, product_name: 'Pie', quantity: 1, status: 'pending', price_cents: 1200, category: 'Main Course' },
      ],
      total_cents: 1200,
    };
    fixture.componentInstance.orders.set([order]);
    const event = {
      button: 0,
      pointerId: 1,
      preventDefault: jasmine.createSpy('preventDefault'),
      currentTarget: { setPointerCapture: jasmine.createSpy('setPointerCapture') },
    } as unknown as PointerEvent;

    fixture.componentInstance.startOrderHold(event, order);
    tick(999);
    expect(mockApi.updateOrderKitchenStatus).not.toHaveBeenCalledWith(93, 'preparing');
    tick(1);
    expect(mockApi.updateOrderKitchenStatus).toHaveBeenCalledWith(93, 'preparing');
    expect(mockAudio.playKitchenStatusConfirmed).toHaveBeenCalled();
    expect(fixture.componentInstance.orderCooldownSeconds(93)).toBe(2);

    mockApi.updateOrderKitchenStatus.calls.reset();
    fixture.componentInstance.startOrderHold(event, order);
    tick(1000);
    expect(mockApi.updateOrderKitchenStatus).not.toHaveBeenCalled();
    fixture.destroy();
  }));

  it('should hide secondary ticket details until Show more is selected', () => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.isOrderDetailsOpen(42)).toBeFalse();
    fixture.componentInstance.toggleOrderDetails(42);
    expect(fixture.componentInstance.isOrderDetailsOpen(42)).toBeTrue();
    fixture.componentInstance.toggleOrderDetails(42);
    expect(fixture.componentInstance.isOrderDetailsOpen(42)).toBeFalse();
  });

  it('should keep the elapsed wait timer visible on a collapsed ticket', () => {
    mockApi.getOrders.and.returnValue(
      of([
        {
          id: 92,
          status: 'paid',
          table_name: 'T1',
          created_at: new Date(Date.now() - 65_000).toISOString(),
          paid_at: new Date(Date.now() - 65_000).toISOString(),
          items: [
            {
              id: 903,
              product_name: 'Pie',
              quantity: 1,
              status: 'pending',
              price_cents: 1200,
              category: 'Main Course',
            },
          ],
          total_cents: 1200,
        },
      ]),
    );
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();

    const timer = fixture.nativeElement.querySelector('.order-waiting') as HTMLElement | null;
    expect(timer).not.toBeNull();
    expect(timer?.textContent).toContain('Waiting');
    expect(timer?.textContent).toMatch(/1:\d{2}/);
    expect(fixture.nativeElement.querySelector('.order-details')).toBeNull();
  });

  it('should show customer requests and food modifiers without opening ticket details', () => {
    mockApi.getOrders.and.returnValue(
      of([
        {
          id: 94,
          status: 'paid',
          table_name: 'T4',
          notes: 'Please bring everything together.',
          created_at: new Date().toISOString(),
          paid_at: new Date().toISOString(),
          items: [
            {
              id: 940,
              product_name: 'Burger',
              quantity: 1,
              status: 'pending',
              price_cents: 1200,
              category: 'Main Course',
              customization_summary: 'No onions, extra cheese',
              notes: 'Cut in half',
            },
          ],
          total_cents: 1200,
        },
      ]),
    );
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.order-details')).toBeNull();
    expect(fixture.nativeElement.querySelector('.customer-request')?.textContent).toContain(
      'Please bring everything together.',
    );
    expect(fixture.nativeElement.querySelector('.item-customization')?.textContent).toContain(
      'No onions, extra cheese',
    );
    expect(fixture.nativeElement.querySelector('.item-notes')?.textContent).toContain('Cut in half');
  });

  it('should show the live clock and active ticket counts in the header', () => {
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    mockApi.getOrders.and.returnValue(
      of([
        {
          id: 101,
          status: 'paid',
          table_name: 'T1',
          created_at: createdAt,
          items: [
            { id: 1001, product_name: 'Pie', quantity: 1, status: 'pending', price_cents: 1200, category: 'Main Course' },
          ],
          total_cents: 1200,
        },
        {
          id: 102,
          status: 'preparing',
          table_name: 'T2',
          created_at: createdAt,
          items: [
            { id: 1002, product_name: 'Chips', quantity: 1, status: 'preparing', price_cents: 400, category: 'Main Course' },
          ],
          total_cents: 400,
        },
        {
          id: 103,
          status: 'ready',
          table_name: 'T3',
          created_at: createdAt,
          items: [
            { id: 1003, product_name: 'Salad', quantity: 1, status: 'ready', price_cents: 700, category: 'Main Course' },
          ],
          total_cents: 700,
        },
      ]),
    );
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.activeOrderCount()).toBe(3);
    expect(fixture.componentInstance.pendingOrderCount()).toBe(1);
    expect(fixture.componentInstance.preparingOrderCount()).toBe(1);
    expect(fixture.componentInstance.readyOrderCount()).toBe(1);
    expect(
      (fixture.nativeElement.querySelector('[data-testid="kds-current-time"]') as HTMLElement)
        .textContent?.trim(),
    ).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('should colour the full ticket surface from the live production status', () => {
    const createdAt = new Date().toISOString();
    mockApi.getOrders.and.returnValue(
      of(
        (['pending', 'preparing', 'ready'] as const).map((status, index) => ({
          id: 201 + index,
          status: 'paid',
          table_name: `T${index + 1}`,
          created_at: createdAt,
          paid_at: createdAt,
          items: [
            {
              id: 2201 + index,
              product_name: 'Kitchen item',
              quantity: 1,
              status,
              price_cents: 1000,
              category: 'Main Course',
            },
          ],
          total_cents: 1000,
        })),
      ),
    );
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();

    const cards = Array.from(
      fixture.nativeElement.querySelectorAll('.order-card'),
    ) as HTMLElement[];
    expect(cards.map((card) => card.classList.contains('production-pending'))).toEqual([
      true,
      false,
      false,
    ]);
    expect(cards[1].classList.contains('production-preparing')).toBeTrue();
    expect(cards[2].classList.contains('production-ready')).toBeTrue();
    expect(
      cards.map((card) => card.querySelector('.production-status-badge')?.textContent?.trim()),
    ).toEqual(['New', 'Preparing', 'Ready']);
  });

  it('should report off-screen tickets and scroll the order lane with the footer arrows', () => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const rect = (left: number, right: number) =>
      ({ left, right, width: right - left } as DOMRect);
    const cards = [rect(0, 320), rect(336, 656), rect(672, 992), rect(1008, 1328)].map(
      (cardRect) => ({ getBoundingClientRect: () => cardRect }),
    );
    const scrollBy = jasmine.createSpy('scrollBy');
    const scroller = {
      clientWidth: 700,
      scrollBy,
      getBoundingClientRect: () => rect(0, 700),
      querySelectorAll: () => cards,
      querySelector: () => cards[0],
    };
    component.orderScrollerRef = { nativeElement: scroller } as never;

    component.updateOrderNavigation();

    expect(component.ordersToLeft()).toBe(0);
    expect(component.ordersToRight()).toBe(2);
    expect(component.visibleOrderStart()).toBe(1);
    expect(component.visibleOrderEnd()).toBe(3);

    component.scrollOrders(1);
    expect(scrollBy).toHaveBeenCalledWith({ left: 504, behavior: 'smooth' });
  });

  it('should toggle sound and persist to localStorage', () => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    const setItemSpy = spyOn(localStorage, 'setItem');
    fixture.componentInstance.toggleSound({ target: { checked: false } } as unknown as Event);
    expect(mockAudio.setEnabled).toHaveBeenCalledWith(false);
    expect(setItemSpy).toHaveBeenCalledWith('kitchen-display-sound', 'false');
  });

  it('should let kitchen staff update stock availability without editing products', () => {
    const stockProduct = {
      id: 44,
      name: 'Kitchen pie',
      price_cents: 1295,
      category: 'Main Course',
      is_available: true,
      kitchen_station_route: 'kitchen' as const,
      resolved_kitchen_station_id: null,
    };
    mockApi.getKitchenStock.and.returnValue(of([stockProduct]));
    mockApi.updateProductAvailability.and.returnValue(of([{ ...stockProduct, is_available: false }]));
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.canManageStock()).toBeTrue();

    fixture.componentInstance.openStockModal();
    expect(mockApi.getKitchenStock).toHaveBeenCalled();
    expect(fixture.componentInstance.stockDraft()[44]).toBeTrue();
    fixture.componentInstance.setStockAvailability(44, { target: { checked: false } } as unknown as Event);
    expect(fixture.componentInstance.stockChangedCount()).toBe(1);
    fixture.componentInstance.saveStock();

    expect(mockApi.updateProductAvailability).toHaveBeenCalledWith([
      { product_id: 44, is_available: false },
    ]);
    expect(fixture.componentInstance.stockModalOpen()).toBeFalse();
  });

  it('should auto-refresh after interval', fakeAsync(() => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    mockApi.getOrders.calls.reset();
    tick(15000);
    fixture.detectChanges();
    expect(mockApi.getOrders).toHaveBeenCalledWith(false, true, true);
  }));

  it('should not show full-page loading on background refresh', fakeAsync(() => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.loading()).toBe(false);
    fixture.componentInstance.loadOrders({ background: true });
    expect(fixture.componentInstance.loading()).toBe(false);
    tick();
    fixture.detectChanges();
    expect(fixture.componentInstance.loading()).toBe(false);
    expect(mockApi.getOrders).toHaveBeenCalled();
  }));

  it('should defer background refresh until item status dropdown closes', () => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    mockApi.getOrders.calls.reset();
    fixture.componentInstance.toggleItemStatusDropdown(1, 1);
    fixture.componentInstance.loadOrders({ background: true });
    expect(mockApi.getOrders).not.toHaveBeenCalled();
    mockApi.getOrders.calls.reset();
    fixture.componentInstance.toggleItemStatusDropdown(1, 1);
    expect(mockApi.getOrders).toHaveBeenCalledWith(false, true, true);
  });

  it('should call requestFullscreen when toggleFullscreen and not already fullscreen', () => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    const el = fixture.componentInstance.kitchenRootRef?.nativeElement as HTMLElement & {
      requestFullscreen: jasmine.Spy;
    };
    expect(el).toBeTruthy();
    const req = jasmine.createSpy('requestFullscreen').and.returnValue(Promise.resolve());
    el.requestFullscreen = req;
    fixture.componentInstance.toggleFullscreen();
    expect(req).toHaveBeenCalled();
  });
});
