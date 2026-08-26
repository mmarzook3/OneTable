import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService, PlatformInfo } from '../services/api.service';

interface PlatformNavItem {
  label: string;
  short: string;
  route: string;
  exact?: boolean;
}

@Component({
  selector: 'app-platform-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="crm-shell" [class.crm-shell--nav-open]="navOpen()">
      <button type="button" class="crm-scrim" aria-label="Close navigation" (click)="closeNav()"></button>

      <aside class="crm-sidebar" aria-label="Platform navigation">
        <a routerLink="/platform" class="crm-brand" (click)="closeNav()">
          <span class="crm-brand__mark" aria-hidden="true">S</span>
          <span><strong>Scanaki</strong><small>Control centre</small></span>
        </a>

        <nav class="crm-nav">
          <section>
            <p class="crm-nav__label">Workspace</p>
            @for (item of workspaceNav; track item.route) {
              <a
                [routerLink]="item.route"
                routerLinkActive="crm-nav__item--active"
                [routerLinkActiveOptions]="{ exact: item.exact || false }"
                [class.crm-nav__item--context]="item.route === '/platform/restaurants' && currentTitle() === 'Restaurant details'"
                class="crm-nav__item"
                (click)="closeNav()"
              >
                <span class="crm-nav__key" aria-hidden="true">{{ item.short }}</span>
                <span>{{ item.label }}</span>
              </a>
            }
          </section>

          <section>
            <p class="crm-nav__label">Revenue</p>
            @for (item of revenueNav; track item.route) {
              <a [routerLink]="item.route" routerLinkActive="crm-nav__item--active" class="crm-nav__item" (click)="closeNav()">
                <span class="crm-nav__key" aria-hidden="true">{{ item.short }}</span>
                <span>{{ item.label }}</span>
              </a>
            }
          </section>

          <section>
            <p class="crm-nav__label">Operations</p>
            @for (item of operationsNav; track item.route) {
              <a [routerLink]="item.route" routerLinkActive="crm-nav__item--active" class="crm-nav__item" (click)="closeNav()">
                <span class="crm-nav__key" aria-hidden="true">{{ item.short }}</span>
                <span>{{ item.label }}</span>
              </a>
            }
          </section>
        </nav>

        <div class="crm-sidebar__bottom">
          <a routerLink="/platform/restaurants/new" class="crm-create" (click)="closeNav()">Create restaurant</a>
          <div class="crm-user">
            <span class="crm-user__avatar" aria-hidden="true">{{ initials() }}</span>
            <span class="crm-user__identity"><strong>{{ profile()?.email || 'Platform operator' }}</strong><small>Super admin</small></span>
            <button type="button" (click)="logout()">Log out</button>
          </div>
        </div>
      </aside>

      <section class="crm-main">
        <header class="crm-topbar">
          <div class="crm-topbar__start">
            <button type="button" class="crm-menu-button" (click)="navOpen.set(true)" aria-label="Open navigation">Menu</button>
            <div><small>Scanaki platform</small><strong>{{ currentTitle() }}</strong></div>
          </div>
          <div class="crm-topbar__actions">
            <a href="/" target="_blank" rel="noopener noreferrer" class="crm-site-link">Open public site</a>
            <a routerLink="/platform/restaurants/new" class="crm-topbar__create">Create restaurant</a>
          </div>
        </header>

        <main class="crm-content">
          <router-outlet></router-outlet>
        </main>
      </section>
    </div>
  `,
  styles: [`
    :host{display:block}
    .crm-shell{
      --crm-bg:#f3f5f7;--crm-panel:#fff;--crm-sidebar:#18191b;--crm-sidebar-soft:#24262a;
      --crm-border:#dfe3e8;--crm-text:#202226;--crm-muted:#6b7280;--crm-accent:#c95d3e;
      --color-bg:var(--crm-bg);--color-surface:var(--crm-panel);--color-text:var(--crm-text);
      --color-text-muted:var(--crm-muted);--color-border:var(--crm-border);--color-primary:var(--crm-accent);
      min-height:100dvh;background:var(--crm-bg);color:var(--crm-text)
    }
    .crm-sidebar{position:fixed;inset:0 auto 0 0;z-index:30;width:252px;display:flex;flex-direction:column;padding:20px 14px;background:var(--crm-sidebar);color:#f7f7f8;border-right:1px solid #2e3035}
    .crm-brand{display:flex;align-items:center;gap:11px;padding:4px 8px 22px;color:#fff;text-decoration:none}.crm-brand:hover{text-decoration:none}.crm-brand__mark{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:var(--crm-accent);color:#fff;font-weight:800}.crm-brand>span:last-child{display:grid;line-height:1.2}.crm-brand strong{font-size:15px}.crm-brand small{margin-top:3px;color:#9ca1ab;font-size:11px}
    .crm-nav{display:grid;gap:20px;overflow-y:auto;padding:4px}.crm-nav section{display:grid;gap:4px}.crm-nav__label{margin:0 8px 5px;color:#787e89;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}.crm-nav__item{position:relative;display:flex;align-items:center;gap:10px;min-height:42px;padding:7px 9px;border-radius:9px;color:#bfc3ca;text-decoration:none;font-size:13px;font-weight:600;transition:background .15s ease,color .15s ease}.crm-nav__item:hover{background:#222429;color:#fff;text-decoration:none}.crm-nav__item--active,.crm-nav__item--context{background:#2a2c31;color:#fff}.crm-nav__item--active::before,.crm-nav__item--context::before{content:'';position:absolute;left:-4px;top:9px;bottom:9px;width:3px;border-radius:3px;background:var(--crm-accent)}.crm-nav__key{display:grid;place-items:center;width:26px;height:26px;border:1px solid #3c3f46;border-radius:7px;color:#aeb3bc;font-size:9px;font-weight:800;letter-spacing:.03em}.crm-nav__item--active .crm-nav__key,.crm-nav__item--context .crm-nav__key{border-color:#6d4438;background:#382a27;color:#f3b09b}
    .crm-sidebar__bottom{display:grid;gap:12px;margin-top:auto;padding:14px 4px 0;border-top:1px solid #2d2f34}.crm-create{display:flex;align-items:center;justify-content:center;min-height:40px;border-radius:9px;background:var(--crm-accent);color:#fff;text-decoration:none;font-size:12px;font-weight:750}.crm-create:hover{background:#b95034;text-decoration:none}.crm-user{display:grid;grid-template-columns:auto minmax(0,1fr);gap:9px;align-items:center;padding:8px 5px}.crm-user__avatar{display:grid;place-items:center;width:31px;height:31px;border-radius:9px;background:#303238;color:#fff;font-size:10px;font-weight:800}.crm-user__identity{display:grid;min-width:0;line-height:1.2}.crm-user__identity strong{overflow:hidden;color:#f2f3f5;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.crm-user__identity small{margin-top:3px;color:#858b95;font-size:9px}.crm-user button{grid-column:2;width:max-content;padding:0;border:0;background:transparent;color:#9ba0aa;font-size:10px;text-align:left}.crm-user button:hover{color:#fff}
    .crm-main{min-height:100dvh;margin-left:252px}.crm-topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:16px;height:64px;padding:0 28px;border-bottom:1px solid var(--crm-border);background:rgba(255,255,255,.94);backdrop-filter:blur(12px)}.crm-topbar__start{display:flex;align-items:center;gap:13px}.crm-topbar__start>div{display:grid;line-height:1.15}.crm-topbar__start small{color:var(--crm-muted);font-size:10px}.crm-topbar__start strong{margin-top:3px;font-size:14px}.crm-menu-button{display:none;min-height:36px;padding:0 10px;border:1px solid var(--crm-border);border-radius:8px;background:#fff;color:var(--crm-text);font-weight:700}.crm-topbar__actions{display:flex;align-items:center;gap:8px}.crm-site-link,.crm-topbar__create{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:0 12px;border-radius:8px;text-decoration:none;font-size:11px;font-weight:700;white-space:nowrap}.crm-site-link{border:1px solid var(--crm-border);background:#fff;color:#4a4f58}.crm-topbar__create{border:1px solid var(--crm-accent);background:var(--crm-accent);color:#fff}.crm-site-link:hover,.crm-topbar__create:hover{text-decoration:none}.crm-content{min-width:0;padding:0 26px 40px}.crm-scrim{display:none}
    @media(max-width:900px){.crm-sidebar{transform:translateX(-102%);transition:transform .2s ease}.crm-main{margin-left:0}.crm-menu-button{display:inline-flex;align-items:center}.crm-shell--nav-open .crm-sidebar{transform:translateX(0)}.crm-shell--nav-open .crm-scrim{position:fixed;inset:0;z-index:25;display:block;border:0;background:rgba(20,22,26,.48)}.crm-content{padding:0 16px 32px}.crm-topbar{height:58px;padding:0 16px}.crm-site-link{display:none}}
    @media(max-width:520px){.crm-topbar__create{display:none}.crm-content{padding-inline:10px}.crm-topbar__start small{display:none}}
    @media(prefers-reduced-motion:reduce){.crm-sidebar{transition:none}}
  `],
})
export class PlatformShellComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  navOpen = signal(false);
  profile = signal<PlatformInfo | null>(null);
  currentTitle = signal('Overview');

  readonly workspaceNav: PlatformNavItem[] = [
    { label: 'Overview', short: 'OV', route: '/platform', exact: true },
    { label: 'Restaurants', short: 'RS', route: '/platform/restaurants' },
  ];
  readonly revenueNav: PlatformNavItem[] = [
    { label: 'Subscriptions', short: 'SB', route: '/platform/subscriptions' },
    { label: 'Pricing & offers', short: 'PR', route: '/platform/pricing' },
  ];
  readonly operationsNav: PlatformNavItem[] = [
    { label: 'Smart plaques', short: 'SP', route: '/platform/smart-plaques' },
    { label: 'Platform settings', short: 'ST', route: '/platform/settings' },
  ];

  ngOnInit(): void {
    this.api.getPlatformMe().subscribe({ next: (profile) => this.profile.set(profile) });
    this.setTitle(this.router.url);
    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd), takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => { this.setTitle(event.urlAfterRedirects); this.closeNav(); });
  }

  initials(): string {
    const value = this.profile()?.email || 'SA';
    return value.slice(0, 2).toUpperCase();
  }

  closeNav(): void { this.navOpen.set(false); }

  logout(): void {
    this.api.logout().subscribe(() => this.router.navigate(['/platform/login']));
  }

  private setTitle(url: string): void {
    const path = url.split('?')[0].split('#')[0];
    if (/\/platform\/tenants\/\d+/.test(path)) this.currentTitle.set('Restaurant details');
    else if (path.includes('/restaurants/new')) this.currentTitle.set('Create restaurant');
    else if (path.includes('/restaurants')) this.currentTitle.set('Restaurants');
    else if (path.includes('/subscriptions')) this.currentTitle.set('Subscriptions');
    else if (path.includes('/pricing')) this.currentTitle.set('Pricing & offers');
    else if (path.includes('/smart-plaques')) this.currentTitle.set('Smart plaques');
    else if (path.includes('/settings')) this.currentTitle.set('Platform settings');
    else this.currentTitle.set('Overview');
  }
}
