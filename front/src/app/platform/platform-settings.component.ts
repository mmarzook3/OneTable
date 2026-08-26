import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService, PlatformSettings, PlatformSettingsUpdate } from '../services/api.service';

@Component({
  selector: 'app-platform-settings',
  standalone: true,
  imports: [FormsModule],
  template: `
    <main class="settings-page">
      <header class="page-header">
        <div>
          <h1>Platform settings</h1>
          <p>Scanaki company identity, contact information, legal links and platform email delivery.</p>
        </div>
        <button type="button" class="secondary" (click)="load()" [disabled]="loading()">Refresh</button>
      </header>

      @if (message()) { <p class="success" role="status">{{ message() }}</p> }
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      @if (loading()) {
        <p class="muted">Loading platform settings…</p>
      } @else {
        <form (ngSubmit)="save()" class="settings-grid">
          <section class="settings-card">
            <div class="section-heading"><div><h2>Company details</h2><p>Used for Scanaki’s public identity and support information.</p></div></div>
            <div class="fields two-cols">
              <label>Legal company name<input [(ngModel)]="form.company_legal_name" name="company_legal_name" maxlength="200" placeholder="Legal registered name"></label>
              <label>Company number<input [(ngModel)]="form.company_number" name="company_number" maxlength="100" placeholder="Companies House number"></label>
              <label>VAT number<input [(ngModel)]="form.vat_number" name="vat_number" maxlength="100" placeholder="GB…"></label>
              <label>Website<input type="url" [(ngModel)]="form.website_url" name="website_url" placeholder="https://scanaki.uk"></label>
              <label>Support email<input type="email" [(ngModel)]="form.support_email" name="support_email" placeholder="support@scanaki.uk"></label>
              <label>Contact email<input type="email" [(ngModel)]="form.contact_email" name="contact_email" placeholder="hello@scanaki.uk"></label>
              <label>Phone<input [(ngModel)]="form.phone" name="phone" maxlength="64" placeholder="+44 …"></label>
            </div>
            <label>Registered address<textarea [(ngModel)]="form.address" name="address" rows="4" maxlength="2000" placeholder="Registered office address"></textarea></label>
          </section>

          <section class="settings-card">
            <div class="section-heading"><div><h2>Legal links</h2><p>Shown across public authentication and marketing pages.</p></div></div>
            <label>Terms and conditions URL<input type="url" [(ngModel)]="form.terms_url" name="terms_url" placeholder="https://scanaki.uk/terms"></label>
            <label>Privacy policy URL<input type="url" [(ngModel)]="form.privacy_url" name="privacy_url" placeholder="https://scanaki.uk/privacy"></label>
            <p class="hint">Leave these blank to use Scanaki’s built-in Terms and Privacy pages.</p>
          </section>

          <section class="settings-card smtp-card">
            <div class="section-heading smtp-heading">
              <div><h2>Platform email (SMTP)</h2><p>Used for Scanaki invitations, password resets and platform notifications when a restaurant does not use its own SMTP.</p></div>
              <span class="status" [attr.data-status]="smtpStatus()">{{ statusLabel(smtpStatus()) }}</span>
            </div>

            @if (current()?.smtp_source === 'environment') {
              <p class="notice">The VPS environment currently supplies SMTP. Save a new password below to move control into this encrypted admin setting.</p>
            }
            <div class="fields smtp-grid">
              <label>SMTP host<input [(ngModel)]="form.smtp_host" name="smtp_host" maxlength="255" placeholder="smtp.gmail.com"></label>
              <label>Port<input type="number" min="1" max="65535" [(ngModel)]="form.smtp_port" name="smtp_port"></label>
              <label class="check"><input type="checkbox" [(ngModel)]="form.smtp_use_tls" name="smtp_use_tls"> Use TLS / STARTTLS</label>
              <label class="check"><input type="checkbox" [(ngModel)]="form.smtp_auth_required" name="smtp_auth_required"> Require username and password</label>
              <label>Username<input [(ngModel)]="form.smtp_user" name="smtp_user" maxlength="320" autocomplete="off" placeholder="SMTP username" [disabled]="!form.smtp_auth_required"></label>
              <label>Sender email<input type="email" [(ngModel)]="form.email_from" name="email_from" maxlength="320" placeholder="noreply@scanaki.uk"></label>
              <label>Sender name<input [(ngModel)]="form.email_from_name" name="email_from_name" maxlength="200" placeholder="Scanaki"></label>
            </div>

            @if (form.smtp_auth_required) {
            <div class="password-panel">
              <label>SMTP password or app password
                <div class="password-row">
                  <input [type]="showPassword() ? 'text' : 'password'" [(ngModel)]="smtpPassword" name="smtp_password" autocomplete="new-password" [placeholder]="current()?.smtp_password_configured ? 'Password saved - enter only to replace' : 'Enter SMTP password'">
                  <button type="button" class="secondary compact" (click)="showPassword.set(!showPassword())">{{ showPassword() ? 'Hide' : 'Show' }}</button>
                </div>
              </label>
              <label class="check danger-check"><input type="checkbox" [(ngModel)]="clearPassword" name="clear_smtp_password"> Remove the saved encrypted SMTP password</label>
              <p class="hint">The password is encrypted before storage and is never returned to the browser. Saved value: {{ current()?.smtp_password_masked || 'not configured' }}</p>
            </div>
            } @else {
              <p class="notice">IP-authenticated relay mode is enabled. No SMTP username or password is stored by Scanaki.</p>
            }

            <div class="test-panel">
              <div>
                <h3>Connection test</h3>
                <p>Save changes first, then send a real test message to verify authentication and delivery.</p>
                @if (current()?.smtp_last_tested_at) {
                  <small>Last tested {{ date(current()!.smtp_last_tested_at!) }}: {{ current()?.smtp_last_test_message }}</small>
                }
              </div>
              <label>Test recipient<input type="email" [(ngModel)]="testRecipient" name="test_recipient" placeholder="you@yourdomain.co.uk"></label>
              <button type="button" class="secondary" (click)="testSmtp()" [disabled]="testing()">{{ testing() ? 'Testing…' : 'Send test email' }}</button>
            </div>
          </section>

          <section class="settings-card">
            <div class="section-heading"><div><h2>Super-admin account</h2><p>Set the recovery inbox for this username or change your password. All current sessions are revoked after a password change.</p></div></div>
            <label>Recovery email<input type="email" [(ngModel)]="form.operator_recovery_email" name="operator_recovery_email" maxlength="320" autocomplete="email" placeholder="owner@gmail.com"></label>
            <div class="fields password-change-grid">
              <label>Current password<input type="password" [(ngModel)]="currentPassword" name="current_platform_password" autocomplete="current-password"></label>
              <label>New password<input type="password" [(ngModel)]="newPassword" name="new_platform_password" autocomplete="new-password" minlength="12"></label>
              <label>Confirm new password<input type="password" [(ngModel)]="confirmPassword" name="confirm_platform_password" autocomplete="new-password" minlength="12"></label>
            </div>
            <div><button type="button" class="secondary" (click)="changePassword()" [disabled]="changingPassword()">{{ changingPassword() ? 'Changing…' : 'Change password' }}</button></div>
          </section>

          <footer class="save-bar">
            <div><strong>Platform-wide configuration</strong><small>Changes affect Scanaki, not restaurant-specific company settings.</small></div>
            <button type="submit" class="primary" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Save platform settings' }}</button>
          </footer>
        </form>
      }
    </main>
  `,
  styles: [`
    .settings-page{max-width:1180px;margin:auto;padding:28px 0;color:var(--color-text)}.page-header{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:1.5rem}.page-header h1{margin:0;font-size:25px}.page-header p{margin:5px 0 0;color:var(--color-text-muted)}.back-link{font-size:.85rem}
    button{font:inherit;cursor:pointer}.secondary,.primary{min-height:42px;padding:0 .95rem;border-radius:var(--radius-md);font-weight:700}.secondary{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text)}.primary{border:1px solid var(--color-primary);background:var(--color-primary);color:#fff}.compact{min-height:40px}.success,.error,.notice{padding:.9rem 1rem;border-radius:var(--radius-md)}.success{background:#e8f7ee;color:#18794e}.error{background:#fde8e8;color:#b42318}.notice{background:#eef6ff;color:#174d83;font-size:.82rem}.muted,.hint{color:var(--color-text-muted)}
    .settings-grid{display:grid;gap:1rem}.settings-card{display:grid;gap:1rem;padding:1.3rem;border:1px solid var(--color-border);border-radius:var(--radius-lg);background:var(--color-surface);box-shadow:var(--shadow-sm)}.section-heading{display:flex;gap:.8rem;align-items:flex-start}.section-heading h2{margin:0;font-size:1.15rem}.section-heading p{margin:.25rem 0 0;color:var(--color-text-muted);font-size:.82rem}.smtp-heading{display:grid;grid-template-columns:1fr auto}
    .fields{display:grid;gap:.8rem}.two-cols{grid-template-columns:1fr 1fr}.smtp-grid{grid-template-columns:2fr .7fr 1.3fr}.password-change-grid{grid-template-columns:repeat(3,1fr)}.smtp-grid label:nth-child(4),.smtp-grid label:nth-child(5),.smtp-grid label:nth-child(6){grid-column:auto}label{display:grid;gap:.35rem;color:var(--color-text-muted);font-size:.76rem;font-weight:700}input,textarea{width:100%;min-height:42px;padding:.55rem .7rem;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg);color:var(--color-text);font:inherit}textarea{resize:vertical}.check{display:flex;align-items:center;gap:.55rem;align-self:end;min-height:42px;color:var(--color-text)}.check input{width:auto;min-height:auto}.danger-check{color:var(--color-error);align-self:auto}
    .status{padding:.25rem .6rem;border-radius:999px;background:#eee;color:#666;font-size:.7rem;font-weight:800;text-transform:capitalize}.status[data-status=verified]{background:#e8f7ee;color:#18794e}.status[data-status=failed]{background:#fde8e8;color:#b42318}.status[data-status=configured]{background:#fff4d8;color:#8a5a00}.password-panel,.test-panel{padding:1rem;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg)}.password-panel{display:grid;gap:.75rem}.password-row{display:grid;grid-template-columns:1fr auto;gap:.5rem}.test-panel{display:grid;grid-template-columns:1.4fr 1fr auto;gap:1rem;align-items:end}.test-panel h3{margin:0;font-size:.9rem}.test-panel p{margin:.25rem 0;color:var(--color-text-muted);font-size:.75rem}.test-panel small{color:var(--color-text-muted)}
    .save-bar{position:sticky;bottom:1rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.1rem;border:1px solid var(--color-border);border-radius:var(--radius-lg);background:color-mix(in srgb,var(--color-surface) 94%,transparent);backdrop-filter:blur(12px);box-shadow:var(--shadow-lg)}.save-bar div{display:grid}.save-bar small{color:var(--color-text-muted)}button:disabled{opacity:.55;cursor:not-allowed}
    @media(max-width:760px){.settings-page{padding-top:18px}.page-header{display:block}.page-header>button{margin-top:1rem}.two-cols,.smtp-grid,.test-panel,.password-change-grid{grid-template-columns:1fr}.smtp-heading{grid-template-columns:1fr}.smtp-heading .status{width:max-content}.save-bar{align-items:stretch;flex-direction:column}.save-bar .primary{width:100%}}
  `],
})
export class PlatformSettingsComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  loading = signal(true); saving = signal(false); testing = signal(false);
  error = signal(''); message = signal(''); current = signal<PlatformSettings | null>(null);
  showPassword = signal(false); smtpPassword = ''; clearPassword = false; testRecipient = '';
  changingPassword = signal(false); currentPassword = ''; newPassword = ''; confirmPassword = '';
  form: PlatformSettingsUpdate = { smtp_use_tls: true, smtp_auth_required: true, clear_smtp_password: false };

  ngOnInit(): void { this.load(); }
  load(): void {
    this.loading.set(true); this.error.set('');
    this.api.getPlatformSettings().subscribe({next:(data)=>{this.current.set(data);this.form={
      operator_recovery_email:data.operator_recovery_email||'',company_legal_name:data.company_legal_name||'',support_email:data.support_email||'',contact_email:data.contact_email||'',phone:data.phone||'',address:data.address||'',website_url:data.website_url||'',company_number:data.company_number||'',vat_number:data.vat_number||'',terms_url:data.terms_url||'',privacy_url:data.privacy_url||'',smtp_host:data.smtp_host||'',smtp_port:data.smtp_port||587,smtp_use_tls:data.smtp_use_tls,smtp_auth_required:data.smtp_auth_required,smtp_user:data.smtp_user||'',email_from:data.email_from||'',email_from_name:data.email_from_name||'',clear_smtp_password:false,
    };this.testRecipient=data.contact_email||data.support_email||data.email_from||'';this.smtpPassword='';this.clearPassword=false;this.loading.set(false)},error:(err)=>{this.error.set(err?.error?.detail||'Could not load platform settings.');this.loading.set(false)}});
  }
  save(): void {
    this.saving.set(true);this.error.set('');this.message.set('');
    const body:PlatformSettingsUpdate={...this.form,smtp_password:this.smtpPassword||null,clear_smtp_password:this.clearPassword};
    this.api.updatePlatformSettings(body).subscribe({next:(data)=>{this.current.set(data);this.smtpPassword='';this.clearPassword=false;this.form.clear_smtp_password=false;this.message.set('Platform settings saved.');this.saving.set(false)},error:(err)=>{this.error.set(err?.error?.detail||'Could not save platform settings.');this.saving.set(false)}});
  }
  testSmtp(): void {
    this.testing.set(true);this.error.set('');this.message.set('');
    this.api.testPlatformSmtp(this.testRecipient).subscribe({next:(result)=>{this.api.getPlatformSettings().subscribe({next:(data)=>{this.current.set(data);this.testing.set(false);result.success?this.message.set(result.message):this.error.set(result.message)},error:()=>{this.testing.set(false);result.success?this.message.set(result.message):this.error.set(result.message)}})},error:(err)=>{this.error.set(err?.error?.detail||'SMTP test failed.');this.testing.set(false)}});
  }
  changePassword(): void {
    this.error.set('');this.message.set('');
    if(this.newPassword.length<12){this.error.set('New password must contain at least 12 characters.');return}
    if(this.newPassword!==this.confirmPassword){this.error.set('New password confirmation does not match.');return}
    this.changingPassword.set(true);
    this.api.changePlatformPassword(this.currentPassword,this.newPassword).subscribe({next:(result)=>{this.currentPassword='';this.newPassword='';this.confirmPassword='';this.api.logout().subscribe(()=>this.router.navigate(['/platform/login'],{state:{message:result.message}}))},error:(err)=>{this.error.set(err?.error?.detail||'Could not change password.');this.changingPassword.set(false)}});
  }
  smtpStatus(): string { return this.current()?.smtp_status || 'not_configured'; }
  statusLabel(value:string):string{return value.replaceAll('_',' ')}
  date(value:string):string{return new Date(value).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'})}
}
