import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { ScanakiBrandComponent } from '../shared/scanaki-brand.component';

const APK_URL = '/downloads/scanaki-kitchen-0.3.0.apk';

@Component({
  selector: 'app-kitchen-app-download',
  standalone: true,
  imports: [RouterLink, ScanakiBrandComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="download-page">
      <header class="download-header">
        <a routerLink="/" class="brand-link" aria-label="Scanaki home">
          <app-scanaki-brand [size]="40"></app-scanaki-brand>
        </a>
        <a href="mailto:support@scanaki.uk" class="support-link">Need help?</a>
      </header>

      <main>
        <section class="download-intro" aria-labelledby="download-title">
          <div class="app-identity">
            <app-scanaki-brand [size]="88" [showName]="false"></app-scanaki-brand>
            <div>
              <span class="pilot-label">Official pilot app</span>
              <h1 id="download-title">Scanaki Kitchen</h1>
            </div>
          </div>

          <p class="intro-copy">
            Receive paid orders, manage preparation and keep your kitchen queue moving on an Android tablet.
          </p>

          <a
            class="download-button"
            [href]="apkUrl"
            download="scanaki-kitchen-0.3.0.apk"
            data-testid="kitchen-apk-download"
          >
            Download for Android
          </a>
          <p class="release-meta">Version 0.3.0 · Android 9 or newer</p>
        </section>

        <section class="install-guide" aria-labelledby="install-title">
          <h2 id="install-title">Install in four steps</h2>
          <ol>
            <li>
              <span class="step-number">1</span>
              <div><strong>Download the app</strong><p>Open this page on the kitchen tablet and tap the download button.</p></div>
            </li>
            <li>
              <span class="step-number">2</span>
              <div><strong>Open the downloaded file</strong><p>Tap the completed download notification or open it from Downloads.</p></div>
            </li>
            <li>
              <span class="step-number">3</span>
              <div><strong>Allow this installation</strong><p>If Android asks, allow app installation from the browser used for this download.</p></div>
            </li>
            <li>
              <span class="step-number">4</span>
              <div><strong>Install and sign in</strong><p>Open Scanaki Kitchen and use the kitchen credentials supplied by Scanaki.</p></div>
            </li>
          </ol>
        </section>

        <aside class="security-note">
          <strong>Install only from scanaki.uk</strong>
          <p>Android may show a warning because this pilot app is installed outside Google Play. Contact Scanaki if the address bar does not show scanaki.uk.</p>
        </aside>
      </main>

      <footer>
        <span>Scanaki</span>
        <a href="mailto:support@scanaki.uk">support@scanaki.uk</a>
        <a routerLink="/privacy">Privacy</a>
      </footer>
    </div>
  `,
  styles: [`
    :host { display: block; min-height: 100dvh; }
    * { box-sizing: border-box; }
    .download-page {
      min-height: 100dvh;
      background: #f7f7f5;
      color: #171717;
      font-family: Arial, Helvetica, sans-serif;
    }
    .download-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: min(1120px, calc(100% - 40px));
      min-height: 76px;
      margin: 0 auto;
      border-bottom: 1px solid #deded9;
    }
    .brand-link {
      display: inline-flex;
      align-items: center;
      gap: 11px;
      color: inherit;
      font-size: 1.2rem;
      font-weight: 700;
      text-decoration: none;
    }
    .support-link { color: #b84025; font-weight: 600; text-decoration: none; }
    main {
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(360px, .95fr);
      gap: clamp(40px, 7vw, 96px);
      width: min(1040px, calc(100% - 40px));
      margin: 0 auto;
      padding: clamp(54px, 8vw, 104px) 0 64px;
    }
    .download-intro { align-self: start; }
    .app-identity { display: flex; align-items: center; gap: 22px; }
    .app-identity app-scanaki-brand { filter: drop-shadow(0 14px 17px rgba(133, 53, 34, .18)); }
    .pilot-label {
      display: block;
      margin-bottom: 8px;
      color: #b84025;
      font-size: .78rem;
      font-weight: 700;
      letter-spacing: .06em;
      text-transform: uppercase;
    }
    h1 { margin: 0; font-size: clamp(2.45rem, 6vw, 4.6rem); letter-spacing: -.055em; line-height: .98; }
    .intro-copy { max-width: 580px; margin: 34px 0 30px; color: #555550; font-size: 1.18rem; line-height: 1.65; }
    .download-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 58px;
      padding: 0 28px;
      border-radius: 12px;
      background: #c95033;
      box-shadow: 0 12px 28px rgba(154, 55, 32, .2);
      color: #fff;
      font-size: 1.02rem;
      font-weight: 700;
      text-decoration: none;
    }
    .download-button:hover { background: #b84025; }
    .download-button:active { transform: translateY(1px); }
    .download-button:focus-visible,
    a:focus-visible { outline: 3px solid rgba(201, 80, 51, .38); outline-offset: 3px; }
    .release-meta { margin: 13px 0 0; color: #71716c; font-size: .88rem; }
    .install-guide { padding-top: 4px; }
    h2 { margin: 0 0 26px; font-size: clamp(1.65rem, 3vw, 2.2rem); letter-spacing: -.035em; }
    ol { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
    li { display: grid; grid-template-columns: 42px 1fr; gap: 15px; padding: 18px 0; border-top: 1px solid #d8d8d2; }
    li:last-child { border-bottom: 1px solid #d8d8d2; }
    .step-number {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      border-radius: 9px;
      background: #252525;
      color: #fff;
      font-weight: 700;
    }
    li strong { display: block; margin: 2px 0 5px; font-size: 1rem; }
    li p { margin: 0; color: #62625d; font-size: .92rem; line-height: 1.5; }
    .security-note {
      grid-column: 1 / -1;
      padding: 22px 24px;
      border: 1px solid #e1b36f;
      border-left: 5px solid #c95033;
      border-radius: 12px;
      background: #fff9ed;
    }
    .security-note strong { font-size: .95rem; }
    .security-note p { margin: 6px 0 0; color: #61594c; line-height: 1.5; }
    footer {
      display: flex;
      gap: 24px;
      width: min(1120px, calc(100% - 40px));
      margin: 0 auto;
      padding: 24px 0 34px;
      border-top: 1px solid #deded9;
      color: #71716c;
      font-size: .88rem;
    }
    footer span { margin-right: auto; color: #252525; font-weight: 700; }
    footer a { color: inherit; text-decoration: none; }
    @media (max-width: 760px) {
      .download-header { width: min(100% - 28px, 1120px); }
      main { grid-template-columns: 1fr; gap: 48px; width: min(100% - 32px, 620px); padding-top: 44px; }
      .app-identity { align-items: flex-start; gap: 16px; }
      h1 { font-size: clamp(2.15rem, 12vw, 3.3rem); }
      .intro-copy { margin-top: 26px; font-size: 1.05rem; }
      .download-button { width: 100%; }
      footer { flex-wrap: wrap; width: min(100% - 28px, 1120px); }
      footer span { flex-basis: 100%; }
    }
  `],
})
export class KitchenAppDownloadComponent {
  readonly apkUrl = APK_URL;

  constructor() {
    inject(Title).setTitle('Download Scanaki Kitchen for Android');
    inject(Meta).updateTag({
      name: 'description',
      content: 'Download the official Scanaki Kitchen pilot app for Android tablets.',
    });
  }
}
