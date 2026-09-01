'use strict';

/* ── Set your Google Maps API key here (optional) ──────────────────────────
   Without a key: uses Esri World Imagery satellite tiles (free, no account).
   With a key:    uses Google Maps satellite + Google Static Maps for photos.
   Get a free key: console.cloud.google.com → APIs & Services → Credentials
   ───────────────────────────────────────────────────────────────────────── */
const GOOGLE_MAPS_KEY = ''; // ← paste your key here, e.g. 'AIzaSy...'

/* ═══════════════════════════════════════════════════
   LocoCam — main application class
═══════════════════════════════════════════════════ */
class LocoCam {
  constructor() {
    // Camera
    this.stream      = null;
    this.facingMode  = 'environment';

    // Map
    this.map    = null;
    this.marker = null;

    // Location
    this.location     = null;   // { lat, lng }
    this.addrCity     = null;   // "Bengaluru, Karnataka, India"
    this.addrFull     = null;   // "27/28, 2nd Cross Rd, V S Reddy Colony..."
    this.addrFlag     = '';     // country flag emoji
    this.lastGeocoded = null;   // { lat, lng }
    this.geocodeTimer = null;
    this.geoWatchID   = null;

    // UI state
    this.hudEnabled = true;
    this.mode       = 'photo'; // 'photo' | 'video'

    // Recording
    this.isRecording   = false;
    this.mediaRecorder = null;
    this.chunks        = [];
    this.recTimerID    = null;
    this.recSecs       = 0;

    // Captured media
    this.capturedType = null;
    this.capturedURL  = null;
    this.capturedBlob = null;

    this.useGoogleMaps = false; // true once Google Maps JS API is loaded

    this._init();
  }

  /* ─────────────────────────────────────────────
     INIT
  ───────────────────────────────────────────── */
  _init() {
    const q = id => document.getElementById(id);

    this.el = {
      permScreen : q('perm-screen'),
      camScreen  : q('cam-screen'),
      prevScreen : q('prev-screen'),

      btnGrant   : q('btn-grant'),
      errText    : q('err-text'),

      video      : q('video'),
      flash      : q('flash'),
      focusRing  : q('focus-ring'),

      btnFlip      : q('btn-flip'),
      btnCamSelect : q('btn-cam-select'),
      camMenu      : q('cam-menu'),
      camList      : q('cam-list'),
      camCount     : q('cam-count'),
      btnModePhoto : q('btn-mode-photo'),
      btnModeVideo : q('btn-mode-video'),
      btnHud       : q('btn-hud'),
      iconEye      : document.querySelector('.icon-eye'),
      iconEyeOff   : document.querySelector('.icon-eye-off'),

      recBar   : q('rec-bar'),
      recTime  : q('rec-time'),

      hud      : q('hud'),
      mapEl    : q('map-el'),
      hudAddr  : q('hud-addr'),
      hudAddrFull: q('hud-addr-full'),
      hudCoords: q('hud-coords'),
      hudClock : q('hud-clock'),

      shutterBtn : q('btn-shutter'),
      btnInfo    : q('btn-info'),
      infoPopover: q('info-popover'),

      prevImg    : q('prev-img'),
      prevVid    : q('prev-vid'),
      btnRetake  : q('btn-retake'),
      btnSave    : q('btn-save'),
    };

    this.selectedDeviceId = null;
    this.activeDeviceId   = null;
    this.videoDevices     = [];

    this._bindEvents();

    // Live clock in HUD
    this._updateClock();
    setInterval(() => this._updateClock(), 1000);

    // Load Google Maps JS API if a key is provided, then start the app
    this._loadGoogleMaps().finally(() => this._tryStart());
  }

