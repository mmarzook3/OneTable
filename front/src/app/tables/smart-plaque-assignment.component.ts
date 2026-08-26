import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  Output,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ApiService, SmartPlaque, SmartPlaqueLookup, Table } from '../services/api.service';

type SetupStep = 'scan' | 'confirm' | 'nfc' | 'done';
type BarcodeDetectorInstance = {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue?: string }>>;
};
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorInstance;
type NdefReadingEvent = {
  message?: { records?: Array<{ recordType?: string; encoding?: string; data?: DataView }> };
};
type NdefReader = {
  write(message: { records: Array<{ recordType: 'url'; data: string }> }): Promise<void>;
  scan(): Promise<void>;
  onreading: ((event: NdefReadingEvent) => void) | null;
  onreadingerror: (() => void) | null;
};
type NdefReaderConstructor = new () => NdefReader;

@Component({
  selector: 'app-smart-plaque-assignment',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  template: `
    <div class="modal-backdrop" (click)="close()">
      <section
        class="setup-sheet"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="'SMART_PLAQUES.SETUP_TITLE' | translate"
        (click)="$event.stopPropagation()"
      >
        <header class="sheet-header">
          <div>
            <p class="eyebrow">{{ 'SMART_PLAQUES.TABLE_SETUP' | translate }}</p>
            <h2>{{ 'SMART_PLAQUES.SETUP_FOR' | translate: { table: table.name } }}</h2>
          </div>
          <button type="button" class="close-button" (click)="close()" [attr.aria-label]="'COMMON.CLOSE' | translate">×</button>
        </header>

        <ol class="progress" [attr.aria-label]="'SMART_PLAQUES.PROGRESS' | translate">
          <li [class.active]="step() === 'scan'" [class.complete]="stepIndex() > 0"><span>1</span>{{ 'SMART_PLAQUES.STEP_SCAN' | translate }}</li>
          <li [class.active]="step() === 'confirm'" [class.complete]="stepIndex() > 1"><span>2</span>{{ 'SMART_PLAQUES.STEP_ASSIGN' | translate }}</li>
          <li [class.active]="step() === 'nfc' || step() === 'done'"><span>3</span>{{ 'SMART_PLAQUES.STEP_NFC' | translate }}</li>
        </ol>

        @if (errorKey()) {
          <div class="error-banner" role="alert">{{ errorKey()! | translate }}</div>
        }

        @if (step() === 'scan') {
          <div class="step-content" data-testid="smart-plaque-scan-step">
            <div class="step-copy">
              <p class="step-number">{{ 'SMART_PLAQUES.STEP_ONE' | translate }}</p>
              <h3>{{ 'SMART_PLAQUES.SCAN_TITLE' | translate }}</h3>
              <p>{{ 'SMART_PLAQUES.SCAN_HINT' | translate }}</p>
            </div>

            @if (scanning()) {
              <div class="camera-frame">
                <video #cameraVideo muted playsinline></video>
                <div class="scan-target" aria-hidden="true"></div>
                <span>{{ 'SMART_PLAQUES.POINT_CAMERA' | translate }}</span>
              </div>
              <button type="button" class="btn btn-secondary full" (click)="stopCamera()">
                {{ 'SMART_PLAQUES.STOP_CAMERA' | translate }}
              </button>
            } @else {
              <button
                type="button"
                class="camera-launch"
                (click)="startCamera()"
                [disabled]="lookingUp()"
                data-testid="start-plaque-camera"
              >
                <span class="camera-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M14.5 5 13 3h-2L9.5 5H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4.5ZM12 17a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z"/></svg>
                </span>
                <strong>{{ 'SMART_PLAQUES.OPEN_CAMERA' | translate }}</strong>
                <small>{{ 'SMART_PLAQUES.CAMERA_REQUIREMENT' | translate }}</small>
              </button>
            }

            <div class="divider"><span>{{ 'COMMON.OR' | translate }}</span></div>
            <form (submit)="lookupManualCode($event)" class="manual-form">
              <label for="plaque-code">{{ 'SMART_PLAQUES.ENTER_CODE' | translate }}</label>
              <div class="manual-row">
                <input
                  id="plaque-code"
                  name="plaqueCode"
                  [(ngModel)]="manualCode"
                  [placeholder]="'SMART_PLAQUES.CODE_PLACEHOLDER' | translate"
                  autocomplete="off"
                  required
                  data-testid="smart-plaque-code-input"
                />
                <button type="submit" class="btn btn-primary" [disabled]="lookingUp()" data-testid="check-smart-plaque-code">
                  {{ (lookingUp() ? 'COMMON.CHECKING' : 'COMMON.CONTINUE') | translate }}
                </button>
              </div>
              <small>{{ 'SMART_PLAQUES.MANUAL_HINT' | translate }}</small>
            </form>

            @if (table.smart_plaque_id && table.smart_plaque_url) {
              <button type="button" class="current-plaque" (click)="useCurrentPlaque()">
                <span>✓</span>
                <span>
                  <strong>{{ 'SMART_PLAQUES.MANAGE_CURRENT' | translate }}</strong>
                  <small>{{ table.smart_plaque_code }}</small>
                </span>
              </button>
            }
          </div>
        }

        @if (step() === 'confirm' && lookup(); as found) {
          <div class="step-content" data-testid="smart-plaque-confirm-step">
            <div class="step-copy">
              <p class="step-number">{{ 'SMART_PLAQUES.STEP_TWO' | translate }}</p>
              <h3>{{ 'SMART_PLAQUES.CONFIRM_TITLE' | translate }}</h3>
              <p>{{ 'SMART_PLAQUES.CONFIRM_HINT' | translate }}</p>
            </div>

            <div class="assignment-card">
              <div class="plaque-mark">QR</div>
              <div>
                <small>{{ 'SMART_PLAQUES.PERMANENT_PLAQUE' | translate }}</small>
                <strong>{{ found.public_code }}</strong>
                <span>{{ found.public_url }}</span>
              </div>
            </div>

            <div class="mapping">
              <div><small>{{ 'SMART_PLAQUES.FROM' | translate }}</small><strong>{{ currentAssignment(found) }}</strong></div>
              <span aria-hidden="true">→</span>
              <div><small>{{ 'SMART_PLAQUES.TO' | translate }}</small><strong>{{ table.name }}</strong></div>
            </div>

            @if (requiresReassignment(found)) {
              <div class="warning">{{ 'SMART_PLAQUES.REASSIGN_WARNING' | translate: { table: found.table_name } }}</div>
            }
            @if (requiresReplacement(found)) {
              <div class="warning">{{ 'SMART_PLAQUES.REPLACE_WARNING' | translate: { table: table.name } }}</div>
            }

            <div class="actions">
              <button type="button" class="btn btn-secondary" (click)="backToScan()">{{ 'COMMON.BACK' | translate }}</button>
              <button type="button" class="btn btn-primary" (click)="assign()" [disabled]="assigning()" data-testid="confirm-plaque-assignment">
                {{ (assigning() ? 'SMART_PLAQUES.ASSIGNING' : 'SMART_PLAQUES.ASSIGN_TO_TABLE') | translate }}
              </button>
            </div>
          </div>
        }

        @if (step() === 'nfc' && plaque(); as assignedPlaque) {
          <div class="step-content" data-testid="smart-plaque-nfc-step">
            <div class="step-copy">
              <p class="step-number">{{ 'SMART_PLAQUES.STEP_THREE' | translate }}</p>
              <h3>{{ 'SMART_PLAQUES.NFC_TITLE' | translate }}</h3>
              <p>{{ 'SMART_PLAQUES.NFC_HINT' | translate }}</p>
            </div>

            <div class="nfc-card" [class.complete]="nfcVerified()">
              <div class="nfc-symbol" aria-hidden="true">N</div>
              <div>
                <strong>{{ nfcStatusTitle() | translate }}</strong>
                <span>{{ nfcStatusHint() | translate }}</span>
              </div>
            </div>

            @if (!assignedPlaque.nfc_written_at) {
              <button type="button" class="btn btn-primary full touch-button" (click)="writeNfc()" [disabled]="nfcBusy()" data-testid="write-smart-plaque-nfc">
                {{ (nfcBusy() ? 'SMART_PLAQUES.WAITING_FOR_TAG' : 'SMART_PLAQUES.WRITE_NFC') | translate }}
              </button>
            } @else if (!nfcVerified()) {
              <button type="button" class="btn btn-primary full touch-button" (click)="verifyNfc()" [disabled]="nfcBusy()" data-testid="verify-smart-plaque-nfc">
                {{ (nfcBusy() ? 'SMART_PLAQUES.WAITING_FOR_TAG' : 'SMART_PLAQUES.VERIFY_NFC') | translate }}
              </button>
            }

            <button type="button" class="btn btn-secondary full" (click)="copyPermanentUrl()">
              {{ copied() ? ('COMMON.COPIED' | translate) : ('SMART_PLAQUES.COPY_FOR_NFC_APP' | translate) }}
            </button>

            <div class="helper-box">
              <strong>{{ 'SMART_PLAQUES.NFC_HELP_TITLE' | translate }}</strong>
              <p>{{ 'SMART_PLAQUES.NFC_HELP_HINT' | translate }}</p>
            </div>

            <div class="actions">
              <button type="button" class="btn btn-secondary" (click)="finish()">{{ 'SMART_PLAQUES.SKIP_NFC' | translate }}</button>
              @if (nfcVerified() && !assignedPlaque.installed_at) {
                <button type="button" class="btn btn-primary" (click)="markInstalled()" [disabled]="nfcBusy()" data-testid="install-smart-plaque">Mark installed</button>
              } @else if (assignedPlaque.installed_at) {
                <button type="button" class="btn btn-primary" (click)="finish()" data-testid="finish-smart-plaque-nfc">{{ 'COMMON.DONE' | translate }}</button>
              }
            </div>
          </div>
        }

        @if (step() === 'done') {
          <div class="step-content done-step" data-testid="smart-plaque-done-step">
            <div class="success-mark" aria-hidden="true">✓</div>
            <h3>{{ 'SMART_PLAQUES.READY_TITLE' | translate }}</h3>
            <p>{{ 'SMART_PLAQUES.READY_HINT' | translate: { table: table.name } }}</p>
            <button type="button" class="btn btn-primary full" (click)="close()">{{ 'COMMON.DONE' | translate }}</button>
          </div>
        }
      </section>
    </div>
  `,
  styles: [`
    .modal-backdrop { position: fixed; inset: 0; z-index: 5000; display: grid; place-items: center; padding: 18px; background: rgba(13, 22, 42, .62); backdrop-filter: blur(5px); }
    .setup-sheet { width: min(100%, 600px); max-height: min(92vh, 850px); overflow-y: auto; background: var(--color-surface); border-radius: 22px; box-shadow: 0 24px 80px rgba(0,0,0,.25); color: var(--color-text); }
    .sheet-header { display: flex; justify-content: space-between; gap: var(--space-4); padding: var(--space-5) var(--space-5) var(--space-4); border-bottom: 1px solid var(--color-border); }
    .eyebrow { margin: 0 0 4px; color: var(--color-primary); font-size: .72rem; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
    h2 { margin: 0; font-size: 1.35rem; letter-spacing: -.025em; }
    .close-button { width: 36px; height: 36px; border: 0; border-radius: 50%; background: var(--color-bg); color: var(--color-text-muted); font-size: 1.5rem; cursor: pointer; }
    .progress { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin: 0; padding: var(--space-4) var(--space-5); list-style: none; background: var(--color-bg); }
    .progress li { display: flex; align-items: center; gap: 7px; color: var(--color-text-muted); font-size: .72rem; font-weight: 650; }
    .progress span { display: grid; place-items: center; width: 23px; height: 23px; border: 1px solid var(--color-border); border-radius: 50%; background: var(--color-surface); }
    .progress li.active { color: var(--color-primary); }
    .progress li.active span, .progress li.complete span { color: #fff; border-color: var(--color-primary); background: var(--color-primary); }
    .step-content { padding: var(--space-5); }
    .step-copy { margin-bottom: var(--space-5); }
    .step-number { margin: 0 0 5px; color: var(--color-primary); font-size: .75rem; font-weight: 750; text-transform: uppercase; }
    h3 { margin: 0 0 8px; font-size: 1.3rem; letter-spacing: -.025em; }
    .step-copy p:last-child, .done-step p { margin: 0; color: var(--color-text-muted); line-height: 1.55; }
    .camera-launch { width: 100%; min-height: 185px; display: grid; place-items: center; align-content: center; gap: 8px; padding: 24px; border: 2px dashed #aab9d8; border-radius: 16px; background: #f5f8ff; color: #19356f; cursor: pointer; }
    .camera-launch:hover { border-color: var(--color-primary); background: #eef4ff; }
    .camera-icon { display: grid; place-items: center; width: 56px; height: 56px; border-radius: 17px; background: var(--color-primary); color: #fff; }
    .camera-icon svg { width: 28px; fill: currentColor; }
    .camera-launch strong { font-size: 1rem; }
    .camera-launch small { color: #60739a; }
    .camera-frame { position: relative; overflow: hidden; aspect-ratio: 4/3; border-radius: 16px; background: #0b1020; }
    .camera-frame video { width: 100%; height: 100%; object-fit: cover; }
    .camera-frame > span { position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%); padding: 7px 11px; border-radius: 999px; color: #fff; background: rgba(0,0,0,.65); font-size: .75rem; white-space: nowrap; }
    .scan-target { position: absolute; inset: 18% 20%; border: 3px solid #fff; border-radius: 14px; box-shadow: 0 0 0 999px rgba(0,0,0,.28); }
    .divider { display: flex; align-items: center; gap: 12px; margin: var(--space-5) 0; color: var(--color-text-muted); font-size: .75rem; }
    .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--color-border); }
    .manual-form { display: grid; gap: 7px; }
    .manual-form label { font-size: .8rem; font-weight: 650; }
    .manual-row { display: flex; gap: 8px; }
    input { flex: 1; min-width: 0; padding: 12px; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-surface); color: var(--color-text); font: inherit; }
    .manual-form small { color: var(--color-text-muted); line-height: 1.4; }
    .current-plaque { width: 100%; display: flex; align-items: center; gap: 12px; margin-top: var(--space-4); padding: 13px; border: 1px solid #b9d7c3; border-radius: 12px; background: #f1faf4; color: #175d32; text-align: left; cursor: pointer; }
    .current-plaque > span:first-child { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; color: #fff; background: #23834a; }
    .current-plaque span:last-child { display: grid; gap: 2px; }
    .current-plaque small { font-family: ui-monospace, monospace; }
    .assignment-card { display: flex; align-items: center; gap: 14px; padding: 15px; border: 1px solid var(--color-border); border-radius: 14px; background: var(--color-bg); }
    .plaque-mark { display: grid; place-items: center; width: 50px; height: 50px; border-radius: 12px; background: #17223b; color: #fff; font-weight: 800; }
    .assignment-card > div:last-child { min-width: 0; display: grid; gap: 3px; }
    .assignment-card small { color: var(--color-text-muted); }
    .assignment-card span { overflow: hidden; color: var(--color-text-muted); font-size: .72rem; text-overflow: ellipsis; white-space: nowrap; }
    .mapping { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px; margin: var(--space-5) 0; }
    .mapping div { display: grid; gap: 4px; padding: 13px; border: 1px solid var(--color-border); border-radius: 12px; }
    .mapping small { color: var(--color-text-muted); }
    .mapping > span { color: var(--color-primary); font-size: 1.4rem; }
    .warning { margin-bottom: var(--space-3); padding: 12px; border-radius: 10px; background: #fff6df; color: #805300; font-size: .85rem; line-height: 1.45; }
    .nfc-card { display: flex; gap: 14px; align-items: center; margin-bottom: var(--space-4); padding: 16px; border: 1px solid var(--color-border); border-radius: 14px; background: var(--color-bg); }
    .nfc-card.complete { border-color: #99d5ac; background: #effaf2; }
    .nfc-symbol { display: grid; place-items: center; width: 50px; height: 50px; border-radius: 50%; background: #17223b; color: #fff; font-size: 1.2rem; font-weight: 800; }
    .nfc-card > div:last-child { display: grid; gap: 4px; }
    .nfc-card span { color: var(--color-text-muted); font-size: .82rem; line-height: 1.4; }
    .helper-box { margin-top: var(--space-4); padding: 13px; border-radius: 12px; background: #eef4ff; color: #234276; }
    .helper-box p { margin: 5px 0 0; font-size: .82rem; line-height: 1.45; }
    .actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: var(--space-5); }
    .btn { border: 0; border-radius: 10px; padding: 12px 16px; font-weight: 700; cursor: pointer; }
    .btn:disabled { opacity: .55; cursor: wait; }
    .btn-primary { background: var(--color-primary); color: #fff; }
    .btn-secondary { border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); }
    .full { width: 100%; justify-content: center; margin-top: 10px; }
    .touch-button { min-height: 50px; }
    .error-banner { margin: var(--space-4) var(--space-5) 0; padding: 12px; border-radius: 10px; color: #9b1c1c; background: #fff0f0; }
    .done-step { text-align: center; }
    .success-mark { display: grid; place-items: center; width: 62px; height: 62px; margin: 4px auto 18px; border-radius: 50%; background: #daf5e3; color: #18763a; font-size: 1.8rem; font-weight: 800; }
    @media (max-width: 560px) {
      .modal-backdrop { align-items: end; padding: 0; }
      .setup-sheet { width: 100%; max-height: 96vh; border-radius: 22px 22px 0 0; }
      .progress li { justify-content: center; font-size: 0; }
      .progress li span { font-size: .72rem; }
      .step-content, .sheet-header { padding-left: var(--space-4); padding-right: var(--space-4); }
      .manual-row { flex-direction: column; }
      .mapping { grid-template-columns: 1fr; }
      .mapping > span { transform: rotate(90deg); justify-self: center; }
      .actions { flex-direction: column-reverse; }
      .actions .btn { width: 100%; }
    }
  `],
})
export class SmartPlaqueAssignmentComponent implements OnDestroy {
  private readonly api = inject(ApiService);
  private readonly translate = inject(TranslateService);

