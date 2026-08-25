import { CommonModule } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import {
  ApiService,
  KitchenStation,
  LocationHoursResponse,
  LocationMenuResponse,
  LocationRoutingResponse,
  Table,
  TenantLocation,
} from '../services/api.service';
import { SidebarComponent } from '../shared/sidebar.component';

type LocationTab = 'overview' | 'points' | 'menu' | 'hours' | 'routing';
type WeekDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

const DAYS: Array<{ key: WeekDay; label: string }> = [
  { key: 'monday', label: 'Monday' },
  { key: 'tuesday', label: 'Tuesday' },
  { key: 'wednesday', label: 'Wednesday' },
  { key: 'thursday', label: 'Thursday' },
  { key: 'friday', label: 'Friday' },
  { key: 'saturday', label: 'Saturday' },
  { key: 'sunday', label: 'Sunday' },
];

@Component({
  selector: 'app-locations',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, SidebarComponent],
  template: `
    <app-sidebar>
      <div class="location-page">
        <header class="page-heading">
          <div>
            <p class="section-kicker">Service locations</p>
            <h1>Locations and ordering points</h1>
            <p>Manage every pub area, lounge, hotel building, table and room from one restaurant account.</p>
          </div>
          <button type="button" class="btn btn-primary" (click)="showCreate.set(true)">Add location</button>
        </header>

        @if (error()) {
          <div class="alert alert-error" role="alert">{{ error() }}</div>
        }

        @if (loading()) {
          <div class="location-skeleton" aria-label="Loading locations">
            @for (item of [1, 2, 3, 4]; track item) { <span></span> }
          </div>
        } @else {
          <section class="usage-strip" aria-label="Ordering point allowance">
            <div><span>Active ordering points</span><strong>{{ usage() }}/{{ unlimited() ? 'Unlimited' : limit() }}</strong></div>
            <div><span>Available on plan</span><strong>{{ unlimited() ? 'Unlimited' : available() }}</strong></div>
            <div><span>Locations</span><strong>{{ locations().length }}</strong></div>
            <a routerLink="/settings">Subscription settings</a>
          </section>

          <section class="location-list" aria-label="Restaurant locations">
            @for (location of locations(); track location.id) {
              <button
                type="button"
                class="location-row"
                [class.location-row-active]="selectedLocation()?.id === location.id"
                (click)="openLocation(location)"
              >
                <span class="location-mark" [attr.data-kind]="location.location_type">
                  {{ location.location_type === 'hotel_building' ? 'R' : 'T' }}
                </span>
                <span class="location-identity">
                  <strong>{{ location.display_name }}</strong>
                  <small>{{ location.name }} · {{ locationLabel(location.location_type) }}</small>
                </span>
                <span class="location-counts">
                  <strong>{{ location.active_ordering_point_count }}</strong>
                  <small>{{ location.room_count }} rooms · {{ location.table_count }} tables</small>
                </span>
                <span class="inheritance-summary">
                  <small>Menu {{ location.menu_mode }}</small>
                  <small>Hours {{ location.hours_mode }}</small>
                  <small>Kitchen {{ location.kitchen_mode }}</small>
                </span>
                <span class="status-chip" [class.status-chip-paused]="location.ordering_paused" [class.status-chip-inactive]="!location.is_active">
                  {{ !location.is_active ? 'Archived' : location.ordering_paused ? 'Paused' : 'Ready' }}
                </span>
                <span class="row-arrow" aria-hidden="true">›</span>
              </button>
            } @empty {
              <div class="empty-state">
                <h2>No locations configured</h2>
                <p>Create the first service location before adding tables or hotel rooms.</p>
                <button type="button" class="btn btn-primary" (click)="showCreate.set(true)">Create first location</button>
              </div>
            }
          </section>
        }

        @if (showCreate()) {
          <div class="drawer-backdrop" (click)="showCreate.set(false)"></div>
          <section class="form-drawer" role="dialog" aria-modal="true" aria-labelledby="create-location-title">
            <header><div><p class="section-kicker">New service area</p><h2 id="create-location-title">Add a location</h2></div><button type="button" class="icon-close" (click)="showCreate.set(false)">Close</button></header>
            <form (submit)="createLocation($event)" class="drawer-form">
              <label>Internal name <input [(ngModel)]="newLocation.name" name="locationName" required maxlength="120"><small>Used by staff and Scanaki operators.</small></label>
              <label>Customer display name <input [(ngModel)]="newLocation.display_name" name="locationDisplayName" required maxlength="160"><small>Shown persistently on the QR/NFC menu, basket, kitchen ticket and receipt.</small></label>
              <label>Location type
                <select [(ngModel)]="newLocation.location_type" name="locationType">
                  <option value="pub">Pub or restaurant</option><option value="lounge">Lounge</option><option value="hotel_building">Hotel building</option><option value="other">Other</option>
                </select>
              </label>
              <div class="helper-panel"><strong>Starts safely with inheritance</strong><p>The new location initially uses the restaurant menu, hours, kitchen and payment account. Each can be separated later.</p></div>
              <footer><button type="button" class="btn btn-secondary" (click)="showCreate.set(false)">Cancel</button><button type="submit" class="btn btn-primary" [disabled]="saving()">{{ saving() ? 'Creating...' : 'Create location' }}</button></footer>
            </form>
          </section>
        }

        @if (selectedLocation(); as location) {
          <div class="drawer-backdrop" (click)="closeLocation()"></div>
          <section class="location-workspace" role="dialog" aria-modal="true" aria-labelledby="location-workspace-title">
            <header class="workspace-header">
              <div><p class="section-kicker">{{ locationLabel(location.location_type) }}</p><h2 id="location-workspace-title">{{ location.display_name }}</h2><p>{{ location.active_ordering_point_count }} active ordering points · {{ location.assigned_plaque_count }} plaques assigned</p></div>
              <button type="button" class="icon-close" (click)="closeLocation()">Close</button>
            </header>

            <nav class="workspace-tabs" aria-label="Location settings">
              @for (tab of tabs; track tab.key) {
                <button type="button" [class.active]="activeTab() === tab.key" (click)="activeTab.set(tab.key)">{{ tab.label }}</button>
              }
            </nav>

            <div class="workspace-body">
              @if (detailLoading()) {
                <div class="detail-skeleton"><span></span><span></span><span></span></div>
              } @else if (activeTab() === 'overview') {
                <section class="settings-section">
                  <div class="section-heading"><div><h3>Location identity</h3><p>These details follow the customer from scan to receipt.</p></div></div>
                  <div class="form-grid">
                    <label>Internal name <input [(ngModel)]="editLocation.name"></label>
                    <label>Customer display name <input [(ngModel)]="editLocation.display_name"></label>
                    <label>Location type <select [(ngModel)]="editLocation.location_type"><option value="pub">Pub or restaurant</option><option value="lounge">Lounge</option><option value="hotel_building">Hotel building</option><option value="other">Other</option></select></label>
                    <label>Display order <input type="number" [(ngModel)]="editLocation.sort_order"></label>
                  </div>
                  <div class="section-actions"><button class="btn btn-primary" type="button" (click)="saveIdentity()" [disabled]="saving()">Save identity</button></div>
                </section>

                <section class="settings-section service-control">
                  <div><h3>Ordering control</h3><p>Pause only this location without affecting the rest of the restaurant.</p></div>
                  @if (location.ordering_paused) {
                    <div class="pause-reason">{{ location.ordering_pause_reason || 'Ordering is paused.' }}</div>
                    <button class="btn btn-primary" type="button" (click)="resumeOrdering()">Resume ordering</button>
                  } @else {
                    <input [(ngModel)]="pauseReason" placeholder="Optional customer-safe reason">
                    <button class="btn btn-warning" type="button" (click)="pauseOrdering()">Pause this location</button>
                  }
                </section>

                <section class="readiness-grid" aria-label="Location readiness">
                  @for (check of readinessEntries(location); track check[0]) {
                    <div [class.ready]="check[1]"><span>{{ check[1] ? 'Ready' : 'Needs setup' }}</span><strong>{{ readinessLabel(check[0]) }}</strong></div>
                  }
                </section>
              } @else if (activeTab() === 'points') {
                <section class="settings-section">
                  <div class="section-heading"><div><h3>Rooms and tables</h3><p>Each enabled room or table uses one ordering point from the subscription allowance.</p></div><button class="btn btn-primary" type="button" (click)="showPointForm.set(true)">Add one</button></div>
                  @if (showPointForm()) {
                    <form class="inline-form" (submit)="createPoint($event)">
                      <label>Type <select [(ngModel)]="pointForm.service_point_type" name="pointType"><option value="table">Table</option><option value="room">Room</option></select></label>
                      <label>Number <input [(ngModel)]="pointForm.display_number" name="pointNumber" placeholder="101A" required></label>
                      <label>Seats <input type="number" [(ngModel)]="pointForm.seat_count" name="pointSeats" min="1" max="50"></label>
                      <label class="check-label"><input type="checkbox" [(ngModel)]="pointForm.is_ordering_enabled" name="pointEnabled"> Enable ordering now</label>
                      <div><button type="button" class="btn btn-secondary" (click)="showPointForm.set(false)">Cancel</button><button type="submit" class="btn btn-primary">Create</button></div>
                    </form>
                  }

                  <details class="bulk-panel">
                    <summary>Bulk-create rooms or tables</summary>
                    <p>Use a range such as 101 to 120, or paste exact values separated by commas or new lines.</p>
                    <div class="form-grid bulk-grid">
                      <label>Type <select [(ngModel)]="bulkForm.service_point_type"><option value="room">Room</option><option value="table">Table</option></select></label>
                      <label>First number <input type="number" [(ngModel)]="bulkForm.start_number"></label>
                      <label>Last number <input type="number" [(ngModel)]="bulkForm.end_number"></label>
                      <label class="wide">Or exact list <textarea [(ngModel)]="bulkForm.values" placeholder="101, 102, 104A, 201"></textarea></label>
                      <label class="check-label"><input type="checkbox" [(ngModel)]="bulkForm.is_ordering_enabled"> Enable ordering now</label>
                    </div>
                    <button type="button" class="btn btn-secondary" (click)="previewBulk()">Preview creation</button>
                    @if (bulkPreview(); as preview) {
                      <div class="bulk-preview" [class.bulk-preview-error]="!preview.allowed">
                        <strong>{{ preview.new_ordering_points }} ordering points</strong>
                        <span>Usage after creation: {{ preview.post_create_usage }}/{{ preview.ordering_points_unlimited ? 'Unlimited' : preview.ordering_point_limit }}</span>
                        @if (preview.conflicts?.length) { <p>Conflicts: {{ preview.conflicts.join(', ') }}</p> }
                        @if (preview.duplicate_inputs?.length) { <p>Duplicates: {{ preview.duplicate_inputs.join(', ') }}</p> }
                        <div class="preview-labels">{{ preview.labels.join(' · ') }}</div>
                        <button type="button" class="btn btn-primary" [disabled]="!preview.allowed || saving()" (click)="confirmBulk()">Confirm and create</button>
                      </div>
                    }
                  </details>

                  <div class="point-list">
                    @for (point of points(); track point.id) {
                      <div class="point-row">
                        <span class="point-kind">{{ point.service_point_type === 'room' ? 'Room' : 'Table' }}</span>
                        <div><strong>{{ point.service_point_label || point.name }}</strong><small>{{ point.seat_count || 0 }} seats · {{ point.smart_plaque_id ? 'Plaque assigned' : 'Plaque required' }}</small></div>
                        <label class="toggle"><input type="checkbox" [checked]="point.is_ordering_enabled" (change)="togglePoint(point, $event)"><span>{{ point.is_ordering_enabled ? 'Ordering enabled' : 'Draft' }}</span></label>
                        <a class="text-link" routerLink="/tables">QR/NFC</a>
                      </div>
                    } @empty { <div class="empty-inline">No rooms or tables have been added to this location.</div> }
                  </div>
                </section>
              } @else if (activeTab() === 'menu') {
                <section class="settings-section">
                  <div class="section-heading"><div><h3>Menu inheritance</h3><p>Keep one master menu or make carefully scoped changes for this location.</p></div><select [ngModel]="locationMenu()?.menu_mode" (ngModelChange)="changeMenuMode($event)"><option value="inherit">Use restaurant master menu</option><option value="override">Use location overrides</option></select></div>
                  @if (locationMenu()?.menu_mode === 'inherit') {
                    <div class="helper-panel"><strong>Master menu connected</strong><p>Every restaurant menu change automatically appears here. No products are duplicated.</p></div>
                  }
                  <div class="menu-list">
                    @for (product of locationMenu()?.products || []; track product.source + '-' + product.id) {
                      <div class="menu-row">
                        <label class="menu-enabled"><input type="checkbox" [checked]="overrideEnabled(product)" [disabled]="locationMenu()?.menu_mode === 'inherit'" (change)="setMenuEnabled(product, $event)"></label>
                        <div><strong>{{ product.name }}</strong><small>Master price {{ formatMoney(product.price_cents) }}</small></div>
                        <label>Location price <input type="number" min="0" step="0.01" [value]="overridePrice(product)" [disabled]="locationMenu()?.menu_mode === 'inherit'" (change)="setMenuPrice(product, $event)"></label>
                      </div>
                    }
                  </div>
                </section>
              } @else if (activeTab() === 'hours') {
                <section class="settings-section">
                  <div class="section-heading"><div><h3>Opening and ordering hours</h3><p>Ordering hours can finish before the public venue closes.</p></div><select [(ngModel)]="hoursMode"><option value="inherit">Use restaurant hours</option><option value="override">Use location hours</option></select></div>
                  @if (hoursMode === 'inherit') {
                    <div class="helper-panel"><strong>Following restaurant defaults</strong><p>Select location hours to edit this schedule independently. Resetting returns to the restaurant schedule without deleting it.</p></div>
                  }
                  <div class="week-grid" [class.disabled]="hoursMode === 'inherit'">
                    @for (day of days; track day.key) {
                      <div class="day-row"><strong>{{ day.label }}</strong><label class="check-label"><input type="checkbox" [(ngModel)]="hoursSchedule[day.key].closed" [disabled]="hoursMode === 'inherit'"> Closed</label><label>Open <input type="time" [(ngModel)]="hoursSchedule[day.key].open" [disabled]="hoursMode === 'inherit' || hoursSchedule[day.key].closed"></label><label>Public closes <input type="time" [(ngModel)]="hoursSchedule[day.key].openingClose" [disabled]="hoursMode === 'inherit' || hoursSchedule[day.key].closed"></label><label>Ordering closes <input type="time" [(ngModel)]="hoursSchedule[day.key].orderingClose" [disabled]="hoursMode === 'inherit' || hoursSchedule[day.key].closed"></label></div>
                    }
                  </div>
                  <div class="date-exception"><h4>Date exception</h4><label>From <input type="date" [(ngModel)]="exceptionForm.date_from"></label><label>To <input type="date" [(ngModel)]="exceptionForm.date_to"></label><label class="check-label"><input type="checkbox" [(ngModel)]="exceptionForm.is_closed"> Closed all day</label>@if (!exceptionForm.is_closed) { <label>Open <input type="time" [(ngModel)]="exceptionForm.open"></label><label>Public closes <input type="time" [(ngModel)]="exceptionForm.opening_close"></label><label>Ordering closes <input type="time" [(ngModel)]="exceptionForm.ordering_close"></label> }<input [(ngModel)]="exceptionForm.note" placeholder="Optional note"><button type="button" class="btn btn-secondary" (click)="addDateException()">Add exception</button></div>
                  @if (dateOverrides.length) { <div class="exception-list">@for (exception of dateOverrides; track exception.override_date || exception.date_from) { <span>{{ exception.override_date || exception.date_from }}{{ exception.date_to && exception.date_to !== exception.date_from ? ' to ' + exception.date_to : '' }} · {{ exception.is_closed ? 'Closed' : 'Custom hours' }} <button type="button" (click)="removeDateException(exception.override_date || exception.date_from)">Remove</button></span> }</div> }
                  <div class="section-actions"><button type="button" class="btn btn-primary" (click)="saveHours()">Save hours</button></div>
                </section>
              } @else if (activeTab() === 'routing') {
                <section class="settings-section">
                  <div class="section-heading"><div><h3>Kitchen routing</h3><p>All products still respect their explicit preparation station first.</p></div></div>
                  <div class="form-grid">
                    <label>Routing mode <select [(ngModel)]="kitchenMode"><option value="inherit">Use restaurant main kitchen</option><option value="override">Use another kitchen station</option></select></label>
                    <label>Kitchen station <select [(ngModel)]="selectedKitchenStationId" [disabled]="kitchenMode === 'inherit'"><option [ngValue]="null">Select station</option>@for (station of kitchenStations(); track station.id) { <option [ngValue]="station.id">{{ station.name }}</option> }</select></label>
                  </div>
                  <button type="button" class="btn btn-primary" (click)="saveKitchenRouting()">Save kitchen routing</button>
                </section>
                <section class="settings-section">
                  <h3>Payment routing</h3>
                  <p>Payments currently inherit the restaurant Stripe account. Historical orders retain the safe account reference used at payment time.</p>
                  <div class="routing-state"><span>Current mode</span><strong>{{ routing()?.payment_mode === 'inherit' ? 'Restaurant Stripe account' : routing()?.resolved_payment_account }}</strong></div>
                  @if (!routing()?.payment_override_enabled) { <div class="helper-panel"><strong>Separate accounts are safely disabled</strong><p>The data model is ready, but a location cannot switch accounts until platform approval and Stripe reconciliation are enabled.</p></div> }
                </section>
              }
            </div>
          </section>
        }
      </div>
    </app-sidebar>
  `,
  styles: [`
    :host{display:block}.location-page{max-width:1380px;margin:0 auto;padding:32px;color:#1d252c}.page-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:28px;margin-bottom:28px}.page-heading h1{margin:2px 0 8px;font-size:clamp(1.9rem,3vw,2.75rem);letter-spacing:-.04em}.page-heading p{max-width:680px;margin:0;color:#66717b;line-height:1.55}.section-kicker{margin:0!important;color:#c95032!important;font-size:.72rem!important;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.btn{min-height:42px;padding:0 16px;border:1px solid transparent;border-radius:9px;font:inherit;font-weight:750;white-space:nowrap;cursor:pointer}.btn:active{transform:translateY(1px)}.btn-primary{background:#c95032;color:#fff}.btn-primary:hover{background:#ae3f26}.btn-secondary{border-color:#ccd3d8;background:#fff;color:#26313a}.btn-warning{background:#f3b339;color:#342500}.btn:disabled{cursor:not-allowed;opacity:.55}.alert{margin:0 0 18px;padding:13px 15px;border-radius:10px}.alert-error{background:#fee9e5;color:#8f2d1c}.location-skeleton{display:grid;gap:10px}.location-skeleton span,.detail-skeleton span{height:88px;border-radius:12px;background:#edf0f2}.usage-strip{display:grid;grid-template-columns:repeat(3,minmax(150px,1fr)) auto;align-items:center;gap:1px;margin-bottom:20px;overflow:hidden;border:1px solid #dce1e4;border-radius:12px;background:#dce1e4}.usage-strip>div,.usage-strip>a{height:76px;padding:14px 18px;background:#fff}.usage-strip div{display:grid;gap:4px}.usage-strip span{color:#6a747d;font-size:.78rem}.usage-strip strong{font-size:1.25rem}.usage-strip a{display:grid;place-items:center;color:#b44329;font-weight:750;text-decoration:none}.location-list{overflow:hidden;border:1px solid #dce1e4;border-radius:12px;background:#fff}.location-row{display:grid;width:100%;grid-template-columns:48px minmax(220px,1.5fr) minmax(135px,.65fr) minmax(180px,1fr) auto 24px;align-items:center;gap:16px;padding:16px 18px;border:0;border-bottom:1px solid #edf0f2;background:#fff;color:inherit;text-align:left;cursor:pointer}.location-row:last-child{border-bottom:0}.location-row:hover,.location-row-active{background:#faf8f7}.location-mark{display:grid;width:42px;height:42px;place-items:center;border-radius:10px;background:#26313a;color:#fff;font-weight:850}.location-mark[data-kind=hotel_building]{background:#466378}.location-identity,.location-counts,.inheritance-summary{display:grid;gap:4px}.location-row small{color:#737d85}.inheritance-summary{grid-template-columns:1fr}.inheritance-summary small{text-transform:capitalize}.status-chip{padding:6px 10px;border-radius:999px;background:#e3f4e9;color:#286442;font-size:.75rem;font-weight:800}.status-chip-paused{background:#fff1cc;color:#765400}.status-chip-inactive{background:#e9ecef;color:#5a6269}.row-arrow{font-size:1.6rem;color:#9aa2a8}.empty-state{display:grid;place-items:center;min-height:260px;padding:30px;text-align:center}.empty-state p{color:#6f7880}.drawer-backdrop{position:fixed;inset:0;z-index:1000;background:rgba(17,24,29,.58)}.form-drawer,.location-workspace{position:fixed;z-index:1001;top:0;right:0;height:100dvh;overflow:hidden;background:#f6f7f8;box-shadow:-20px 0 80px rgba(17,24,29,.2)}.form-drawer{width:min(520px,100vw)}.location-workspace{width:min(1040px,100vw)}.form-drawer>header,.workspace-header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:22px 24px;border-bottom:1px solid #dce1e4;background:#fff}.form-drawer h2,.workspace-header h2{margin:3px 0 0;font-size:1.55rem}.workspace-header p{margin:6px 0 0;color:#6e7881}.icon-close{min-height:38px;padding:0 12px;border:1px solid #d6dce0;border-radius:8px;background:#fff;color:#344049;font-weight:700;cursor:pointer}.drawer-form{display:grid;gap:18px;padding:24px}.drawer-form label,.form-grid label,.inline-form label,.menu-row>label,.bulk-grid label{display:grid;gap:6px;color:#3d4850;font-size:.82rem;font-weight:700}.drawer-form input,.drawer-form select,.form-grid input,.form-grid select,.inline-form input,.inline-form select,.bulk-grid input,.bulk-grid select,.bulk-grid textarea,.service-control input,.section-heading select,.menu-row input,.date-exception input,.week-grid input,.routing-state{min-height:42px;padding:9px 11px;border:1px solid #cbd2d7;border-radius:8px;background:#fff;color:#1e282f;font:inherit}.drawer-form small{color:#768089;font-weight:400;line-height:1.4}.drawer-form footer{display:flex;justify-content:flex-end;gap:10px;margin-top:6px}.helper-panel{padding:14px;border-left:3px solid #c95032;border-radius:4px 9px 9px 4px;background:#fff}.helper-panel p{margin:5px 0 0;color:#69737b;line-height:1.5}.workspace-tabs{display:flex;gap:3px;overflow:auto;padding:9px 18px;border-bottom:1px solid #dce1e4;background:#fff}.workspace-tabs button{padding:10px 13px;border:0;border-radius:8px;background:transparent;color:#66717a;font-weight:750;white-space:nowrap}.workspace-tabs button.active{background:#26313a;color:#fff}.workspace-body{height:calc(100dvh - 153px);overflow:auto;padding:22px}.detail-skeleton{display:grid;gap:12px}.settings-section{margin-bottom:18px;padding:20px;border:1px solid #dce1e4;border-radius:12px;background:#fff}.settings-section h3{margin:0;font-size:1.08rem}.settings-section>p,.section-heading p,.service-control p{margin:5px 0 0;color:#6c767e;line-height:1.5}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:18px}.section-heading select{min-width:220px}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.section-actions{display:flex;justify-content:flex-end;margin-top:16px}.service-control{display:grid;grid-template-columns:minmax(240px,1fr) minmax(180px,.7fr) auto;align-items:end;gap:14px}.pause-reason{padding:12px;border-radius:8px;background:#fff3cd;color:#735500}.readiness-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.readiness-grid div{display:grid;gap:5px;padding:14px;border:1px solid #e1e5e8;border-radius:10px;background:#fff}.readiness-grid span{color:#9a4a32;font-size:.7rem;font-weight:800;text-transform:uppercase}.readiness-grid .ready span{color:#2b7750}.inline-form{display:grid;grid-template-columns:140px 1fr 110px minmax(170px,auto) auto;align-items:end;gap:12px;margin-bottom:16px;padding:15px;border-radius:10px;background:#f3f5f6}.inline-form>div{display:flex;gap:8px}.check-label{display:flex!important;align-items:center;gap:8px!important}.check-label input{min-height:auto!important}.bulk-panel{margin:14px 0;border:1px solid #dce1e4;border-radius:10px}.bulk-panel summary{padding:14px 16px;font-weight:800;cursor:pointer}.bulk-panel>p,.bulk-panel>.form-grid,.bulk-panel>button,.bulk-preview{margin:0 16px 14px}.bulk-grid .wide{grid-column:1/-1}.bulk-grid textarea{min-height:72px;resize:vertical}.bulk-preview{display:grid;gap:7px;padding:14px;border-radius:9px;background:#e8f5ec}.bulk-preview-error{background:#fee9e5}.preview-labels{max-height:70px;overflow:auto;color:#5f6971;font-size:.78rem;line-height:1.5}.point-list,.menu-list{display:grid;border-top:1px solid #edf0f2}.point-row,.menu-row{display:grid;grid-template-columns:auto minmax(180px,1fr) auto auto;align-items:center;gap:14px;padding:13px 4px;border-bottom:1px solid #edf0f2}.point-row>div,.menu-row>div{display:grid;gap:4px}.point-row small,.menu-row small{color:#747e86}.point-kind{min-width:54px;color:#a9432b;font-size:.72rem;font-weight:850;text-transform:uppercase}.toggle{display:flex;align-items:center;gap:8px;color:#56616a;font-size:.78rem}.text-link{color:#b3452c;font-weight:750;text-decoration:none}.empty-inline{padding:24px;color:#727c84;text-align:center}.menu-row{grid-template-columns:38px minmax(180px,1fr) 170px}.menu-enabled input{width:22px;height:22px;accent-color:#2f7c55}.week-grid{display:grid;border:1px solid #e1e5e8;border-radius:10px}.week-grid.disabled{opacity:.68}.day-row{display:grid;grid-template-columns:120px 120px 1fr 1fr;align-items:center;gap:12px;padding:10px 12px;border-bottom:1px solid #e8ebed}.day-row:last-child{border-bottom:0}.day-row label{display:grid;gap:4px;color:#69737b;font-size:.72rem}.date-exception{display:grid;grid-template-columns:auto 150px auto 1fr auto;align-items:center;gap:10px;margin-top:16px}.date-exception h4{margin:0}.exception-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.exception-list span{padding:7px 9px;border-radius:7px;background:#eef1f3;font-size:.78rem}.exception-list button{border:0;background:transparent;color:#a23f29}.routing-state{display:flex;justify-content:space-between;margin:14px 0}.alert,.settings-section,.location-row,.form-drawer,.location-workspace{animation:reveal .18s ease-out}@keyframes reveal{from{opacity:.6;transform:translateY(3px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){.alert,.settings-section,.location-row,.form-drawer,.location-workspace{animation:none}}@media(max-width:900px){.location-page{padding:22px 16px}.page-heading{align-items:flex-start;flex-direction:column}.usage-strip{grid-template-columns:repeat(3,1fr)}.usage-strip>a{grid-column:1/-1;height:52px}.location-row{grid-template-columns:44px minmax(0,1fr) auto 20px}.location-counts,.inheritance-summary{display:none}.readiness-grid{grid-template-columns:repeat(2,1fr)}.inline-form{grid-template-columns:1fr 1fr}.inline-form>div{grid-column:1/-1}.service-control{grid-template-columns:1fr}.date-exception{grid-template-columns:1fr 1fr}.date-exception h4{grid-column:1/-1}}@media(max-width:640px){.location-page{padding:16px 10px}.usage-strip{grid-template-columns:1fr}.usage-strip>a{grid-column:auto}.location-row{padding:13px 11px}.status-chip{display:none}.workspace-body{padding:12px}.form-grid,.readiness-grid{grid-template-columns:1fr}.section-heading{align-items:stretch;flex-direction:column}.section-heading select{min-width:0}.inline-form,.day-row,.date-exception{grid-template-columns:1fr}.point-row{grid-template-columns:auto 1fr}.point-row .toggle,.point-row .text-link{grid-column:2}.menu-row{grid-template-columns:34px 1fr}.menu-row>label:last-child{grid-column:2}.workspace-tabs{padding-inline:8px}}
  `, `
    .day-row { grid-template-columns: 110px 105px repeat(3, 1fr); gap: 10px; }
    .date-exception { grid-template-columns: repeat(3, minmax(150px, 1fr)); align-items: end; }
    .date-exception h4 { grid-column: 1 / -1; }
    @media (max-width: 900px) { .day-row { grid-template-columns: 100px 100px repeat(3, 1fr); } }
    @media (max-width: 640px) { .day-row, .date-exception { grid-template-columns: 1fr; } }
  `],
})
export class LocationsComponent implements OnInit {
  private api = inject(ApiService);

