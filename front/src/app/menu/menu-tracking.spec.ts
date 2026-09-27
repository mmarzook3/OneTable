import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { DomSanitizer } from '@angular/platform-browser';
import { TranslateService } from '@ngx-translate/core';
import { BehaviorSubject, of, Subject, throwError } from 'rxjs';
import { MenuComponent } from './menu.component';
import { ApiService, MenuResponse, Product } from '../services/api.service';
import { AudioService } from '../services/audio.service';

describe('Menu rescan tracking', () => {
  const token = 'menu-tracking-regression-table';
  const session = 'menu-tracking-regression-session';
  let component: MenuComponent;
  let api: jasmine.SpyObj<ApiService>;
  let routeParams: BehaviorSubject<{ token: string }>;
  const instances: MenuComponent[] = [];

  function makeComponent(): MenuComponent {
    const instance = TestBed.runInInjectionContext(() => new MenuComponent());
    // Keep these unit tests offline; websocket integration is covered separately.
    spyOn(instance, 'connectWebSocket');
    instances.push(instance);
    return instance;
  }

  function menu(activeOrderId: number | null = 101): MenuResponse {
    return {
      products: [], table_id: 1, tenant_id: 1, tenant_name: 'Tracking test', table_name: 'Table 1',
      table_is_active: true, table_requires_pin: false, table_shared_cart: false,
      ordering_mode: 'automatic', active_order_id: activeOrderId,
    };
  }

  function response(status = 'paid', itemStatus = 'preparing', id = 101) {
    return { order: {
      id, status, paid_at: '2026-09-27T10:00:00Z', payment_state: 'paid',
      total_cents: 500, notes: '', session_id: session,
      items: [{ id: 1001, product_id: 1, product_name: 'Test item', quantity: 1,
        price_cents: 500, status: itemStatus, session_id: session }],
    } };
  }

  beforeEach(() => {
    api = jasmine.createSpyObj<ApiService>('ApiService', [
      'getMenu', 'getCurrentOrder', 'getOrderHistory', 'setTenantStripeKey',
      'getStripePublishableKey', 'createPaymentIntent', 'confirmPayment',
      'cancelCustomerPayment',
    ]);
    routeParams = new BehaviorSubject({ token });
    api.getMenu.and.returnValue(of(menu()));
    api.getCurrentOrder.and.returnValue(of(response()) as ReturnType<ApiService['getCurrentOrder']>);
    api.getOrderHistory.and.returnValue(of([]));
    TestBed.configureTestingModule({ providers: [
      { provide: ApiService, useValue: api },
      { provide: ActivatedRoute, useValue: {
        params: routeParams, snapshot: { params: { token }, queryParams: {} },
      } },
      { provide: AudioService, useValue: {} },
      { provide: DomSanitizer, useValue: {} },
      { provide: TranslateService, useValue: { instant: (key: string) => key } },
    ] });
    localStorage.setItem(`session_${token}`, session);
    localStorage.setItem(`active_order_${token}`, '101');
    component = makeComponent();
  });

  afterEach(() => {
    for (const instance of instances.splice(0)) instance.ngOnDestroy();
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of Object.keys(storage)) {
        if (key.includes(token)) storage.removeItem(key);
      }
    }
  });

  it('waits for menu/session reconciliation before requesting current order or history', () => {
    const pendingMenu = new Subject<ReturnType<typeof menu>>();
    api.getMenu.and.returnValue(pendingMenu);
    component.ngOnInit();
    expect(api.getCurrentOrder).not.toHaveBeenCalled();
    expect(api.getOrderHistory).not.toHaveBeenCalled();
    pendingMenu.next(menu());
    expect(api.getCurrentOrder).toHaveBeenCalledWith(token, session);
    expect(api.getOrderHistory).toHaveBeenCalledWith(token, session, 10);
  });

  it('restores the same customer session and paid preparing order after rescanning', () => {
    component.ngOnInit();
    const rescanned = makeComponent();
    rescanned.ngOnInit();
    expect(localStorage.getItem(`session_${token}`)).toBe(session);
    expect(api.getCurrentOrder).toHaveBeenCalledWith(token, session);
    expect(rescanned.placedOrders().map(order => order.id)).toEqual([101]);
    expect(rescanned.placedOrders()[0].status).toBe('paid');
  });

  it('hides the optional name prompt when an anonymous customer restores an owned order', () => {
    localStorage.removeItem(`customer_name_${token}`);
    component.ngOnInit();
    expect(component.placedOrders().map(order => order.id)).toEqual([101]);
    expect(component.customerName()).toBe('');
    expect(component.showNameModal()).toBeFalse();
  });

  it('keeps a manually reopened name form visible during subsequent tracking refreshes', () => {
    localStorage.removeItem(`customer_name_${token}`);
    component.ngOnInit();
    expect(component.showNameModal()).toBeFalse();
    component.showNameModal.set(true);
    component.loadStoredOrders();
    expect(component.placedOrders().map(order => order.id)).toEqual([101]);
    expect(component.showNameModal()).toBeTrue();
  });

  it('retains a paid order from its own cached snapshot during network failure', () => {
    component.ngOnInit();
    api.getCurrentOrder.and.returnValue(throwError(() => new Error('Offline')));
    const rescanned = makeComponent();
    rescanned.ngOnInit();
    expect(rescanned.placedOrders().map(order => order.id)).toEqual([101]);
    expect(rescanned.trackingStale()).toBeTrue();
  });

  it('does not restore an unowned legacy cache for another customer', () => {
    localStorage.setItem(`orders_${token}`, JSON.stringify([{
      id: 999, status: 'pending', items: [], total: 500, notes: 'Other customer',
    }]));
    api.getCurrentOrder.and.returnValue(throwError(() => new Error('Offline')));
    component.ngOnInit();
    expect(component.placedOrders()).toEqual([]);
    expect(component.trackingStale()).toBeTrue();
  });

  it('does not restore the prior session snapshot after session replacement', () => {
    component.ngOnInit();
    localStorage.setItem(`session_${token}`, 'different-customer-session');
    api.getCurrentOrder.and.returnValue(throwError(() => new Error('Offline')));
    const differentCustomer = makeComponent();
    differentCustomer.ngOnInit();
    expect(differentCustomer.placedOrders()).toEqual([]);
  });

  it('clears stale indication after authoritative tracking recovers', () => {
    api.getCurrentOrder.and.returnValue(throwError(() => new Error('Offline')));
    component.ngOnInit();
    expect(component.trackingStale()).toBeTrue();
    api.getCurrentOrder.and.returnValue(of(response('paid', 'ready')) as ReturnType<ApiService['getCurrentOrder']>);
    component.loadStoredOrders();
    expect(component.trackingStale()).toBeFalse();
    expect(component.placedOrders()[0].items[0].status).toBe('ready');
  });

  it('ignores an in-flight response after the component is destroyed', () => {
    const pendingOrder = new Subject<ReturnType<typeof response>>();
    api.getCurrentOrder.and.returnValue(pendingOrder as ReturnType<ApiService['getCurrentOrder']>);
    component.ngOnInit();
    component.ngOnDestroy();
    pendingOrder.next(response());
    expect(component.placedOrders()).toEqual([]);
  });

  it('preserves the customer UUID when the active shared order is replaced', () => {
    component.ngOnInit();
    api.getMenu.and.returnValue(of(menu(202)));
    component.loadMenu();
    expect(localStorage.getItem(`session_${token}`)).toBe(session);
    expect(api.getCurrentOrder.calls.mostRecent().args).toEqual([token, session]);
    expect(component.placedOrders().map(order => order.id)).toEqual([101]);
  });

  it('rotates a known assignment and rejects its old cache and in-flight response', () => {
    api.getMenu.and.returnValue(of({ ...menu(), ordering_point_assignment_version: 1 }));
    component.ngOnInit();
    expect(JSON.parse(localStorage.getItem(`tracking_${token}`)!).sessionId).toBe(session);
    const pendingOrder = new Subject<ReturnType<typeof response>>();
    api.getCurrentOrder.and.returnValue(pendingOrder as ReturnType<ApiService['getCurrentOrder']>);
    component.loadStoredOrders();
    api.getCurrentOrder.and.returnValue(throwError(() => new Error('Offline')));
    api.getMenu.and.returnValue(of({ ...menu(202), ordering_point_assignment_version: 2 }));
    component.loadMenu();
    const replacement = localStorage.getItem(`session_${token}`);
    expect(replacement).toBeTruthy();
    expect(replacement).not.toBe(session);
    expect(localStorage.getItem(`tracking_${token}`)).toBeNull();
    expect(component.placedOrders()).toEqual([]);
    pendingOrder.next(response());
    pendingOrder.complete();
    expect(component.placedOrders()).toEqual([]);
    expect(localStorage.getItem(`tracking_${token}`)).toBeNull();
    expect(api.getCurrentOrder.calls.mostRecent().args).toEqual([token, replacement!]);
  });

  it('restores additive orders and distinguishes payment from fulfillment per order', () => {
    const paid = response('paid', 'preparing', 101).order;
    const unpaid = { ...response('pending', 'pending', 102).order,
      paid_at: null, payment_state: 'unpaid' };
    api.getCurrentOrder.and.returnValue(of({ order: paid, orders: [paid, unpaid] }) as ReturnType<ApiService['getCurrentOrder']>);
    component.ngOnInit();
    const orders = component.placedOrders();
    expect(orders.map(order => order.id)).toEqual([101, 102]);
    expect(component.isOrderPaid(orders[0])).toBeTrue();
    expect(component.isOrderPaid(orders[1])).toBeFalse();
    expect(orders.map(order => component.getTrackingStatus(order))).toEqual(['preparing', 'pending']);
  });

  it('refreshes authoritative state when the websocket opens', () => {
    const socket = jasmine.createSpyObj<WebSocket>('WebSocket', ['close']);
    spyOn(window, 'WebSocket').and.returnValue(socket);
    spyOnProperty(document, 'hidden', 'get').and.returnValue(false);
    (component.connectWebSocket as jasmine.Spy).and.callThrough();
    component.ngOnInit();
    api.getCurrentOrder.calls.reset();
    api.getOrderHistory.calls.reset();
    socket.onopen!.call(socket, new Event('open'));
    expect(api.getCurrentOrder).toHaveBeenCalledWith(token, session);
    expect(api.getOrderHistory).toHaveBeenCalledWith(token, session, 10);
  });

  it('cancels a scheduled websocket reconnect on destruction', fakeAsync(() => {
    const socket = jasmine.createSpyObj<WebSocket>('WebSocket', ['close']);
    const createSocket = spyOn(window, 'WebSocket').and.returnValue(socket);
    (component.connectWebSocket as jasmine.Spy).and.callThrough();
    component.ngOnInit();
    socket.onclose!.call(socket, new CloseEvent('close'));
    expect(component.trackingStale()).toBeTrue();
    tick(4999);
    expect(createSocket).toHaveBeenCalledTimes(1);
    component.ngOnDestroy();
    tick(15001);
    expect(createSocket).toHaveBeenCalledTimes(1);
  }));

  function scopedOrder(overrides: Partial<Parameters<MenuComponent['isOrderPaid']>[0]> = {}): Parameters<MenuComponent['isOrderPaid']>[0] {
    return {
      id: 101, status: 'pending', total: 1800, notes: '',
      items: [{ product: { id: 1, name: 'My item', price_cents: 800 } as Product,
        quantity: 1, notes: '', status: 'preparing' }],
      ...overrides,
    };
  }

  it('marks the viewer items paid even while the shared table order is unpaid', () => {
    const order = scopedOrder({ customer_payment_state: 'paid', can_pay: false,
      amount_remaining_cents: 0 });
    expect(component.isOrderPaid(order)).toBeTrue();
    expect(component.canPayOrder(order)).toBeFalse();
    expect(component.getTrackingStatus(order)).toBe('preparing');
  });

  it('does not treat another guest payment or table paid flags as viewer payment', () => {
    const order = scopedOrder({ status: 'paid', paid_at: '2026-09-27T10:00:00Z',
      payment_state: 'paid', customer_payment_state: 'unpaid', can_pay: true,
      amount_remaining_cents: 800 });
    expect(component.isOrderPaid(order)).toBeFalse();
    expect(component.canPayOrder(order)).toBeTrue();
  });

  it('uses only the viewer remaining amount when opening checkout', () => {
    const order = scopedOrder({ customer_payment_state: 'partially_paid', can_pay: true,
      amount_remaining_cents: 300 });
    component.startCheckout(order);
    expect(component.showPaymentOptions()).toBeTrue();
    expect(component.paymentAmount()).toBe(300);
  });

  it('does not open checkout when the server disallows payment', () => {
    const order = scopedOrder({ customer_payment_state: 'unpaid', can_pay: false,
      amount_remaining_cents: 800 });
    expect(component.canPayOrder(order)).toBeFalse();
    component.startCheckout(order);
    expect(component.showPaymentOptions()).toBeFalse();
  });

  it('does not open checkout using stale tracking data', () => {
    component.trackingStale.set(true);
    const order = scopedOrder({ customer_payment_state: 'unpaid', can_pay: true,
      amount_remaining_cents: 800 });
    expect(component.canPayOrder(order)).toBeFalse();
    component.startCheckout(order);
    expect(component.showPaymentOptions()).toBeFalse();
  });

  for (const state of ['refunded', 'requires_staff']) {
    it(`does not mark ${state} viewer items paid or open blocked checkout`, () => {
      const order = scopedOrder({ status: 'paid', payment_state: 'paid',
        paid_at: '2026-09-27T10:00:00Z', customer_payment_state: state,
        can_pay: false, amount_remaining_cents: 800 });
      expect(component.isOrderPaid(order)).toBeFalse();
      expect(component.canPayOrder(order)).toBeFalse();
      component.startCheckout(order);
      expect(component.showPaymentOptions()).toBeFalse();
    });
  }

  it('preserves legacy payment detection only when viewer payment state is absent', () => {
    expect(component.isOrderPaid(scopedOrder({ status: 'paid' }))).toBeTrue();
    expect(component.isOrderPaid(scopedOrder({ paid_at: '2026-09-27T10:00:00Z' }))).toBeTrue();
    expect(component.isOrderPaid(scopedOrder({ payment_state: 'paid' }))).toBeTrue();
    expect(component.isOrderPaid(scopedOrder())).toBeFalse();
    component.startCheckout(scopedOrder());
    expect(component.showPaymentOptions()).toBeTrue();
    expect(component.paymentAmount()).toBe(1800);
  });

  it('prevents cancellation when a viewer item has already been paid', () => {
    const order = scopedOrder({ customer_payment_state: 'partially_paid' });
    order.items = [{ ...order.items[0], status: 'pending', paid_cents: 800, is_paid: true }];
    expect(component.canCancelOrder(order)).toBeFalse();
  });

  it('honors the server cancellation restriction for otherwise pending unpaid items', () => {
    const order = scopedOrder({ customer_payment_state: 'unpaid', can_cancel_order: false });
    order.items = [{ ...order.items[0], status: 'pending', paid_cents: 0, is_paid: false }];
    expect(component.canCancelOrder(order)).toBeFalse();
  });

  it('treats concurrent settlement as paid without opening a zero-value Stripe checkout', async () => {
    api.getStripePublishableKey.and.returnValue('pk_test_unit_only');
    api.createPaymentIntent.and.returnValue(of({ status: 'paid', amount: 0 }) as ReturnType<ApiService['createPaymentIntent']>);
    const loadStripe = spyOn(component, 'loadStripe').and.resolveTo();
    component.ngOnInit();
    component.startCheckout(scopedOrder({ customer_payment_state: 'unpaid', can_pay: true,
      amount_remaining_cents: 800 }));
    api.getCurrentOrder.calls.reset();
    api.getOrderHistory.calls.reset();
    component.selectPayOnline();
    await Promise.resolve();
    expect(component.paymentSuccess()).toBeTrue();
    expect(component.processingPayment()).toBeFalse();
    expect(component.paymentRequestSending()).toBeFalse();
    expect(component.showPaymentModal()).toBeFalse();
    expect(loadStripe).not.toHaveBeenCalled();
    expect(api.getCurrentOrder).toHaveBeenCalledWith(token, session);
    expect(api.getOrderHistory).toHaveBeenCalledWith(token, session, 10);
  });

  it('ignores a late payment intent after navigating to another table', async () => {
    const intent = new Subject<{ client_secret: string; payment_intent_id: string; amount: number }>();
    api.getStripePublishableKey.and.returnValue('pk_test_unit_only');
    api.createPaymentIntent.and.returnValue(intent as ReturnType<ApiService['createPaymentIntent']>);
    const loadStripe = spyOn(component, 'loadStripe').and.resolveTo();
    component.ngOnInit();
    component.startCheckout(scopedOrder({ customer_payment_state: 'unpaid', can_pay: true,
      amount_remaining_cents: 800 }));
    component.selectPayOnline();
    expect(api.createPaymentIntent).toHaveBeenCalledWith(101, token, null, session);
    routeParams.next({ token: `${token}-other` });
    intent.next({ client_secret: 'synthetic_secret', payment_intent_id: 'pi_unit_old', amount: 800 });
    intent.complete();
    await Promise.resolve();
    expect(component.showPaymentModal()).toBeFalse();
    expect(component.showPaymentOptions()).toBeFalse();
    expect(loadStripe).not.toHaveBeenCalled();
  });

  it('confirms the captured payment context without updating a newly navigated table', async () => {
    let settle!: (value: { paymentIntent: { status: string } }) => void;
    const stripeResult = new Promise<{ paymentIntent: { status: string } }>(resolve => { settle = resolve; });
    const confirmCardPayment = jasmine.createSpy('confirmCardPayment').and.returnValue(stripeResult);
    api.confirmPayment.and.returnValue(of({ status: 'paid', order_id: 101 }) as ReturnType<ApiService['confirmPayment']>);
    component.ngOnInit();
    component.startCheckout(scopedOrder({ customer_payment_state: 'unpaid', can_pay: true,
      amount_remaining_cents: 800 }));
    Object.assign(component, {
      stripe: { confirmCardPayment }, cardElement: { destroy: jasmine.createSpy('destroy') },
      clientSecret: 'synthetic_secret', paymentIntentId: 'pi_unit_old',
    });
    const payment = component.processPayment();
    expect(confirmCardPayment).toHaveBeenCalled();
    routeParams.next({ token: `${token}-other` });
    const refreshCount = api.getCurrentOrder.calls.count();
    settle({ paymentIntent: { status: 'succeeded' } });
    await payment;
    expect(api.confirmPayment).toHaveBeenCalledOnceWith(101, token, 'pi_unit_old', null, session);
    expect(component.paymentSuccess()).toBeFalse();
    expect(component.showPaymentModal()).toBeFalse();
    expect(api.getCurrentOrder.calls.count()).toBe(refreshCount);
  });

  it('cancels a scoped Stripe attempt using the original customer payment arguments', async () => {
    api.getStripePublishableKey.and.returnValue('pk_test_unit_only');
    api.createPaymentIntent.and.returnValue(of({ client_secret: 'synthetic_secret',
      payment_intent_id: 'pi_unit_scoped', amount: 800, payment_scope: 'session_items' }) as ReturnType<ApiService['createPaymentIntent']>);
    api.cancelCustomerPayment.and.returnValue(of({ status: 'cancelled' }) as ReturnType<ApiService['cancelCustomerPayment']>);
    spyOn(component, 'loadStripe').and.resolveTo();
    component.ngOnInit();
    component.startCheckout(scopedOrder({ customer_payment_state: 'unpaid', can_pay: true,
      amount_remaining_cents: 800 }));
    component.selectPayOnline();
    await Promise.resolve();
    api.getCurrentOrder.calls.reset();
    component.cancelPayment();
    expect(api.cancelCustomerPayment).toHaveBeenCalledOnceWith(101, token, 'pi_unit_scoped', session);
    expect(api.getCurrentOrder).toHaveBeenCalledWith(token, session);
  });

  it('does not request scoped cancellation for a legacy whole-order intent', async () => {
    api.getStripePublishableKey.and.returnValue('pk_test_unit_only');
    api.createPaymentIntent.and.returnValue(of({ client_secret: 'synthetic_secret',
      payment_intent_id: 'pi_unit_legacy', amount: 800 }) as ReturnType<ApiService['createPaymentIntent']>);
    spyOn(component, 'loadStripe').and.resolveTo();
    component.ngOnInit();
    component.startCheckout(scopedOrder());
    component.selectPayOnline();
    await Promise.resolve();
    component.cancelPayment();
    expect(api.cancelCustomerPayment).not.toHaveBeenCalled();
  });

  it('does not cancel a scoped intent while card payment is processing', async () => {
    api.getStripePublishableKey.and.returnValue('pk_test_unit_only');
    api.createPaymentIntent.and.returnValue(of({ client_secret: 'synthetic_secret',
      payment_intent_id: 'pi_unit_scoped', amount: 800, payment_scope: 'session_items' }) as ReturnType<ApiService['createPaymentIntent']>);
    spyOn(component, 'loadStripe').and.resolveTo();
    component.ngOnInit();
    component.startCheckout(scopedOrder({ customer_payment_state: 'unpaid', can_pay: true,
      amount_remaining_cents: 800 }));
    component.selectPayOnline();
    await Promise.resolve();
    component.processingPayment.set(true);
    component.cancelPayment();
    expect(api.cancelCustomerPayment).not.toHaveBeenCalled();
    expect(component.showPaymentModal()).toBeTrue();
  });

  it('does not treat cancelled viewer items as paid despite a shared-order payment timestamp', () => {
    const order = scopedOrder({ status: 'paid', paid_at: '2026-09-27T10:00:00Z',
      payment_state: 'paid', customer_payment_state: 'cancelled', can_pay: false,
      amount_remaining_cents: 0 });
    order.items = [{ ...order.items[0], status: 'cancelled' }];
    expect(component.isOrderPaid(order)).toBeFalse();
    expect(component.canPayOrder(order)).toBeFalse();
    expect(component.getTrackingStatus(order)).toBe('cancelled');
  });

  it('never opens checkout for a cancelled order', () => {
    const order = scopedOrder({ status: 'cancelled', customer_payment_state: 'unpaid',
      can_pay: true, amount_remaining_cents: 800 });
    expect(component.canPayOrder(order)).toBeFalse();
    component.startCheckout(order);
    expect(component.showPaymentOptions()).toBeFalse();
  });

  for (const [states, expected] of [
    [['pending'], 'pending'],
    [['preparing'], 'preparing'],
    [['ready'], 'ready'],
    [['delivered', 'ready'], 'partially_delivered'],
    [['delivered'], 'completed'],
    [['cancelled'], 'cancelled'],
  ] as Array<[string[], string]>) {
    it(`derives ${expected} fulfillment independently of paid status`, () => {
      const order = {
        id: 101, status: 'paid', total: 500, notes: '',
        items: states.map(status => ({ product: { id: 1, name: 'Item', price_cents: 500 } as Product,
          quantity: 1, notes: '', status })),
      };
      expect(component.getTrackingStatus(order)).toBe(expected);
    });
  }
});