  @Input({ required: true }) table!: Table;
  @Output() closed = new EventEmitter<void>();
  @Output() tableUpdated = new EventEmitter<Table>();
  @ViewChild('cameraVideo') cameraVideo?: ElementRef<HTMLVideoElement>;

  step = signal<SetupStep>('scan');
  lookup = signal<SmartPlaqueLookup | null>(null);
  plaque = signal<SmartPlaque | null>(null);
  lookingUp = signal(false);
  assigning = signal(false);
  scanning = signal(false);
  nfcBusy = signal(false);
  copied = signal(false);
  errorKey = signal<string | null>(null);
  manualCode = '';

  private stream?: MediaStream;
  private scanFrame?: number;

  ngOnDestroy(): void {
    this.stopCamera();
  }

  stepIndex(): number {
    return { scan: 0, confirm: 1, nfc: 2, done: 3 }[this.step()];
  }

  async startCamera(): Promise<void> {
    this.errorKey.set(null);
    const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
    if (!navigator.mediaDevices?.getUserMedia || !Detector) {
      this.errorKey.set('SMART_PLAQUES.CAMERA_UNAVAILABLE');
      return;
    }
    try {
      this.scanning.set(true);
      await new Promise<void>((resolve) => setTimeout(resolve));
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      const video = this.cameraVideo?.nativeElement;
      if (!video) throw new Error('camera element unavailable');
      video.srcObject = this.stream;
      await video.play();
      const detector = new Detector({ formats: ['qr_code'] });
      const detect = async () => {
        if (!this.scanning() || !this.cameraVideo?.nativeElement) return;
        try {
          const results = await detector.detect(this.cameraVideo.nativeElement);
          const raw = results.find((result) => result.rawValue)?.rawValue;
          if (raw) {
            this.stopCamera();
            this.lookupCode(raw);
            return;
          }
        } catch {
          // Camera frames can be temporarily unreadable while autofocus settles.
        }
        this.scanFrame = requestAnimationFrame(() => void detect());
      };
      await detect();
    } catch {
      this.stopCamera();
      this.errorKey.set('SMART_PLAQUES.CAMERA_PERMISSION_ERROR');
    }
  }

