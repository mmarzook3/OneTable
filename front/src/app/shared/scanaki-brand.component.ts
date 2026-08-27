import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-scanaki-brand',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="scanaki-brand" aria-label="Scanaki">
      <img
        class="scanaki-brand__mark"
        src="/scanaki-logo.svg"
        alt=""
        [style.width.px]="size()"
        [style.height.px]="size()"
      />
      @if (showName()) {
        <span class="scanaki-brand__name">Scanaki</span>
      }
    </span>
  `,
  styles: [`
    :host { display: inline-flex; min-width: 0; color: inherit; }
    .scanaki-brand { display: inline-flex; align-items: center; gap: .72em; min-width: 0; color: inherit; }
    .scanaki-brand__mark { display: block; flex: 0 0 auto; object-fit: contain; }
    .scanaki-brand__name { color: inherit; font: inherit; font-weight: 700; letter-spacing: -.025em; }
  `],
})
export class ScanakiBrandComponent {
  readonly size = input(36);
  readonly showName = input(true);
}
