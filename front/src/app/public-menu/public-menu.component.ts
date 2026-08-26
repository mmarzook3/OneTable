import {
  Component,
  computed,
  inject,
  signal,
  OnInit,
  OnDestroy,
  DestroyRef,
  afterNextRender,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DomSanitizer, SafeResourceUrl, SafeStyle, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { merge } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  ApiService,
  PublicTenantMenuCategory,
  PublicTenantMenuResponse,
  TenantSummary,
} from '../services/api.service';
import { LanguagePickerComponent } from '../shared/language-picker.component';
import { LanguageService } from '../services/language.service';
import { LegalLinksComponent } from '../shared/legal-links.component';

@Component({
  selector: 'app-public-menu',
  standalone: true,
  imports: [RouterLink, TranslateModule, LanguagePickerComponent, LegalLinksComponent],
  templateUrl: './public-menu.component.html',
  styleUrls: ['../book/book.component.scss', './public-menu.component.scss'],
})
export class PublicMenuComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private api = inject(ApiService);
  private translate = inject(TranslateService);
  private language = inject(LanguageService);
  private sanitizer = inject(DomSanitizer);
  private title = inject(Title);
  private destroyRef = inject(DestroyRef);

  tenantId = signal(0);
  tenant = signal<TenantSummary | null>(null);
  menu = signal<PublicTenantMenuResponse | null>(null);
  logoUrl = signal<string | null>(null);
  loading = signal(true);
  menuLoading = signal(false);
  errorKind = signal<'invalid_tenant' | 'tenant_not_found' | 'menu_load_failed' | null>(null);
  searchQuery = signal('');
  selectedCategoryId = signal('all');

  filteredCategories = computed<PublicTenantMenuCategory[]>(() => {
    const query = this.searchQuery().trim().toLocaleLowerCase();
    const selected = this.selectedCategoryId();
    return (this.menu()?.categories ?? [])
      .filter((category) => selected === 'all' || category.id === selected)
      .map((category) => ({
        ...category,
        products: category.products.filter((product) => {
          if (!query) return true;
          return [product.name, product.description, product.category, product.subcategory]
            .filter(Boolean)
            .some((value) => String(value).toLocaleLowerCase().includes(query));
        }),
      }))
      .filter((category) => category.products.length > 0);
  });

  visibleProductCount = computed(() =>
    this.filteredCategories().reduce((total, category) => total + category.products.length, 0),
  );

  constructor() {
    afterNextRender(() => this.updateDocumentTitle());
  }

  ngOnInit(): void {
    const langParam = this.route.snapshot.queryParamMap.get('lang');
    if (langParam?.trim()) {
      this.language.setLanguage(langParam.trim());
    }

    merge(
      this.translate.onLangChange,
      this.translate.onTranslationChange,
      this.translate.onDefaultLangChange,
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.updateDocumentTitle();
        if (this.tenant() && !this.errorKind()) {
          this.reloadMenu();
        }
      });

    const idParam = this.route.snapshot.paramMap.get('tenantId');
    const tid = idParam ? parseInt(idParam, 10) : NaN;
    if (!Number.isFinite(tid) || tid < 1) {
      this.errorKind.set('invalid_tenant');
      this.loading.set(false);
      this.updateDocumentTitle();
      return;
    }
    this.tenantId.set(tid);
    this.updateDocumentTitle();

    this.api.getPublicTenant(tid).subscribe({
      next: (t) => {
        this.tenant.set(t);
        this.logoUrl.set(this.api.getTenantLogoUrl(t.logo_filename ?? undefined, t.id));
        this.loadMenu(tid);
      },
      error: () => {
        this.errorKind.set('tenant_not_found');
        this.loading.set(false);
        this.updateDocumentTitle();
      },
    });
  }

  ngOnDestroy(): void {
    // Title reset handled by next navigation.
  }

  private loadMenu(tenantId: number): void {
    this.menuLoading.set(true);
    this.api.getPublicTenantMenu(tenantId).subscribe({
      next: (data) => {
        this.menu.set(data);
        this.menuLoading.set(false);
        this.loading.set(false);
        this.updateDocumentTitle();
      },
      error: () => {
        this.errorKind.set('menu_load_failed');
        this.menuLoading.set(false);
        this.loading.set(false);
        this.updateDocumentTitle();
      },
    });
  }

  private reloadMenu(): void {
    const tid = this.tenantId();
    if (!tid) return;
    this.menuLoading.set(true);
    this.api.getPublicTenantMenu(tid).subscribe({
      next: (data) => {
        this.menu.set(data);
        this.menuLoading.set(false);
      },
      error: () => {
        this.menuLoading.set(false);
      },
    });
  }

  categories(): PublicTenantMenuCategory[] {
    return this.menu()?.categories ?? [];
  }

  selectCategory(categoryId: string): void {
    this.selectedCategoryId.set(categoryId);
  }

  updateSearch(event: Event): void {
    this.searchQuery.set((event.target as HTMLInputElement).value);
  }

  clearSearch(): void {
    this.searchQuery.set('');
  }

  clearFilters(): void {
    this.searchQuery.set('');
    this.selectedCategoryId.set('all');
  }

  /** Translation key for known API category names; falls back to raw value. */
  getCategoryLabel(category: string): string {
    const keyMap: Record<string, string> = {
      Starters: 'PRODUCTS.CATEGORY_STARTERS',
      'Main Course': 'PRODUCTS.CATEGORY_MAIN_COURSE',
      Desserts: 'PRODUCTS.CATEGORY_DESSERTS',
      Beverages: 'PRODUCTS.CATEGORY_BEVERAGES',
      Sides: 'PRODUCTS.CATEGORY_SIDES',
      Other: 'PUBLIC_MENU.CATEGORY_OTHER',
    };
    const key = keyMap[category];
    if (key) return this.translate.instant(key);
    return category;
  }

  displayName(): string {
    return this.menu()?.tenant_name?.trim() || this.tenant()?.name?.trim() || '';
  }

  currencyLabel(): string {
    return this.menu()?.currency?.trim() || '';
  }

  getLogoSafeUrl(url: string | null): SafeResourceUrl | string {
    if (!url) return '';
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  headerBackgroundStyle(): SafeStyle | null {
    const filename = this.tenant()?.header_background_filename;
    const tid = this.tenant()?.id;
    if (!filename || tid == null) return null;
    const url = this.api.getTenantHeaderBackgroundUrl(filename, tid);
    return this.sanitizer.bypassSecurityTrustStyle(`url('${url}')`);
  }

  productImageUrl(url: string | null | undefined): string {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    const base = environment.apiUrl.replace(/\/$/, '');
    return url.startsWith('/') ? base + url : `${base}/${url}`;
  }

  formatPrice(product: { price_cents: number; price_formatted: string }): string {
    const code = this.currencyLabel() || 'GBP';
    try {
      return new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: code,
      }).format(product.price_cents / 100);
    } catch {
      return `£${product.price_formatted}`;
    }
  }

  handleProductImageError(event: Event): void {
    const image = event.target as HTMLImageElement | null;
    const media = image?.closest('.public-menu-product__media') as HTMLElement | null;
    const card = image?.closest('.public-menu-product');
    if (media) media.hidden = true;
    card?.classList.add('public-menu-product--no-image');
  }

  formatPriceCents(cents: number): string {
    return this.formatPrice({ price_cents: cents, price_formatted: (cents / 100).toFixed(2) });
  }

  private updateDocumentTitle(): void {
    const name = this.displayName();
    const err = this.errorKind();
    let key: string;
    if (this.loading() && !err) {
      key = 'PUBLIC_MENU.LOADING';
    } else if (err === 'invalid_tenant') {
      key = 'PUBLIC_MENU.INVALID_TENANT';
    } else if (err === 'tenant_not_found') {
      key = 'PUBLIC_MENU.TENANT_NOT_FOUND';
    } else if (err === 'menu_load_failed') {
      key = 'PUBLIC_MENU.LOAD_FAILED';
    } else if (name) {
      this.title.setTitle(`${name} - ${this.translate.instant('PUBLIC_MENU.PAGE_TITLE')}`);
      return;
    } else {
      key = 'PUBLIC_MENU.PAGE_TITLE';
    }
    this.title.setTitle(this.translate.instant(key));
  }
}