  stopCamera(): void {
    this.scanning.set(false);
    if (this.scanFrame != null) cancelAnimationFrame(this.scanFrame);
    this.scanFrame = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    if (this.cameraVideo?.nativeElement) this.cameraVideo.nativeElement.srcObject = null;
  }

  lookupManualCode(event: Event): void {
    event.preventDefault();
    if (this.manualCode.trim()) this.lookupCode(this.manualCode);
  }

  lookupCode(value: string): void {
    this.lookingUp.set(true);
    this.errorKey.set(null);
    this.api.lookupSmartPlaque(value).subscribe({
      next: (result) => {
        this.lookingUp.set(false);
        if (result.assignment_state === 'assigned_other_restaurant') {
          this.errorKey.set('SMART_PLAQUES.ASSIGNED_ELSEWHERE');
          return;
        }
        if (result.assignment_state === 'disabled' || result.assignment_state === 'retired') {
          this.errorKey.set('SMART_PLAQUES.PLAQUE_UNAVAILABLE');
          return;
        }
        if (result.assignment_state === 'awaiting_delivery') {
          this.errorKey.set('SMART_PLAQUES.PLAQUE_UNAVAILABLE');
          return;
        }
        this.lookup.set(result);
        this.manualCode = result.public_code;
        this.step.set('confirm');
      },
      error: (err) => {
        this.lookingUp.set(false);
        this.errorKey.set(
          err?.status === 404
            ? 'SMART_PLAQUES.NOT_RECOGNISED_HINT'
            : 'SMART_PLAQUES.INVALID_CODE',
        );
      },
    });
  }