  readonly days = DAYS;
  readonly tabs: Array<{ key: LocationTab; label: string }> = [
    { key: 'overview', label: 'Overview' },
    { key: 'points', label: 'Rooms and tables' },
    { key: 'menu', label: 'Menu' },
    { key: 'hours', label: 'Hours' },
    { key: 'routing', label: 'Kitchen and payments' },
  ];

  locations = signal<TenantLocation[]>([]);
  selectedLocation = signal<TenantLocation | null>(null);
  points = signal<Table[]>([]);
  locationMenu = signal<LocationMenuResponse | null>(null);
  locationHours = signal<LocationHoursResponse | null>(null);
  routing = signal<LocationRoutingResponse | null>(null);
  kitchenStations = signal<KitchenStation[]>([]);
  loading = signal(true);
  detailLoading = signal(false);
  saving = signal(false);
  error = signal('');
  showCreate = signal(false);
  showPointForm = signal(false);
  activeTab = signal<LocationTab>('overview');
  bulkPreview = signal<any | null>(null);

  usage = computed(() => this.locations()[0]?.ordering_point_usage || 0);
  limit = computed(() => this.locations()[0]?.ordering_point_limit || 0);
  available = computed(() => Math.max(0, this.limit() - this.usage()));
  unlimited = computed(() => !!this.locations()[0]?.ordering_points_unlimited);