  _bindEvents() {
    const { el } = this;
    el.btnGrant.addEventListener('click',      () => this._tryStart());
    el.btnFlip.addEventListener('click',       () => this._flipCamera());
    el.btnModePhoto.addEventListener('click',  () => this._setMode('photo'));
    el.btnModeVideo.addEventListener('click',  () => this._setMode('video'));
    el.btnHud.addEventListener('click',        () => this._toggleHUD());
    el.shutterBtn.addEventListener('click',    () => this._onShutter());
    el.btnRetake.addEventListener('click',     () => this._retake());
    el.btnSave.addEventListener('click',       () => this._save());
    el.video.addEventListener('click',         e  => this._onTap(e));

    // Camera Input Menu Toggle
    if (el.btnCamSelect && el.camMenu) {
      el.btnCamSelect.addEventListener('click', (e) => {
        e.stopPropagation();
        el.camMenu.classList.toggle('show');
        if (el.camMenu.classList.contains('show')) {
          this._enumerateCameras();
        }
      });

      document.addEventListener('click', (e) => {
        if (!el.btnCamSelect.contains(e.target) && !el.camMenu.contains(e.target)) {
          el.camMenu.classList.remove('show');
        }
      });
    }

    // Info button toggle
    if (el.btnInfo && el.infoPopover) {
      el.btnInfo.addEventListener('click', (e) => {
        e.stopPropagation();
        el.infoPopover.classList.toggle('show');
      });
      document.addEventListener('click', (e) => {
        if (!el.btnInfo.contains(e.target) && !el.infoPopover.contains(e.target)) {
          el.infoPopover.classList.remove('show');
        }
      });
    }

    // Listen for device changes (plugged/unplugged cameras)
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => this._enumerateCameras());
    }
  }

  _updateClock() {
    this.el.hudClock.textContent = this._formatDateTime();
  }

  /* ─────────────────────────────────────────────
     START / SCREEN
  ───────────────────────────────────────────── */
  async _tryStart() {
    this.el.errText.textContent = '';

    // Camera API requires a secure context (HTTPS or localhost).
    // When opened via file:// or plain http://, mediaDevices is undefined.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this._showScreen('perm');
      this.el.errText.innerHTML =
        'Camera unavailable.<br>' +
        'Open via <strong>localhost</strong> — not <code>file://</code>.<br>' +
        'Run: <code>python3 -m http.server 8080</code><br>' +
        'then open <a href="http://localhost:8080" style="color:#b8ff57">localhost:8080</a>';
      return;
    }

    try {
      await this._startCamera();
      this._showScreen('cam');
      this._initMap();
      this._startGeo();
      this._enumerateCameras();
    } catch (err) {
      this._showScreen('perm');
      if (err.name === 'NotAllowedError') {
        this.el.errText.textContent = 'Camera access denied. Allow it in your browser settings and try again.';
      } else if (err.name === 'NotFoundError') {
        this.el.errText.textContent = 'No camera found on this device.';
      } else if (err.name === 'NotSupportedError' || err.name === 'TypeError') {
        this.el.errText.innerHTML =
          'Camera unavailable in this context.<br>' +
          'Serve via <a href="http://localhost:8080" style="color:#b8ff57">localhost:8080</a> instead of <code>file://</code>.';
      } else {
        this.el.errText.textContent = `Could not start camera: ${err.message}`;
      }
    }
  }

  _showScreen(which) {
    this.el.permScreen.classList.toggle('hidden', which !== 'perm');
    this.el.camScreen.classList.toggle('hidden',  which !== 'cam');
    this.el.prevScreen.classList.toggle('hidden', which !== 'prev');
  }

  /* ─────────────────────────────────────────────
     CAMERA
  ───────────────────────────────────────────── */
  async _startCamera() {
    // Stop existing stream
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }

    const videoConstraint = this.selectedDeviceId
      ? { deviceId: { exact: this.selectedDeviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      : { facingMode: { ideal: this.facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } };

    const constraints = {
      video: videoConstraint,
      audio: this.mode === 'video',
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.el.video.srcObject = this.stream;

    const activeTrack = this.stream.getVideoTracks()[0];
    if (activeTrack) {
      const settings = activeTrack.getSettings ? activeTrack.getSettings() : {};
      this.activeDeviceId = settings.deviceId || this.selectedDeviceId;

      // Check facing mode for mirror effect
      const facing = settings.facingMode || (activeTrack.label.toLowerCase().includes('front') || activeTrack.label.toLowerCase().includes('user') ? 'user' : this.facingMode);
      this.el.video.style.transform = facing === 'user' ? 'scaleX(-1)' : '';
    }

    return new Promise(resolve => {
      this.el.video.onloadedmetadata = () => resolve();
    });
  }

  async _flipCamera() {
    this.selectedDeviceId = null; // reset specific device selection when flipping
    this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';

    // Fade out → switch → fade in
    this.el.video.style.opacity = '0';
    await this._sleep(180);

    try {
      await this._startCamera();
      this._enumerateCameras();
    } catch {
      // revert if the facing mode is not supported
      this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
      await this._startCamera().catch(() => {});
    }

    this.el.video.style.opacity = '1';
  }

  async _enumerateCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      if (this.el.camList) {
        this.el.camList.innerHTML = '<div class="cam-empty-msg">Camera list unavailable</div>';
      }
      return;
    }

    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      this.videoDevices = devices.filter(d => d.kind === 'videoinput');

      // If labels are missing and stream is active, re-query
      if (this.videoDevices.length > 0 && !this.videoDevices[0].label && this.stream) {
        devices = await navigator.mediaDevices.enumerateDevices();
        this.videoDevices = devices.filter(d => d.kind === 'videoinput');
      }

      const activeTrack    = this.stream ? this.stream.getVideoTracks()[0] : null;
      const activeSettings = activeTrack && activeTrack.getSettings ? activeTrack.getSettings() : {};
      const activeId       = activeSettings.deviceId || this.selectedDeviceId || this.activeDeviceId;
      const activeLabel    = activeTrack ? activeTrack.label : '';

      if (this.el.camCount) {
        this.el.camCount.textContent = `${this.videoDevices.length} found`;
      }

      if (this.el.camList) {
        this.el.camList.innerHTML = '';

        if (this.videoDevices.length === 0) {
          this.el.camList.innerHTML = '<div class="glass-empty-msg">No cameras detected</div>';
          return;
        }

        this.videoDevices.forEach((device, index) => {
          const isMatch = (activeId && device.deviceId === activeId) || (!activeId && index === 0) || (activeLabel && device.label === activeLabel);

          let rawName = device.label || `Camera ${index + 1}`;
          let subType = 'Camera Input';
          const lower = rawName.toLowerCase();
          if (lower.includes('facetime') || lower.includes('built-in') || lower.includes('isight') || lower.includes('integrated') || lower.includes('internal')) {
            subType = 'Built-in';
          } else if (lower.includes('usb') || lower.includes('webcam') || lower.includes('external') || lower.includes('c920') || lower.includes('c922') || lower.includes('brio') || lower.includes('droidcam') || lower.includes('obs')) {
            subType = 'USB Camera';
          } else if (lower.includes('back') || lower.includes('rear') || lower.includes('environment')) {
            subType = 'Rear Camera';
          } else if (lower.includes('front') || lower.includes('user') || lower.includes('selfie')) {
            subType = 'Front Camera';
          }

          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `glass-cam-item ${isMatch ? 'active' : ''}`;
          btn.innerHTML = `
            <div class="glass-cam-info">
              <span class="glass-cam-name" title="${rawName}">${rawName}</span>
              <span class="glass-cam-sub">${subType}</span>
            </div>
            ${isMatch ? '<span class="glass-cam-check">✓</span>' : ''}
          `;

          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (isMatch) {
              this.el.camMenu.classList.remove('show');
              return;
            }

            this.selectedDeviceId = device.deviceId;
            this.activeDeviceId   = device.deviceId;
            this.el.camMenu.classList.remove('show');

            this.el.video.style.opacity = '0';
            await this._sleep(150);
            try {
              await this._startCamera();
            } catch (err) {
              console.error('Failed to switch camera device:', err);
            }
            await this._enumerateCameras();
            this.el.video.style.opacity = '1';
          });

          this.el.camList.appendChild(btn);
        });
      }
    } catch (err) {
      console.error('Error enumerating cameras:', err);
      if (this.el.camList) {
        this.el.camList.innerHTML = '<div class="glass-empty-msg">Could not query camera devices</div>';
      }
    }
  }

  /* ─────────────────────────────────────────────
     MODE
  ───────────────────────────────────────────── */
  async _setMode(mode) {
    if (this.isRecording) await this._stopRecording(); // discard current recording
    this.mode = mode;

    this.el.btnModePhoto.classList.toggle('active', mode === 'photo');
    this.el.btnModeVideo.classList.toggle('active', mode === 'video');
    this.el.camScreen.classList.toggle('video-mode', mode === 'video');

    // Restart to include/exclude audio track
    await this._startCamera().catch(() => {});
  }

  /* ─────────────────────────────────────────────
     HUD
  ───────────────────────────────────────────── */
  _toggleHUD() {
    this.hudEnabled = !this.hudEnabled;
    this.el.hud.classList.toggle('hud-out', !this.hudEnabled);
    this.el.btnHud.classList.toggle('dim', !this.hudEnabled);
    this.el.iconEye.classList.toggle('hidden', !this.hudEnabled);
    this.el.iconEyeOff.classList.toggle('hidden', this.hudEnabled);
  }

  /* ─────────────────────────────────────────────
     MAP
  ───────────────────────────────────────────── */
  /* ─────────────────────────────────────────────
     GOOGLE MAPS LOADER
  ───────────────────────────────────────────── */
  _loadGoogleMaps() {
    if (!GOOGLE_MAPS_KEY) return Promise.resolve();
    return new Promise(resolve => {
      window.__gmapsInit = () => {
        this.useGoogleMaps = true;
        resolve();
      };
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_KEY}&callback=__gmapsInit&loading=async`;
      s.async = true;
      s.onerror = resolve; // if key is bad, fall back gracefully
      document.head.appendChild(s);
    });
  }

  /* ─────────────────────────────────────────────
     MAP (Google Maps or Leaflet + Esri satellite)
  ───────────────────────────────────────────── */
  _initMap() {
    if (this.map) return;

    // ── Leaflet + CartoDB Voyager (clean road map, free, CORS-friendly) ──
    this.map = L.map(this.el.mapEl, {
      zoomControl:        false,
      attributionControl: false,
      dragging:           false,
      touchZoom:          false,
      scrollWheelZoom:    false,
      doubleClickZoom:    false,
      keyboard:           false,
      tap:                false,
    }).setView([20, 0], 2);

    // CartoDB Voyager — crisp road map, great detail, no API key needed
    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      { maxZoom: 20, crossOrigin: true, subdomains: 'abcd' }
    ).addTo(this.map);

    // Classic Google-style red teardrop pin (compact & crisp)
    const pinIcon = L.divIcon({
      html: `<svg viewBox="0 0 24 36" width="16" height="24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 24 12 24S24 21 24 12C24 5.373 18.627 0 12 0z"
              fill="#ea4335" stroke="rgba(0,0,0,0.25)" stroke-width="0.7"/>
        <circle cx="12" cy="12" r="4.5" fill="white"/>
      </svg>`,
      className:  '',
      iconSize:   [16, 24],
      iconAnchor: [8, 24],
    });
    this.marker = L.marker([20, 0], { icon: pinIcon }).addTo(this.map);
  }

  _updateMap(lat, lng) {
    if (!this.map) return;
    this.map.setView([lat, lng], 16, { animate: false });
    this.marker.setLatLng([lat, lng]);
  }

  /* ─────────────────────────────────────────────
     GEOLOCATION
  ───────────────────────────────────────────── */
  _startGeo() {
    if (!('geolocation' in navigator)) {
      this.el.hudAddr.textContent = 'GPS unavailable';
      this.el.hudAddr.classList.remove('acquiring');
      return;
    }

    this.geoWatchID = navigator.geolocation.watchPosition(
      pos => this._onPos(pos),
      ()  => {
        this.el.hudAddr.textContent = 'Location unavailable';
        this.el.hudAddr.classList.remove('acquiring');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  }

  _onPos({ coords: { latitude: lat, longitude: lng } }) {
    this.location = { lat, lng };
    this.el.hudAddr.classList.remove('acquiring');

    this.el.hudCoords.textContent = `Lat ${lat.toFixed(6)}\u00b0 Long ${lng.toFixed(6)}\u00b0`;

    this._updateMap(lat, lng);
    this._geocode(lat, lng);
  }

  _geocode(lat, lng) {
    // Skip if location hasn't moved significantly (~50 m threshold)
    if (this.lastGeocoded) {
      const d = Math.hypot(lat - this.lastGeocoded.lat, lng - this.lastGeocoded.lng);
      if (d < 0.0005) return;
    }

    clearTimeout(this.geocodeTimer);
    this.geocodeTimer = setTimeout(async () => {
      try {
        // zoom=18 gives maximum address detail
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
        const res  = await fetch(url, { headers: { 'Accept-Language': 'en-US,en' } });
        const json = await res.json();
        const a    = json.address || {};

        // ── Line 1: City, State, Country (No country flags) ──
        const city    = a.city || a.town || a.village || a.county || '';
        const state   = a.state || '';
        const country = a.country || '';
        this.addrCity = [city, state, country].filter(Boolean).join(', ');

        // ── Line 2: Full street address ──
        const streetParts = [
          a.amenity || a.building || a.shop || a.tourism,
          [a.house_number, a.road || a.pedestrian || a.path || a.footway].filter(Boolean).join(', '),
          a.suburb || a.neighbourhood || a.quarter,
          a.city_district,
          city,
          state,
          a.postcode,
          country,
        ].filter(Boolean);
        this.addrFull = streetParts.join(', ');

        // Update live HUD
        this.el.hudAddr.textContent     = this.addrCity;
        this.el.hudAddrFull.textContent = this.addrFull || 'Precise address unavailable';
        this.lastGeocoded = { lat, lng };
      } catch {
        const fallback = `${Math.abs(lat).toFixed(4)}\u00b0 ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}\u00b0 ${lng >= 0 ? 'E' : 'W'}`;
        this.addrCity = fallback;
        this.addrFull = '';
        this.el.hudAddr.textContent     = fallback;
        this.el.hudAddrFull.textContent = 'Precise address unavailable';
      }
    }, 600);
  }

  /** Full datetime string matching reference: "Saturday, 02/05/2026 10:23 AM GMT +05:30" */
  _formatDateTime() {
    const now  = new Date();
    const day  = now.toLocaleDateString('en-US', { weekday: 'long' });
    const d    = String(now.getDate()).padStart(2, '0');
    const m    = String(now.getMonth() + 1).padStart(2, '0');
    const y    = now.getFullYear();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    return `${day}, ${d}/${m}/${y} ${time} ${this._tzStr()}`;
  }

  _tzStr() {
    const off  = -new Date().getTimezoneOffset(); // minutes ahead of UTC
    const sign = off >= 0 ? '+' : '-';
    const h    = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
    const m    = String(Math.abs(off) % 60).padStart(2, '0');
    return `GMT ${sign}${h}:${m}`;
  }

  /* ─────────────────────────────────────────────
     SHUTTER
  ───────────────────────────────────────────── */
  _onShutter() {
    if (this.mode === 'photo') {
      this._capturePhoto();
    } else if (this.isRecording) {
      // Stop recording and auto-download
      this._stopRecording().then(blob => {
        if (!blob) return;
        const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
        const url = URL.createObjectURL(blob);
        this._download(url, `LocoCam_${this._timestamp()}.${ext}`);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      });
    } else {
      this._startRecording();
    }
  }

  /* ─────────────────────────────────────────────
     PHOTO CAPTURE — auto-download in High Quality
  ───────────────────────────────────────────── */
  async _capturePhoto() {
    this._doFlash();

    const video = this.el.video;
    const W = video.videoWidth;
    const H = video.videoHeight;
    if (!W || !H) return;

    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d', { alpha: false });
    canvas.width  = W;
    canvas.height = H;

    // Enable high-quality smoothing for sharp export
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.drawImage(video, 0, 0, W, H);

    if (this.hudEnabled && this.location) {
      await this._burnHUD(ctx, W, H);
    }

    // Auto-download immediately in high-quality (0.98 quality)
    this._download(canvas.toDataURL('image/jpeg', 0.98), `LocoCam_${this._timestamp()}.jpg`);
  }

  /* ─────────────────────────────────────────────
     HUD BURN-IN  (High Quality, Top Padding, Generous Badge Padding)
  ───────────────────────────────────────────── */
  async _burnHUD(ctx, W, H) {
    const isPortrait = H > W;
    const cardH   = isPortrait ? Math.max(110, Math.round(H * 0.125)) : Math.max(110, Math.round(H * 0.165));
    const innerPad = Math.round(cardH * 0.08);

    // Exact 1:1 Square Map
    const mapSize  = Math.round(cardH - innerPad * 2);
    const mapW     = mapSize;
    const mapH     = mapSize;

    // Font sizes (enlarged for prominence & legibility)
    const fsTitle = Math.max(14.5, Math.round(cardH * 0.155));
    const fsAddr  = Math.max(11, Math.round(cardH * 0.108));
    const fsMeta  = Math.max(11, Math.round(cardH * 0.105));

    const cityLine  = this.addrCity || 'Unknown location';
    const { lat, lng } = this.location;
    const coordsStr = `Lat ${lat.toFixed(6)}\u00b0  Long ${lng.toFixed(6)}\u00b0`;
    const timeStr   = this._formatDateTime();
    const addrStr   = this.addrFull || 'Precise address unavailable';

    // ── Measure Text Width to Fit Container Content ──
    ctx.font = `700 ${fsTitle}px Inter, -apple-system, sans-serif`;
    const wTitle = ctx.measureText(cityLine).width;

    ctx.font = `500 ${fsMeta}px "JetBrains Mono", monospace`;
    const wCoords = ctx.measureText(coordsStr).width;
    const wTime   = ctx.measureText(timeStr).width;

    ctx.font = `400 ${fsAddr}px Inter, -apple-system, sans-serif`;
    const wAddrRaw = ctx.measureText(addrStr).width;

    const maxAllowedTextW = Math.round(W * (isPortrait ? 0.65 : 0.5));
    const minTextW        = Math.max(wTitle, wCoords, wTime, Math.min(wAddrRaw, maxAllowedTextW));
    const textW           = Math.min(maxAllowedTextW, Math.max(minTextW, Math.round(W * 0.3)));

    // Dynamic Card Width (only as wide as necessary)
    const cardW = innerPad + mapW + Math.round(innerPad * 1.15) + textW + innerPad;

    // Bottom-Left Alignment
    const cardX   = Math.round(W * 0.03);
    const cardPadY = Math.round(H * 0.025);
    const cardY   = H - cardH - cardPadY;
    const cardR   = Math.max(12, Math.round(cardH * 0.1));

    // ── 1. Dark Gradient Vignette for Readability ──
    const grad = ctx.createLinearGradient(0, cardY - cardH * 0.5, 0, H);
    grad.addColorStop(0,    'rgba(0,0,0,0)');
    grad.addColorStop(0.35, 'rgba(0,0,0,0.55)');
    grad.addColorStop(1,    'rgba(0,0,0,0.92)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, cardY - cardH * 0.5, W, H - (cardY - cardH * 0.5));

    // ── 2. Glassmorphism HUD Card Container ──
    ctx.save();
    ctx.fillStyle = 'rgba(10, 10, 22, 0.86)';
    ctx.beginPath();
    this._rrect(ctx, cardX, cardY, cardW, cardH, cardR);
    ctx.fill();

    // Subtle luminous card border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = Math.max(1.5, Math.round(W * 0.0015));
    ctx.stroke();
    ctx.restore();

    // ── 3. Exact 1:1 Square Map Thumbnail (Zoom 16 for optimal detail) ──
    const mapX    = cardX + innerPad;
    const mapY    = cardY + innerPad;
    const mapR    = Math.max(9, Math.round(cardR * 0.75));

    try {
      await this._drawMapTiles(ctx, this.location.lat, this.location.lng, mapX, mapY, mapW, mapH, 16, mapR);
    } catch {
      ctx.save();
      ctx.fillStyle = '#20202a';
      ctx.beginPath();
      this._rrect(ctx, mapX, mapY, mapW, mapH, mapR);
      ctx.fill();
      ctx.restore();
    }

    // Map thumbnail border
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
    ctx.lineWidth = Math.max(1.2, Math.round(W * 0.001));
    ctx.beginPath();
    this._rrect(ctx, mapX, mapY, mapW, mapH, mapR);
    ctx.stroke();
    ctx.restore();

    // ── 4. LocoCam Notification Tag inside Bottom-Right Corner (Generous Padding) ──
    const fsBadge   = Math.max(9, Math.round(cardH * 0.082));
    const padBadgeX = Math.round(fsBadge * 1.05);
    const padBadgeY = Math.round(fsBadge * 0.44);

    ctx.save();
    ctx.font = `700 ${fsBadge}px Inter, sans-serif`;
    const wBadgeText = ctx.measureText('LOCOCAM').width;
    const badgeW = Math.round(wBadgeText + padBadgeX * 2);
    const badgeH = Math.round(fsBadge + padBadgeY * 2);
    const badgeX = cardX + cardW - badgeW - innerPad;
    const badgeY = cardY + cardH - badgeH - innerPad;
    const badgeR = badgeH / 2;

    ctx.fillStyle = 'rgba(10, 10, 22, 0.96)';
    ctx.beginPath();
    this._rrect(ctx, badgeX, badgeY, badgeW, badgeH, badgeR);
    ctx.fill();
    ctx.strokeStyle = 'rgba(184, 255, 87, 0.55)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Centered "LOCOCAM" text
    ctx.fillStyle = '#b8ff57';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('LOCOCAM', badgeX + badgeW / 2, badgeY + badgeH / 2);
    ctx.restore();

    // ── 5. Info Section (With Slight Top Padding & Gap-Free Text) ──
    const textX      = mapX + mapW + Math.round(innerPad * 1.15);
    const textPadTop = Math.max(3, Math.round(cardH * 0.035));
    const lineGap    = Math.round(fsMeta * 0.28);

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    // A. City, State, Country Title (With slight top padding)
    const titleY = mapY + textPadTop;
    ctx.fillStyle = '#ffffff';
    ctx.font      = `700 ${fsTitle}px Inter, -apple-system, sans-serif`;
    ctx.fillText(this._ellipsis(ctx, cityLine, textW), textX, titleY);

    // B. Full Detailed Street Address (Flows directly below title)
    const addrY = titleY + fsTitle + lineGap;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.font      = `400 ${fsAddr}px Inter, -apple-system, sans-serif`;
    const nextY  = this._wrapTextY(ctx, addrStr, textX, addrY, textW, fsAddr * 1.3, 2);

    // C. Coordinates (Flows directly below address without artificial gap)
    const coordsY  = nextY + lineGap;
    ctx.fillStyle  = 'rgba(255, 255, 255, 0.76)';
    ctx.font       = `500 ${fsMeta}px "JetBrains Mono", monospace`;
    ctx.fillText(coordsStr, textX, coordsY);

    // D. Date & Time (Flows directly below coordinates)
    const timeY   = coordsY + fsMeta + lineGap;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.font      = `500 ${fsMeta}px "JetBrains Mono", monospace`;
    ctx.fillText(timeStr, textX, timeY);

    ctx.restore();
  }

  /**
   * Composites CartoDB Voyager road tiles onto ctx.
   * Uses @2x retina tiles and 2px overlap for ultra-high sharpness.
   */
  async _drawMapTiles(ctx, lat, lng, mx, my, mw, mh, zoom, cornerRadius = 8) {
    const TS    = 256;
    const scale = Math.pow(2, zoom);
    const latR  = lat * Math.PI / 180;

    const gpx = (lng + 180) / 360 * scale * TS;
    const gpy = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * scale * TS;

    const ctX   = Math.floor(gpx / TS);
    const ctY   = Math.floor(gpy / TS);
    const fracX = gpx % TS;
    const fracY = gpy % TS;

    const oriX = mx + mw / 2 - fracX;
    const oriY = my + mh / 2 - fracY;
    const rX   = Math.ceil(mw / TS) + 2;
    const rY   = Math.ceil(mh / TS) + 2;

    const subs = ['a', 'b', 'c', 'd'];
    const jobs = [];
    for (let dy = -rY; dy <= rY; dy++) {
      for (let dx = -rX; dx <= rX; dx++) {
        const tx = ctX + dx;
        const ty = ctY + dy;
        const px = oriX + dx * TS;
        const py = oriY + dy * TS;
        if (px + TS <= mx || px >= mx + mw) continue;
        if (py + TS <= my || py >= my + mh) continue;

        const s   = subs[(Math.abs(tx) + Math.abs(ty)) % 4];
        // @2x retina tiles for crisp HD output
        const url = `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/${zoom}/${tx}/${ty}@2x.png`;
        jobs.push(this._loadImg(url).then(img => ({ img, px, py })).catch(() => {
          // Fallback to standard 1x tile if 2x fails
          const fbUrl = `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/${zoom}/${tx}/${ty}.png`;
          return this._loadImg(fbUrl).then(img => ({ img, px, py })).catch(() => null);
        }));
      }
    }

    const tiles = await Promise.all(jobs);

    ctx.save();
    ctx.beginPath();
    this._rrect(ctx, mx, my, mw, mh, cornerRadius);
    ctx.clip();

    // Fill neutral CartoDB base tone underneath to prevent any background transparency
    ctx.fillStyle = '#f2efe9';
    ctx.fillRect(mx, my, mw, mh);

    // Draw tiles with integer coordinates & 2px overlap to eliminate hairline seams
    for (const t of tiles) {
      if (t) {
        ctx.drawImage(t.img, Math.floor(t.px), Math.floor(t.py), TS + 2, TS + 2);
      }
    }

    // Red teardrop pin at the center (proportional to map size)
    this._drawRedPin(ctx, mx + mw / 2, my + mh / 2, mw);

    ctx.restore();
  }

  /** Draws a classic Google Maps red teardrop pin (properly proportioned, not elongated) */
  _drawRedPin(ctx, cx, cy, mapW = 100) {
    const r     = Math.max(5.5, Math.round(mapW * 0.065));
    const headY = cy - Math.round(r * 1.8); // center of circle

    ctx.save();
    ctx.shadowColor   = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur    = Math.max(3, Math.round(r * 0.4));
    ctx.shadowOffsetY = Math.max(1.5, Math.round(r * 0.2));

    // Teardrop body
    ctx.beginPath();
    ctx.arc(cx, headY, r, Math.PI, 0, false);            // top semi-circle
    ctx.quadraticCurveTo(cx + r, headY + r * 0.9, cx, cy); // right curve to tip
    ctx.quadraticCurveTo(cx - r, headY + r * 0.9, cx - r, headY); // left curve from tip
    ctx.closePath();
    ctx.fillStyle = '#ea4335';
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // White center dot
    ctx.beginPath();
    ctx.arc(cx, headY, r * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = 'white';
    ctx.fill();

    ctx.restore();
  }

  /* ─────────────────────────────────────────────
     VIDEO RECORDING
  ───────────────────────────────────────────── */
  _startRecording() {
    if (!this.stream) return;

    this.chunks      = [];
    this.isRecording = true;
    this.recSecs     = 0;

    this.el.camScreen.classList.add('recording');
    this.el.recBar.classList.remove('hidden');

    const mimeType = [
      'video/mp4;codecs=h264,aac',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ].find(t => MediaRecorder.isTypeSupported(t)) || '';

    this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : {});
    this.mediaRecorder.ondataavailable = e => { if (e.data?.size > 0) this.chunks.push(e.data); };
    this.mediaRecorder.start(100);

    this.recTimerID = setInterval(() => {
      this.recSecs++;
      const m = String(Math.floor(this.recSecs / 60)).padStart(2, '0');
      const s = String(this.recSecs % 60).padStart(2, '0');
      this.el.recTime.textContent = `${m}:${s}`;
    }, 1000);
  }

  _stopRecording() {
    return new Promise(resolve => {
      if (!this.isRecording || !this.mediaRecorder) { resolve(null); return; }

      this.isRecording = false;
      clearInterval(this.recTimerID);
      this.el.camScreen.classList.remove('recording');
      this.el.recBar.classList.add('hidden');
      this.el.recTime.textContent = '00:00';

      this.mediaRecorder.addEventListener('stop', () => {
        const mime = this.mediaRecorder.mimeType || 'video/webm';
        resolve(new Blob(this.chunks, { type: mime }));
      }, { once: true });

      this.mediaRecorder.stop();
    });
  }

  /* ─────────────────────────────────────────────
     PREVIEW
  ───────────────────────────────────────────── */
  _showPreview() {
    this._showScreen('prev');

    if (this.capturedType === 'photo') {
      this.el.prevImg.src = this.capturedURL;
      this.el.prevImg.classList.remove('hidden');
      this.el.prevVid.classList.add('hidden');
    } else {
      const url = URL.createObjectURL(this.capturedBlob);
      this.el.prevVid.src = url;
      this.el.prevVid.classList.remove('hidden');
      this.el.prevImg.classList.add('hidden');
    }
  }

  _retake() {
    this.el.prevImg.src = '';
    this.el.prevVid.src = '';
    this.capturedURL  = null;
    this.capturedBlob = null;
    this._showScreen('cam');
  }

  _save() {
    if (this.capturedType === 'photo') {
      this._download(this.capturedURL, `LocoCam_${this._timestamp()}.jpg`);
    } else {
      const ext = this.capturedBlob.type.includes('mp4') ? 'mp4' : 'webm';
      const url = URL.createObjectURL(this.capturedBlob);
      this._download(url, `LocoCam_${this._timestamp()}.${ext}`);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    this._retake();
  }

  /* ─────────────────────────────────────────────
     UTILITIES
  ───────────────────────────────────────────── */

  _doFlash() {
    const f = this.el.flash;
    f.classList.remove('go');
    void f.offsetWidth; // force reflow
    f.classList.add('go');
  }

  _onTap(e) {
    const r = this.el.focusRing;
    r.style.left = `${e.clientX}px`;
    r.style.top  = `${e.clientY}px`;
    r.classList.remove('show');
    void r.offsetWidth;
    r.classList.add('show');
    setTimeout(() => r.classList.remove('show'), 700);
  }

  /** Draws ctx text wrapped within maxW, up to maxLines lines */
  _wrapText(ctx, text, x, y, maxW, lineH, maxLines) {
    const words = text.split(' ');
    let line  = '';
    let count = 0;

    for (let i = 0; i < words.length; i++) {
      const test = line + words[i] + ' ';
      if (ctx.measureText(test).width > maxW && i > 0) {
        ctx.fillText(line.trim(), x, y);
        y += lineH;
        count++;
        if (count >= maxLines - 1) {
          ctx.fillText(this._ellipsis(ctx, words.slice(i).join(' '), maxW), x, y);
          return;
        }
        line = words[i] + ' ';
      } else {
        line = test;
      }
    }
    ctx.fillText(line.trim(), x, y);
  }

  _ellipsis(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
    return text + '…';
  }

  /** Rounded-rectangle path helper */
  _rrect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y,     x + w, y + r,     r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x,     y + h, x,     y + h - r, r);
    ctx.lineTo(x,     y + r);
    ctx.arcTo(x,     y,     x + r, y,         r);
    ctx.closePath();
  }

  _loadImg(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  /** Like _wrapText but returns the Y position after the last drawn line */
  _wrapTextY(ctx, text, x, y, maxW, lineH, maxLines) {
    if (!text) return y;
    const words = text.split(' ');
    let line  = '';
    let count = 0;

    for (let i = 0; i < words.length; i++) {
      const test = line + words[i] + ' ';
      if (ctx.measureText(test).width > maxW && i > 0) {
        ctx.fillText(line.trim(), x, y);
        y += lineH;
        count++;
        if (count >= maxLines - 1) {
          ctx.fillText(this._ellipsis(ctx, words.slice(i).join(' '), maxW), x, y);
          y += lineH;
          return y;
        }
        line = words[i] + ' ';
      } else {
        line = test;
      }
    }
    if (line.trim()) {
      ctx.fillText(line.trim(), x, y);
      y += lineH;
    }
    return y;
  }

  _download(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }

  _timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

/* ── Boot ── */
window.addEventListener('DOMContentLoaded', () => new LocoCam());