  backToScan(): void {
    this.lookup.set(null);
    this.errorKey.set(null);
    this.step.set('scan');
  }

  currentAssignment(found: SmartPlaqueLookup): string {
    return found.table_name || this.translate.instant('SMART_PLAQUES.UNASSIGNED');
  }

  requiresReassignment(found: SmartPlaqueLookup): boolean {
    return found.assignment_state === 'assigned_here' && found.table_id !== this.table.id;
  }

  requiresReplacement(found: SmartPlaqueLookup): boolean {
    return !!this.table.smart_plaque_id && this.table.smart_plaque_id !== found.id;
  }

  assign(): void {
    const found = this.lookup();
    if (!found || !this.table.id) return;
    this.assigning.set(true);
    this.errorKey.set(null);
    this.api.assignSmartPlaque({
      table_id: this.table.id,
      plaque_code: found.public_code,
      confirm_reassignment: this.requiresReassignment(found),
      replace_existing: this.requiresReplacement(found),
    }).subscribe({
      next: (assigned) => {
        this.assigning.set(false);
        this.plaque.set(assigned);
        this.emitPlaqueTable(assigned);
        this.step.set('nfc');
      },
      error: (err) => {
        this.assigning.set(false);
        const code = err?.error?.detail?.code;
        this.errorKey.set(
          code === 'table_has_live_session'
            ? 'SMART_PLAQUES.ACTIVE_TABLE_BLOCK'
            : code === 'plaque_assigned_to_another_restaurant'
              ? 'SMART_PLAQUES.ASSIGNED_ELSEWHERE'
              : 'SMART_PLAQUES.ASSIGN_ERROR',
        );
      },
    });
  }