  newLocation = { name: '', display_name: '', location_type: 'pub' };
  editLocation = { name: '', display_name: '', location_type: 'pub', sort_order: 0 };
  pointForm = { service_point_type: 'table', display_number: '', seat_count: 4, is_ordering_enabled: true };
  bulkForm: any = { service_point_type: 'room', start_number: null, end_number: null, values: '', seat_count: 2, is_ordering_enabled: true };
  pauseReason = '';
  hoursMode: 'inherit' | 'override' = 'inherit';
  hoursSchedule: Record<WeekDay, { open: string; openingClose: string; orderingClose: string; closed: boolean }> = this.emptyWeek();
  dateOverrides: any[] = [];
  exceptionForm: any = { date_from: '', date_to: '', is_closed: true, open: '12:00', opening_close: '23:00', ordering_close: '22:00', note: '' };
  kitchenMode: 'inherit' | 'override' = 'inherit';
  selectedKitchenStationId: number | null = null;

  ngOnInit(): void { this.loadLocations(); }

  loadLocations(selectId?: number): void {
    this.loading.set(true); this.error.set('');
    this.api.getLocations().subscribe({
      next: (rows) => {
        this.locations.set(rows); this.loading.set(false);
        if (selectId != null) { const match = rows.find((row) => row.id === selectId); if (match) this.openLocation(match); }
      },
      error: (err) => { this.error.set(err?.error?.detail || 'Could not load locations.'); this.loading.set(false); },
    });
  }

