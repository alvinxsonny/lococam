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

      prevImg    : q('prev-img'),
      prevVid    : q('prev-vid'),
      btnRetake  : q('btn-retake'),
      btnSave    : q('btn-save'),
    };

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

    const constraints = {
      video: {
        facingMode: { ideal: this.facingMode },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: this.mode === 'video',
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.el.video.srcObject = this.stream;

    // Mirror front camera (selfie view)
    this.el.video.style.transform = this.facingMode === 'user' ? 'scaleX(-1)' : '';

    return new Promise(resolve => {
      this.el.video.onloadedmetadata = () => resolve();
    });
  }

  async _flipCamera() {
    this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';

    // Fade out → switch → fade in
    this.el.video.style.opacity = '0';
    await this._sleep(180);

    try {
      await this._startCamera();
    } catch {
      // revert if the facing mode is not supported
      this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
      await this._startCamera().catch(() => {});
    }

    this.el.video.style.opacity = '1';
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

    // Classic Google-style red teardrop pin
    const pinIcon = L.divIcon({
      html: `<svg viewBox="0 0 24 36" width="24" height="36" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 24 12 24S24 21 24 12C24 5.373 18.627 0 12 0z"
              fill="#ea4335" stroke="rgba(0,0,0,0.25)" stroke-width="0.6"/>
        <circle cx="12" cy="12" r="5" fill="white"/>
      </svg>`,
      className:  '',
      iconSize:   [24, 36],
      iconAnchor: [12, 36],
    });
    this.marker = L.marker([20, 0], { icon: pinIcon }).addTo(this.map);
  }

  _updateMap(lat, lng) {
    if (!this.map) return;
    this.map.setView([lat, lng], 17, { animate: false });
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

    this.el.hudCoords.textContent = `Lat ${lat.toFixed(6)}\u00b0  Long ${lng.toFixed(6)}\u00b0`;

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

        // ── Line 1: City, State, Country + flag emoji ──
        const city    = a.city || a.town || a.village || a.county || '';
        const state   = a.state || '';
        const country = a.country || '';
        this.addrCity = [city, state, country].filter(Boolean).join(', ');
        this.addrFlag = this._countryFlag(a.country_code);

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
        this.el.hudAddr.textContent     = this.addrCity + (this.addrFlag ? ` ${this.addrFlag}` : '');
        this.el.hudAddrFull.textContent = this.addrFull;
        this.lastGeocoded = { lat, lng };
      } catch {
        const fallback = `${Math.abs(lat).toFixed(4)}\u00b0 ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}\u00b0 ${lng >= 0 ? 'E' : 'W'}`;
        this.addrCity = fallback;
        this.addrFull = '';
        this.addrFlag = '';
        this.el.hudAddr.textContent     = fallback;
        this.el.hudAddrFull.textContent = '';
      }
    }, 600);
  }

  /** Convert ISO 3166-1 alpha-2 country code to flag emoji */
  _countryFlag(code) {
    if (!code || code.length !== 2) return '';
    try {
      return [...code.toUpperCase()].map(c => String.fromCodePoint(c.charCodeAt(0) + 127397)).join('');
    } catch { return ''; }
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
     PHOTO CAPTURE — auto-download, no preview
  ───────────────────────────────────────────── */
  async _capturePhoto() {
    this._doFlash();

    const video = this.el.video;
    const W = video.videoWidth;
    const H = video.videoHeight;
    if (!W || !H) return;

    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d');
    canvas.width  = W;
    canvas.height = H;

    ctx.drawImage(video, 0, 0, W, H);

    if (this.hudEnabled && this.location) {
      await this._burnHUD(ctx, W, H);
    }

    // Auto-download immediately
    this._download(canvas.toDataURL('image/jpeg', 0.93), `LocoCam_${this._timestamp()}.jpg`);
  }

  /* ─────────────────────────────────────────────
     HUD BURN-IN  (matches reference image layout)
  ───────────────────────────────────────────── */
  async _burnHUD(ctx, W, H) {
    const PAD  = Math.round(W * 0.02);
    const hudH = Math.max(160, Math.round(H * 0.22));
    const mapW = Math.round(hudH * 1.05);   // roughly square map
    const mapH = hudH - PAD;
    const mapX = PAD;
    const mapY = H - hudH;                   // top of HUD area
    const mY   = mapY + Math.round(PAD * 0.4); // map with slight top padding

    // ── Dark gradient vignette ──
    const grad = ctx.createLinearGradient(0, mapY - hudH * 0.6, 0, H);
    grad.addColorStop(0,    'rgba(0,0,0,0)');
    grad.addColorStop(0.25, 'rgba(0,0,0,0.5)');
    grad.addColorStop(1,    'rgba(0,0,0,0.92)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, mapY - hudH * 0.6, W, H - (mapY - hudH * 0.6));

    // ── Map thumbnail ──
    try {
      // CartoDB Voyager road tiles — zoom 17 for street-level detail
      await this._drawMapTiles(ctx, this.location.lat, this.location.lng, mapX, mY, mapW, mapH, 17);
    } catch {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      this._rrect(ctx, mapX, mY, mapW, mapH, 8);
      ctx.fill();
      ctx.restore();
    }

    // ── Text column ──
    const textX = mapX + mapW + PAD;
    const textW = W - textX - PAD;
    const fs1   = Math.max(20, Math.round(hudH * 0.165)); // City, State, Country
    const fs2   = Math.max(13, Math.round(hudH * 0.115)); // Full street address
    const fs3   = Math.max(11, Math.round(hudH * 0.10));  // Coords & datetime

    let y = mY + fs1;

    // Line 1: "Bengaluru, Karnataka, India 🇮🇳"
    ctx.fillStyle = 'rgba(255,255,255,0.97)';
    ctx.font      = `700 ${fs1}px Inter, -apple-system, sans-serif`;
    const cityLine = (this.addrCity || 'Unknown location') + (this.addrFlag ? ` ${this.addrFlag}` : '');
    ctx.fillText(this._ellipsis(ctx, cityLine, textW), textX, y);
    y += fs1 * 1.5;

    // Lines 2-3: Full street address (wraps up to 2 lines)
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.font      = `400 ${fs2}px Inter, -apple-system, sans-serif`;
    y = this._wrapTextY(ctx, this.addrFull || '', textX, y, textW, fs2 * 1.38, 2);
    y += fs3 * 0.55;

    // Line 4: "Lat 12.995497° Long 77.763665°"
    const { lat, lng } = this.location;
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.font      = `400 ${fs3}px Inter, -apple-system, sans-serif`;
    ctx.fillText(`Lat ${lat.toFixed(6)}\u00b0  Long ${lng.toFixed(6)}\u00b0`, textX, y);
    y += fs3 * 1.45;

    // Line 5: "Saturday, 02/05/2026 10:23 AM GMT +05:30"
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font      = `400 ${fs3}px Inter, -apple-system, sans-serif`;
    ctx.fillText(this._formatDateTime(), textX, y);
  }

  /* Composites OSM tile images onto ctx, centered on (lat, lng) */
  /** Composites CartoDB Voyager road tiles onto ctx, centered on (lat, lng), with a red pin */
  async _drawMapTiles(ctx, lat, lng, mx, my, mw, mh, zoom) {
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

        // CartoDB Voyager — clean road map, CORS-enabled, free
        const s   = subs[(Math.abs(tx) + Math.abs(ty)) % 4];
        const url = `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/${zoom}/${tx}/${ty}.png`;
        jobs.push(this._loadImg(url).then(img => ({ img, px, py })).catch(() => null));
      }
    }

    const tiles = await Promise.all(jobs);

    ctx.save();
    ctx.beginPath();
    this._rrect(ctx, mx, my, mw, mh, 8);
    ctx.clip();

    for (const t of tiles) if (t) ctx.drawImage(t.img, t.px, t.py, TS, TS);

    // Red teardrop pin at the center (your location)
    this._drawRedPin(ctx, mx + mw / 2, my + mh / 2);

    ctx.restore();
  }

  /** Draws a Google Maps-style red teardrop pin centered at (cx, cy tip) */
  _drawRedPin(ctx, cx, cy) {
    const r    = Math.max(8, Math.round((cy - (cy - 18)) * 0.9)) || 9;
    const tailH = r * 1.55;
    const pinY  = cy - tailH - r; // top of circle

    ctx.save();
    ctx.shadowColor   = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur    = 8;
    ctx.shadowOffsetY = 3;

    // Teardrop body
    ctx.beginPath();
    ctx.arc(cx, pinY, r, Math.PI, 0);         // top half
    ctx.quadraticCurveTo(cx + r, pinY + r * 1.1, cx, cy);  // right curve to tip
    ctx.quadraticCurveTo(cx - r, pinY + r * 1.1, cx - r, pinY); // left curve back
    ctx.closePath();
    ctx.fillStyle = '#ea4335';
    ctx.fill();

    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

    // White dot
    ctx.beginPath();
    ctx.arc(cx, pinY, r * 0.42, 0, Math.PI * 2);
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