  useCurrentPlaque(): void {
    if (!this.table.smart_plaque_id || !this.table.smart_plaque_code || !this.table.smart_plaque_url) return;
    this.plaque.set({
      id: this.table.smart_plaque_id,
      public_code: this.table.smart_plaque_code,
      public_url: this.table.smart_plaque_url,
      status: this.table.smart_plaque_status || 'assigned',
      table_id: this.table.id,
      table_name: this.table.name,
      table_token: this.table.token,
      nfc_written_at: this.table.smart_plaque_nfc_written_at,
      nfc_verified_at: this.table.smart_plaque_nfc_verified_at,
      nfc_locked_at: this.table.smart_plaque_nfc_locked_at,
      installed_at: this.table.smart_plaque_installed_at,
    });
    this.step.set('nfc');
  }

  async writeNfc(): Promise<void> {
    const current = this.plaque();
    if (!current) return;
    const Reader = (window as unknown as { NDEFReader?: NdefReaderConstructor }).NDEFReader;
    if (!Reader || !window.isSecureContext) {
      await this.copyPermanentUrl();
      this.errorKey.set('SMART_PLAQUES.NFC_UNAVAILABLE');
      return;
    }
    this.nfcBusy.set(true);
    this.errorKey.set(null);
    try {
      const writer = new Reader();
      await writer.write({ records: [{ recordType: 'url', data: current.public_url }] });
      this.api.updateSmartPlaqueNfc(current.id, { written: true }).subscribe({
        next: (updated) => {
          this.plaque.set(updated);
          this.emitPlaqueTable(updated);
          this.nfcBusy.set(false);
        },
        error: () => {
          this.nfcBusy.set(false);
          this.errorKey.set('SMART_PLAQUES.NFC_RECORD_ERROR');
        },
      });
    } catch {
      this.nfcBusy.set(false);
      this.errorKey.set('SMART_PLAQUES.NFC_WRITE_ERROR');
    }
  }