  createLocation(event: Event): void {
    event.preventDefault(); this.saving.set(true); this.error.set('');
    this.api.createLocation(this.newLocation).subscribe({
      next: (row) => { this.saving.set(false); this.showCreate.set(false); this.newLocation = { name: '', display_name: '', location_type: 'pub' }; this.loadLocations(row.id); },
      error: (err) => { this.saving.set(false); this.error.set(err?.error?.detail || 'Could not create location.'); },
    });
  }

  openLocation(location: TenantLocation): void {
    this.selectedLocation.set(location); this.activeTab.set('overview'); this.detailLoading.set(true); this.error.set('');
    this.editLocation = { name: location.name, display_name: location.display_name, location_type: location.location_type, sort_order: location.sort_order };
    forkJoin({
      points: this.api.getLocationOrderingPoints(location.id),
      menu: this.api.getLocationMenu(location.id),
      hours: this.api.getLocationHours(location.id),
      routing: this.api.getLocationRouting(location.id),
      stations: this.api.getKitchenStations(),
    }).subscribe({
      next: ({ points, menu, hours, routing, stations }) => {
        this.points.set(points); this.locationMenu.set(menu); this.locationHours.set(hours); this.routing.set(routing); this.kitchenStations.set(stations);
        this.hoursMode = hours.hours_mode; this.hydrateHours(hours); this.kitchenMode = routing.kitchen_mode; this.selectedKitchenStationId = routing.default_kitchen_station_id ?? null; this.detailLoading.set(false);
      },
      error: (err) => { this.error.set(err?.error?.detail || 'Could not load location settings.'); this.detailLoading.set(false); },
    });
  }

