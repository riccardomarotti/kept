import { AfterViewInit, Component, ElementRef, Input, OnDestroy } from '@angular/core';
import { NotesService, LinkPreviewData } from 'src/app/services/notes.service';
import { AuthService } from 'src/app/services/auth.service';
import { UserPreferencesService } from 'src/app/services/user-preferences.service';
import { environment } from 'src/environments/environment';

@Component({
  selector: 'app-link-preview',
  templateUrl: './link-preview.component.html',
  styleUrls: ['./link-preview.component.scss'],
  standalone: false
})
export class LinkPreviewComponent implements AfterViewInit, OnDestroy {
  private _url!: string;
  @Input() set url(value: string) {
    if (this._url !== value) {
      this.releaseInterest();
      this._url = value;
      this.resetPreview();
      this.maybeFetchPreview();
    }
  }
  get url() { return this._url; }

  @Input() full = false;
  @Input() cardMode = false;
  @Input() clickToOpen = false;

  preview: LinkPreviewData | null = null;
  loading = true;
  failed = false;
  imageError = false;
  copied = false;
  thumbnailUrl = '';
  private observer?: IntersectionObserver;
  private viewReady = false;
  private nearViewport = false;
  private fetchStarted = false;
  private interestRetained = false;
  private destroyed = false;

  constructor(
    private notesService: NotesService,
    private auth: AuthService,
    private preferences: UserPreferencesService,
    private host: ElementRef<HTMLElement>
  ) {}

  ngAfterViewInit() {
    this.viewReady = true;
    if (!('IntersectionObserver' in window)) {
      this.nearViewport = true;
      this.maybeFetchPreview();
      return;
    }
    this.observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      this.nearViewport = true;
      this.observer?.disconnect();
      this.observer = undefined;
      this.maybeFetchPreview();
    }, { root: null, rootMargin: '3000px 0px', threshold: 0 });
    this.observer.observe(this.host.nativeElement);
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.releaseInterest();
    this.observer?.disconnect();
  }

  /** The shimmer may only animate while a fetch is actually in flight. */
  get shimmerActive() {
    return this.loading && this.fetchStarted;
  }

  linkDomain(url: string) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  private resetPreview() {
    // Reuse already fetched data so cached cards render without a skeleton.
    const cached = this._url ? this.notesService.peekLinkPreviewCache(this._url) : null;
    this.preview = cached;
    this.thumbnailUrl = '';
    this.loading = !cached;
    this.failed = false;
    this.imageError = false;
    this.fetchStarted = false;
    if (cached) void this.prepareThumbnail(cached);
  }

  private async prepareThumbnail(preview: LinkPreviewData) {
    if (!preview.image) return;
    const target = preview.image.startsWith('data:') ? preview.image
      : `${environment.apiUrl}/proxy-image?url=${encodeURIComponent(preview.image)}`;
    try {
      const thumbnailUrl = await this.auth.prepareImageUrl(target);
      if (this.destroyed || this.preview !== preview) return;
      this.thumbnailUrl = thumbnailUrl;
    } catch {
      if (!this.destroyed && this.preview === preview) this.imageError = true;
    }
  }

  private maybeFetchPreview() {
    if (!this.viewReady || !this.nearViewport || this.fetchStarted) return;
    if (!this.preview && !this.preferences.value.richLinkPreviews) {
      // Disabled rigorously: no request and no loading skeleton.
      this.loading = false;
      return;
    }
    if (this.preview) return;
    this.fetchPreview();
  }

  async fetchPreview() {
    const url = this._url;
    if (!url) return;

    this.fetchStarted = true;
    this.loading = true;
    this.failed = false;
    this.imageError = false;
    // Keep the queued fetch cancellable when the consumer navigates away.
    this.notesService.retainLinkPreview(url);
    this.interestRetained = true;
    try {
      const preview = await this.notesService.getLinkPreview(url);
      if (this.destroyed || this._url !== url) return; // Stale request
      this.preview = preview;
      await this.prepareThumbnail(preview);
      if (this.destroyed || this._url !== url) return;
    } catch (err) {
      if (this.destroyed || this._url !== url) return;
      this.failed = true;
    } finally {
      this.releaseInterest();
      if (!this.destroyed && this._url === url) {
        this.loading = false;
      }
    }
  }

  private releaseInterest() {
    if (!this.interestRetained) return;
    this.interestRetained = false;
    this.notesService.releaseLinkPreview(this._url);
  }

  open(event: MouseEvent) {
    event.stopPropagation();
    window.open(this.preview?.url || this.url, '_blank', 'noopener,noreferrer');
  }

  openCard(event: MouseEvent) {
    if (!this.clickToOpen) return;
    this.open(event);
  }

  async copy(event: MouseEvent) {
    event.stopPropagation();
    const value = this.preview?.url || this.url;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    this.copied = true;
    setTimeout(() => this.copied = false, 1200);
  }
}