  async verifyNfc(): Promise<void> {
    const current = this.plaque();
    if (!current) return;
    const Reader = (window as unknown as { NDEFReader?: NdefReaderConstructor }).NDEFReader;
    if (!Reader || !window.isSecureContext) {
      this.errorKey.set('SMART_PLAQUES.NFC_UNAVAILABLE');
      return;
    }
    this.nfcBusy.set(true);
    this.errorKey.set(null);
    try {
      const reader = new Reader();
      reader.onreadingerror = () => {
        this.nfcBusy.set(false);
        this.errorKey.set('SMART_PLAQUES.NFC_READ_ERROR');
      };
      reader.onreading = (event) => {
        const urls = (event.message?.records || [])
          .filter((record) => record.recordType === 'url' && record.data)
          .map((record) => new TextDecoder(record.encoding || 'utf-8').decode(record.data));
        if (!urls.some((url) => url.replace(/\/$/, '') === current.public_url.replace(/\/$/, ''))) {
          this.nfcBusy.set(false);
          this.errorKey.set('SMART_PLAQUES.NFC_WRONG_URL');
          return;
        }
        this.api.updateSmartPlaqueNfc(current.id, { verified: true }).subscribe({
          next: (updated) => {
            this.plaque.set(updated);
            this.emitPlaqueTable(updated);
            this.nfcBusy.set(false);
          },
          error: () => {
            this.nfcBusy.set(false);
            this.errorKey.set('SMART_PLAQUES.NFC_RECORD_ERROR');
          },
        });
      };
      await reader.scan();
    } catch {
      this.nfcBusy.set(false);
      this.errorKey.set('SMART_PLAQUES.NFC_READ_ERROR');
    }
  }