  closeLocation(): void { this.selectedLocation.set(null); this.bulkPreview.set(null); }
  locationLabel(kind: string): string { return kind === 'hotel_building' ? 'Hotel building' : kind === 'lounge' ? 'Lounge' : kind === 'pub' ? 'Pub or restaurant' : 'Service location'; }
  readinessEntries(location: TenantLocation): Array<[string, boolean]> { return Object.entries(location.readiness || {}); }
  readinessLabel(key: string): string { return ({ identity: 'Identity', menu: 'Menu', hours: 'Hours', kitchen: 'Kitchen', payment: 'Payments', plaques: 'QR/NFC plaques' } as Record<string, string>)[key] || key; }
  formatMoney(cents: number): string { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format((cents || 0) / 100); }

  saveIdentity(): void {
    const current = this.selectedLocation(); if (!current) return; this.saving.set(true);
    this.api.updateLocation(current.id, this.editLocation as any).subscribe({ next: (row) => { this.saving.set(false); this.selectedLocation.set(row); this.loadLocations(); }, error: (err) => { this.saving.set(false); this.error.set(err?.error?.detail || 'Could not save location.'); } });
  }
  pauseOrdering(): void { const row = this.selectedLocation(); if (!row) return; this.api.pauseLocation(row.id, this.pauseReason).subscribe({ next: () => this.refreshSelected(row.id), error: (err) => this.error.set(err?.error?.detail || 'Could not pause location.') }); }
  resumeOrdering(): void { const row = this.selectedLocation(); if (!row) return; this.api.resumeLocation(row.id).subscribe({ next: () => this.refreshSelected(row.id), error: (err) => this.error.set(err?.error?.detail || 'Could not resume location.') }); }
  private refreshSelected(id: number): void { this.api.getLocations().subscribe((rows) => { this.locations.set(rows); const row = rows.find((item) => item.id === id); if (row) { this.selectedLocation.set(row); this.editLocation = { name: row.name, display_name: row.display_name, location_type: row.location_type, sort_order: row.sort_order }; } }); }

