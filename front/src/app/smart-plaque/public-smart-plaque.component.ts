import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { ApiService } from '../services/api.service';

@Component({
  selector: 'app-public-smart-plaque',
  standalone: true,
  imports: [TranslateModule],
  template: `
    <main class="resolve-page">
      <section class="resolve-card" aria-live="polite">
        <div class="brand-mark" aria-hidden="true">1</div>
        @if (loading()) {
          <div class="spinner" aria-hidden="true"></div>
          <h1>{{ 'SMART_PLAQUES.OPENING_MENU' | translate }}</h1>
          <p>{{ 'SMART_PLAQUES.RESOLVING_HINT' | translate }}</p>
        } @else {
          <div class="state-icon" aria-hidden="true">!</div>
          <h1>{{ 'SMART_PLAQUES.NOT_ACTIVE_TITLE' | translate }}</h1>
          <p>{{ errorKey() | translate }}</p>
          <button type="button" (click)="resolve()">{{ 'COMMON.TRY_AGAIN' | translate }}</button>
        }
        <small>{{ 'SMART_PLAQUES.POWERED_BY' | translate }}</small>
      </section>
    </main>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; }
    .resolve-page { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, #eef4ff, #f7f8fb 55%); font-family: Inter, system-ui, sans-serif; }
    .resolve-card { width: min(100%, 420px); padding: 40px 30px; text-align: center; background: #fff; border: 1px solid #dde3ee; border-radius: 22px; box-shadow: 0 18px 55px rgba(24,39,75,.1); color: #17223b; }
    .brand-mark { display: grid; place-items: center; width: 44px; height: 44px; margin: 0 auto 28px; border-radius: 13px; background: #2457d6; color: #fff; font-weight: 800; font-size: 20px; }
    h1 { margin: 16px 0 8px; font-size: 1.45rem; letter-spacing: -.025em; }
    p { margin: 0 auto 24px; max-width: 330px; color: #63708a; line-height: 1.55; }
    small { display: block; margin-top: 30px; color: #8a94a8; }
    button { border: 0; border-radius: 10px; padding: 12px 18px; background: #2457d6; color: #fff; font-weight: 700; cursor: pointer; }
    .spinner { width: 34px; height: 34px; margin: 0 auto; border: 3px solid #dfe7f6; border-top-color: #2457d6; border-radius: 50%; animation: spin .8s linear infinite; }
    .state-icon { display: grid; place-items: center; width: 38px; height: 38px; margin: 0 auto; border-radius: 50%; background: #fff1db; color: #9a5a00; font-weight: 800; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `],
})
export class PublicSmartPlaqueComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(ApiService);

  loading = signal(true);
  errorKey = signal('SMART_PLAQUES.NOT_ACTIVE_HINT');

  ngOnInit(): void {
    this.resolve();
  }

  resolve(): void {
    const code = this.route.snapshot.paramMap.get('code') || '';
    this.loading.set(true);
    this.api.resolvePublicSmartPlaque(code).subscribe({
      next: (result) => {
        const [path, query = ''] = result.menu_path.split('?', 2);
        const queryParams = new URLSearchParams(query);
        queryParams.set('via', 'plaque');
        void this.router.navigateByUrl(`${path}?${queryParams.toString()}`, { replaceUrl: true });
      },
      error: (err) => {
        this.errorKey.set(
          err?.status === 404
            ? 'SMART_PLAQUES.NOT_RECOGNISED_HINT'
            : 'SMART_PLAQUES.NOT_ACTIVE_HINT',
        );
        this.loading.set(false);
      },
    });
  }
}