  nfcVerified(): boolean {
    return !!this.plaque()?.nfc_verified_at;
  }

  markInstalled(): void {
    const current = this.plaque();
    if (!current || !this.nfcVerified()) return;
    this.nfcBusy.set(true);
    this.api.updateSmartPlaqueNfc(current.id, { installed: true }).subscribe({
      next: (updated) => {
        this.plaque.set(updated);
        this.emitPlaqueTable(updated);
        this.nfcBusy.set(false);
        this.finish();
      },
      error: () => {
        this.nfcBusy.set(false);
        this.errorKey.set('SMART_PLAQUES.NFC_RECORD_ERROR');
      },
    });
  }

  nfcStatusTitle(): string {
    if (this.nfcVerified()) return 'SMART_PLAQUES.NFC_VERIFIED_TITLE';
    if (this.plaque()?.nfc_written_at) return 'SMART_PLAQUES.NFC_WRITTEN_TITLE';
    return 'SMART_PLAQUES.NFC_READY_TITLE';
  }

  nfcStatusHint(): string {
    if (this.nfcVerified()) return 'SMART_PLAQUES.NFC_VERIFIED_HINT';
    if (this.plaque()?.nfc_written_at) return 'SMART_PLAQUES.NFC_WRITTEN_HINT';
    return 'SMART_PLAQUES.NFC_READY_HINT';
  }

  async copyPermanentUrl(): Promise<void> {
    const url = this.plaque()?.public_url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1800);
    } catch {
      this.errorKey.set('SMART_PLAQUES.COPY_ERROR');
    }
  }

  finish(): void {
    this.step.set('done');
  }

  close(): void {
    this.stopCamera();
    this.closed.emit();
  }

  private emitPlaqueTable(plaque: SmartPlaque): void {
    this.tableUpdated.emit({
      ...this.table,
      token: plaque.table_token || this.table.token,
      menu_url: plaque.public_url,
      nfc_payload: plaque.public_url,
      plaque_status: plaque.installed_at ? 'installed' : plaque.nfc_verified_at ? 'tested' : plaque.nfc_written_at ? 'nfc_written' : 'assigned',
      smart_plaque_id: plaque.id,
      smart_plaque_code: plaque.public_code,
      smart_plaque_url: plaque.public_url,
      smart_plaque_status: plaque.status,
      smart_plaque_nfc_written_at: plaque.nfc_written_at,
      smart_plaque_nfc_verified_at: plaque.nfc_verified_at,
      smart_plaque_nfc_locked_at: plaque.nfc_locked_at,
      smart_plaque_installed_at: plaque.installed_at,
    });
  }
}