  createPoint(event: Event): void { event.preventDefault(); const location = this.selectedLocation(); if (!location) return; this.api.createLocationOrderingPoint(location.id, this.pointForm).subscribe({ next: () => { this.pointForm.display_number = ''; this.showPointForm.set(false); this.reloadPoints(location.id); this.refreshSelected(location.id); }, error: (err) => this.error.set(this.apiError(err)) }); }
  togglePoint(point: Table, event: Event): void { const location = this.selectedLocation(); if (!location || point.id == null) return; const enabled = (event.target as HTMLInputElement).checked; this.api.updateLocationOrderingPoint(location.id, point.id, { is_ordering_enabled: enabled }).subscribe({ next: () => { this.reloadPoints(location.id); this.refreshSelected(location.id); }, error: (err) => { (event.target as HTMLInputElement).checked = !enabled; this.error.set(this.apiError(err)); } }); }
  previewBulk(): void { const location = this.selectedLocation(); if (!location) return; this.bulkPreview.set(null); this.api.previewLocationOrderingPoints(location.id, this.bulkBody()).subscribe({ next: (preview) => this.bulkPreview.set(preview), error: (err) => this.error.set(this.apiError(err)) }); }
  confirmBulk(): void { const location = this.selectedLocation(); if (!location) return; this.saving.set(true); this.api.bulkCreateLocationOrderingPoints(location.id, this.bulkBody()).subscribe({ next: () => { this.saving.set(false); this.bulkPreview.set(null); this.reloadPoints(location.id); this.refreshSelected(location.id); }, error: (err) => { this.saving.set(false); this.error.set(this.apiError(err)); } }); }
  private bulkBody(): Record<string, unknown> { return { ...this.bulkForm, start_number: this.bulkForm.values?.trim() ? null : this.bulkForm.start_number, end_number: this.bulkForm.values?.trim() ? null : this.bulkForm.end_number, values: this.bulkForm.values?.trim() || null }; }
  private reloadPoints(id: number): void { this.api.getLocationOrderingPoints(id).subscribe((rows) => this.points.set(rows)); }

