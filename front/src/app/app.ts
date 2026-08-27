import { Component, signal, OnInit, OnDestroy, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LanguageService } from './services/language.service';
import { SeoService } from './services/seo.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit, OnDestroy {
  protected readonly title = signal('front');

  /** Inject so LanguageService initializes at bootstrap and applies browser default language everywhere from first load. */
  private languageService = inject(LanguageService);
  private seo = inject(SeoService);

  ngOnInit() {
    this.seo.start();

  }

  ngOnDestroy() {
    this.seo.stop();
  }
}
