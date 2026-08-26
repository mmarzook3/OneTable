import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { KitchenDisplayComponent } from './kitchen-display.component';
import { ApiService } from '../services/api.service';
import { AudioService } from '../services/audio.service';
import { PermissionService } from '../services/permission.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { RouterTestingModule } from '@angular/router/testing';
import { of } from 'rxjs';

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
    getOrderingStatus: jasmine.Spy;
    getKitchenStock: jasmine.Spy;
    updateProductAvailability: jasmine.Spy;
    getProductImageUrl: jasmine.Spy;
    updateOrderItemStatus: jasmine.Spy;
  };
  let mockAudio: { setEnabled: jasmine.Spy; playRestaurantOrderChange: jasmine.Spy };

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
        .and.returnValue(of({ yellow_minutes: 5, orange_minutes: 10, red_minutes: 15, routing_mode: 'split' })),
      updateKitchenDisplaySettings: jasmine.createSpy('updateKitchenDisplaySettings').and.returnValue(
        of({ yellow_minutes: 5, orange_minutes: 10, red_minutes: 15, routing_mode: 'split' }),
      ),
      heartbeatKitchenDevice: jasmine.createSpy('heartbeatKitchenDevice').and.returnValue(of({ status: 'ok' })),
      getOrderingStatus: jasmine.createSpy('getOrderingStatus').and.returnValue(of({ strict_fifo_kds: true })),
      getKitchenStock: jasmine.createSpy('getKitchenStock').and.returnValue(of([])),
      updateProductAvailability: jasmine.createSpy('updateProductAvailability').and.returnValue(of([])),
      getProductImageUrl: jasmine.createSpy('getProductImageUrl').and.returnValue(null),
      updateOrderItemStatus: jasmine.createSpy('updateOrderItemStatus').and.returnValue(of({ status: 'ok' })),
    };
    mockAudio = {
      setEnabled: jasmine.createSpy('setEnabled'),
      playRestaurantOrderChange: jasmine.createSpy('playRestaurantOrderChange'),
    };

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
    expect(mockApi.getOrders).toHaveBeenCalledWith(false);
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
    expect(mockAudio.playRestaurantOrderChange).not.toHaveBeenCalled();
    orderUpdates$.next({ type: 'new_order' });
    expect(mockAudio.playRestaurantOrderChange).toHaveBeenCalled();
  });

  it('should not play sound when sound is disabled and WebSocket emits', () => {
    spyOn(localStorage, 'getItem').and.returnValue('false');
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    mockAudio.playRestaurantOrderChange.calls.reset();
    orderUpdates$.next({ type: 'new_order' });
    expect(mockAudio.playRestaurantOrderChange).not.toHaveBeenCalled();
  });

  it('should refresh orders when WebSocket emits', () => {
    const fixture = TestBed.createComponent(KitchenDisplayComponent);
    fixture.detectChanges();
    mockApi.getOrders.calls.reset();
    orderUpdates$.next({ type: 'items_added' });
    expect(mockApi.getOrders).toHaveBeenCalledWith(false);
  });

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

    expect(mockApi.updateOrderItemStatus).toHaveBeenCalledWith(91, 901, 'preparing');
    expect(mockApi.updateOrderItemStatus).toHaveBeenCalledWith(91, 902, 'preparing');
  });

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
    expect(mockApi.getOrders).toHaveBeenCalledWith(false);
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
    expect(mockApi.getOrders).toHaveBeenCalledWith(false);
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