  changeMenuMode(mode: 'inherit' | 'override'): void { const location = this.selectedLocation(); if (!location) return; this.api.updateLocationMenuMode(location.id, mode).subscribe({ next: () => this.reloadMenu(location.id), error: (err) => this.error.set(this.apiError(err)) }); }
  overrideEnabled(product: LocationMenuResponse['products'][number]): boolean { const override: any = product.override; return override?.enabled !== false && product.master_enabled; }
  overridePrice(product: LocationMenuResponse['products'][number]): string { const override: any = product.override; return override?.price_cents_override != null ? (override.price_cents_override / 100).toFixed(2) : ''; }
  setMenuEnabled(product: LocationMenuResponse['products'][number], event: Event): void { this.saveMenuOverride(product, { enabled: (event.target as HTMLInputElement).checked }); }
  setMenuPrice(product: LocationMenuResponse['products'][number], event: Event): void { const raw = (event.target as HTMLInputElement).value; this.saveMenuOverride(product, { price_cents_override: raw === '' ? null : Math.round(Number(raw) * 100) }); }
  private saveMenuOverride(product: LocationMenuResponse['products'][number], patch: Record<string, unknown>): void { const location = this.selectedLocation(); if (!location) return; const current: any = product.override || {}; this.api.updateLocationMenuProduct(location.id, product.id, { source: product.source, enabled: current.enabled ?? true, price_cents_override: current.price_cents_override ?? null, ...patch }).subscribe({ next: () => this.reloadMenu(location.id), error: (err) => this.error.set(this.apiError(err)) }); }
  private reloadMenu(id: number): void { this.api.getLocationMenu(id).subscribe((menu) => this.locationMenu.set(menu)); }

  private emptyWeek(): Record<WeekDay, { open: string; openingClose: string; orderingClose: string; closed: boolean }> { return Object.fromEntries(DAYS.map((day) => [day.key, { open: '12:00', openingClose: '23:00', orderingClose: '22:00', closed: false }])) as Record<WeekDay, { open: string; openingClose: string; orderingClose: string; closed: boolean }>; }
  private hydrateHours(hours: LocationHoursResponse): void { const opening: any = hours.opening_hours_override || hours.effective_opening_hours || {}; const ordering: any = hours.ordering_hours_override || hours.effective_ordering_hours || {}; this.hoursSchedule = this.emptyWeek(); for (const day of DAYS) { const openRow = opening[day.key] || {}; const orderRow = ordering[day.key] || {}; if (opening[day.key] || ordering[day.key]) this.hoursSchedule[day.key] = { open: orderRow.open || openRow.open || '12:00', openingClose: openRow.close || orderRow.close || '23:00', orderingClose: orderRow.close || openRow.close || '22:00', closed: !!(openRow.closed || orderRow.closed) }; } this.dateOverrides = [...(hours.date_overrides || [])]; }
  addDateException(): void { if (!this.exceptionForm.date_from) return; const dateTo = this.exceptionForm.date_to || this.exceptionForm.date_from; const custom = this.exceptionForm.is_closed ? {} : { opening_hours: { open: this.exceptionForm.open, close: this.exceptionForm.opening_close, closed: false }, ordering_hours: { open: this.exceptionForm.open, close: this.exceptionForm.ordering_close, closed: false } }; this.dateOverrides = [...this.dateOverrides, { date_from: this.exceptionForm.date_from, date_to: dateTo, is_closed: this.exceptionForm.is_closed, note: this.exceptionForm.note || null, ...custom }]; this.exceptionForm = { date_from: '', date_to: '', is_closed: true, open: '12:00', opening_close: '23:00', ordering_close: '22:00', note: '' }; }
  removeDateException(value: string): void { this.dateOverrides = this.dateOverrides.filter((row) => (row.override_date || row.date_from) !== value); }
  saveHours(): void { const location = this.selectedLocation(); if (!location) return; const openingSchedule = Object.fromEntries(DAYS.map((day) => [day.key, { open: this.hoursSchedule[day.key].open, close: this.hoursSchedule[day.key].openingClose, closed: this.hoursSchedule[day.key].closed }])); const orderingSchedule = Object.fromEntries(DAYS.map((day) => [day.key, { open: this.hoursSchedule[day.key].open, close: this.hoursSchedule[day.key].orderingClose, closed: this.hoursSchedule[day.key].closed }])); this.api.updateLocationHours(location.id, { mode: this.hoursMode, opening_hours_override: this.hoursMode === 'override' ? openingSchedule : null, ordering_hours_override: this.hoursMode === 'override' ? orderingSchedule : null, date_overrides: this.dateOverrides }).subscribe({ next: (hours) => { this.locationHours.set(hours); this.refreshSelected(location.id); }, error: (err) => this.error.set(this.apiError(err)) }); }

  saveKitchenRouting(): void { const location = this.selectedLocation(); if (!location) return; this.api.updateLocationKitchenRouting(location.id, this.kitchenMode, this.selectedKitchenStationId).subscribe({ next: (routing) => { this.routing.set(routing); this.refreshSelected(location.id); }, error: (err) => this.error.set(this.apiError(err)) }); }
  private apiError(err: any): string { const detail = err?.error?.detail; return typeof detail === 'string' ? detail : detail?.message || 'The change could not be saved.'; }
}
