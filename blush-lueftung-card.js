/**
 * Blush Lüftungsempfehlung Card
 * Vergleicht Innen-/Außenluft (absolute Feuchte, Taupunkt) und gibt eine
 * Kosten-Nutzen-Lüftungsempfehlung. Fast jeder Baustein einzeln ein-/ausschaltbar.
 *
 * Algorithmus-Hinweise:
 * - Lüftungsdauer: stetige Formel ~ 1/sqrt(Temperaturdifferenz) statt fester Stufen
 *   (Auftriebs-/Stack-Effekt: Luftaustausch-Geschwindigkeit skaliert näherungsweise
 *   mit der Wurzel der Temperaturdifferenz), zusätzlich per Windfaktor verkürzt.
 * - "Lohnt sich"-Entscheidung: Wh pro Gramm entferntem Wasser als ein stetiges
 *   Verhältnis statt zwei unabhängiger Schwellenwerte.
 * - Alle Sensor-Felder sind echt optional/ohne versteckten Fallback: leer =
 *   leer, keine stillschweigende Default-Entity.
 *
 * Bekannte Grenze (bewusst nicht eingebaut): kein Frische-Check der Sensoren.
 * Ein eingefrorener Sensor (z.B. leere Batterie) wuerde unbemerkt mit altem
 * Wert weiterrechnen. Liesse sich per last_changed/last_updated ergaenzen.
 *
 * https://github.com/ (Repository-Link hier eintragen, sobald veroeffentlicht)
 */
class BlushLueftungCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement('blush-lueftung-card-editor');
  }
  static getStubConfig() {
    return {
      name: '',
      temp_out: '',
      hum_out: '',
      temp_in: '',
      hum_in: '',
      wind: '',
      room_volume_m3: 50,
      room_volume_is_estimate: true,
      show_columns: true,
      show_dewpoint: true,
      show_wind: true,
      show_trend: true,
      show_balance: true,
      show_heat_loss: true,
      show_mold_warning: true,
    };
  }
  setConfig(config) {
    this.config = {
      name: config.name || '',
      temp_out: config.temp_out || '',
      hum_out: config.hum_out || '',
      temp_in: config.temp_in || '',
      hum_in: config.hum_in || '',
      wind: config.wind || '',
      room_volume_m3: Math.max(1, config.room_volume_m3 || 50),
      room_volume_is_estimate: config.room_volume_is_estimate !== false,
      show_columns: config.show_columns !== false,
      show_dewpoint: config.show_dewpoint !== false,
      show_wind: config.show_wind !== false,
      show_trend: config.show_trend !== false,
      show_balance: config.show_balance !== false,
      show_heat_loss: config.show_heat_loss !== false,
      show_mold_warning: config.show_mold_warning !== false,
    };
    this._histOut = this._histOut || [];
    this._histIn = this._histIn || [];
    if (this.content) this._applyToggles();
  }
  _applyToggles() {
    if (!this.content) return;
    this.content.title.textContent = 'Lüftungsempfehlung' + (this.config.name ? ' – ' + this.config.name : '');
    this.content.cols.style.display = this.config.show_columns ? 'flex' : 'none';
    this.content.balance.style.display = this.config.show_balance ? 'flex' : 'none';
    this.content.outDpRow.style.display = this.config.show_dewpoint ? 'flex' : 'none';
    this.content.inDpRow.style.display = this.config.show_dewpoint ? 'flex' : 'none';
    this.content.outWindRow.style.display = (this.config.show_wind && this.config.wind) ? 'flex' : 'none';
    this.content.outTrendIcon.style.display = this.config.show_trend ? '' : 'none';
    this.content.outTrendLabel.style.display = this.config.show_trend ? '' : 'none';
    this.content.inTrendIcon.style.display = this.config.show_trend ? '' : 'none';
    this.content.inTrendLabel.style.display = this.config.show_trend ? '' : 'none';
    this.content.inVol.textContent = this.config.room_volume_m3 + ' m³';
    this.content.estimateNote.textContent = this.config.room_volume_is_estimate
      ? '⚠︎ Raumvolumen geschätzt – bitte nachmessen und anpassen' + (this.config.show_trend ? ' · Trend bezieht sich auf die letzten 20 Min. seit Laden der Seite' : '')
      : (this.config.show_trend ? '· Trend bezieht sich auf die letzten 20 Min. seit Laden der Seite' : '');
  }
  _svp(t) { return 6.112 * Math.exp((17.62 * t) / (243.12 + t)); }
  _absHum(t, rh) { return 216.7 * ((rh / 100) * this._svp(t)) / (t + 273.15); }
  _dewPoint(t, rh) {
    const a = 17.62, b = 243.12;
    const gamma = Math.log(rh / 100) + (a * t) / (b + t);
    return (b * gamma) / (a - gamma);
  }
  _trend(hist, current) {
    const now = Date.now();
    hist.push({ t: now, v: current });
    const cutoff = now - 20 * 60 * 1000;
    while (hist.length && hist[0].t < cutoff - 5 * 60 * 1000) hist.shift();
    const ref = hist.find((e) => e.t <= cutoff) || hist[0];
    if (!ref || ref === hist[hist.length - 1]) return { icon: 'mdi:trending-neutral', label: '' };
    const delta = current - ref.v;
    if (delta > 3) return { icon: 'mdi:trending-up', label: `+${delta.toFixed(0)}%/20min` };
    if (delta < -3) return { icon: 'mdi:trending-down', label: `${delta.toFixed(0)}%/20min` };
    return { icon: 'mdi:trending-neutral', label: 'stabil' };
  }
  _ventDurationMinutes(tempDiffAbs, wind) {
    const base = 18 / Math.sqrt(Math.max(tempDiffAbs, 0.5));
    const windFactor = (wind !== null && !isNaN(wind)) ? Math.max(0.5, 1 - wind * 0.02) : 1;
    return Math.min(25, Math.max(3, base * windFactor));
  }
  set hass(hass) {
    this._hass = hass;
    const g = (id) => { const s = id && hass.states[id]; return s ? parseFloat(s.state) : null; };
    const hasRequired = this.config.temp_out && this.config.hum_out && this.config.temp_in && this.config.hum_in;
    const tOut = g(this.config.temp_out), rhOut = g(this.config.hum_out);
    const tIn = g(this.config.temp_in), rhIn = g(this.config.hum_in);
    const wind = this.config.wind ? g(this.config.wind) : null;

    if (!this.content) {
      this.innerHTML = `
        <ha-card>
          <style>
            .wrap { padding: 16px; }
            .title { font-size: 1.15em; font-weight: 600; margin-bottom: 14px; display:flex; align-items:center; gap:8px; }
            .cols { display:flex; gap:10px; }
            .col { flex:1; background: rgba(127,127,127,0.08); border-radius: 14px; padding: 12px; position:relative; }
            .col-head { display:flex; align-items:center; gap:6px; font-size:0.85em; opacity:0.7; margin-bottom:8px; }
            .row { display:flex; justify-content:space-between; align-items:center; margin: 4px 0; font-size:0.92em; }
            .row .val { font-weight:600; display:flex; align-items:center; gap:3px; }
            .row .val ha-icon { --mdc-icon-size: 15px; }
            .row .trend-label { font-size:0.68em; opacity:0.55; font-weight:400; margin-left:2px; }
            .big { font-size:1.6em; font-weight:700; margin-bottom:2px; }
            .mold-badge { position:absolute; top:10px; right:10px; font-size:0.68em; font-weight:700; padding:2px 7px; border-radius:8px; display:none; align-items:center; gap:3px; }
            .mold-badge ha-icon { --mdc-icon-size: 13px; }
            .banner { margin-top:14px; border-radius:14px; padding:16px; display:flex; gap:12px; align-items:flex-start; transition: background 0.5s; }
            .banner ha-icon { --mdc-icon-size: 32px; flex-shrink:0; }
            .banner .headline { font-size:1.1em; font-weight:700; margin-bottom:3px; }
            .banner .sub { font-size:0.88em; opacity:0.85; line-height:1.4; margin-bottom:6px; }
            .banner .metric { font-size:0.82em; opacity:0.7; }
            .balance { display:flex; gap:8px; margin-top:14px; }
            .balance .side { flex:1; border-radius: 12px; padding: 10px; text-align:center; }
            .balance .side .label { font-size:0.72em; opacity:0.65; margin-bottom:2px; }
            .balance .side .amount { font-size:1.15em; font-weight:700; }
            .mold-banner { margin-top:10px; border-radius:14px; padding:12px 16px; display:none; gap:10px; align-items:center; }
            .mold-banner ha-icon { --mdc-icon-size: 24px; flex-shrink:0; }
            .mold-banner .txt { font-size:0.85em; line-height:1.4; }
            .mold-banner .txt b { display:block; margin-bottom:2px; }
            .estimate-note { font-size:0.72em; opacity:0.5; margin-top:10px; text-align:right; }
            .placeholder { padding: 28px 16px; text-align:center; opacity:0.6; font-size:0.9em; display:none; }
            .placeholder ha-icon { --mdc-icon-size: 28px; display:block; margin: 0 auto 8px; opacity:0.5; }
          </style>
          <div class="wrap">
            <div class="title"><ha-icon icon="mdi:window-open-variant"></ha-icon> <span id="card-title">Lüftungsempfehlung</span></div>
            <div class="placeholder" id="placeholder"><ha-icon icon="mdi:cog-outline"></ha-icon>Bitte im Karten-Editor die vier Pflicht-Sensoren auswählen (Außen-/Innen-Temperatur und -Luftfeuchte).</div>
            <div class="cols" id="cols">
              <div class="col" id="col-out">
                <div class="col-head"><ha-icon icon="mdi:tree"></ha-icon> Draußen</div>
                <div class="big" id="out-temp"></div>
                <div class="row"><span>Luftfeuchte</span><span class="val" id="out-rh"><ha-icon id="out-trend-icon"></ha-icon><span id="out-rh-text"></span><span class="trend-label" id="out-trend-label"></span></span></div>
                <div class="row"><span>Absolut</span><span class="val" id="out-ah"></span></div>
                <div class="row" id="out-dp-row"><span>Taupunkt</span><span class="val" id="out-dp"></span></div>
                <div class="row" id="out-wind-row"><span>Wind</span><span class="val" id="out-wind"></span></div>
              </div>
              <div class="col" id="col-in">
                <div class="mold-badge" id="mold-badge"><ha-icon icon="mdi:mold"></ha-icon><span id="mold-badge-text"></span></div>
                <div class="col-head"><ha-icon icon="mdi:sofa"></ha-icon> Innen</div>
                <div class="big" id="in-temp"></div>
                <div class="row"><span>Luftfeuchte</span><span class="val" id="in-rh"><ha-icon id="in-trend-icon"></ha-icon><span id="in-rh-text"></span><span class="trend-label" id="in-trend-label"></span></span></div>
                <div class="row"><span>Absolut</span><span class="val" id="in-ah"></span></div>
                <div class="row" id="in-dp-row"><span>Taupunkt</span><span class="val" id="in-dp"></span></div>
                <div class="row"><span>Volumen</span><span class="val" id="in-vol"></span></div>
              </div>
            </div>
            <div class="balance" id="balance">
              <div class="side" id="balance-benefit">
                <div class="label">NUTZEN (Feuchte-Differenz)</div>
                <div class="amount" id="benefit-amount"></div>
              </div>
              <div class="side" id="balance-cost">
                <div class="label">KOSTEN (Temp.-Differenz)</div>
                <div class="amount" id="cost-amount"></div>
              </div>
            </div>
            <div class="banner" id="banner">
              <ha-icon id="banner-icon"></ha-icon>
              <div>
                <div class="headline" id="banner-headline"></div>
                <div class="sub" id="banner-sub"></div>
                <div class="metric" id="banner-metric"></div>
              </div>
            </div>
            <div class="mold-banner" id="mold-banner">
              <ha-icon icon="mdi:mold" id="mold-banner-icon"></ha-icon>
              <div class="txt"><b id="mold-banner-headline"></b><span id="mold-banner-sub"></span></div>
            </div>
            <div class="estimate-note" id="estimate-note"></div>
          </div>
        </ha-card>`;
      this.content = {
        title: this.querySelector('#card-title'),
        placeholder: this.querySelector('#placeholder'),
        cols: this.querySelector('#cols'),
        outTemp: this.querySelector('#out-temp'), outRhText: this.querySelector('#out-rh-text'),
        outTrendIcon: this.querySelector('#out-trend-icon'), outTrendLabel: this.querySelector('#out-trend-label'),
        outAh: this.querySelector('#out-ah'), outDp: this.querySelector('#out-dp'), outDpRow: this.querySelector('#out-dp-row'),
        outWind: this.querySelector('#out-wind'), outWindRow: this.querySelector('#out-wind-row'),
        inTemp: this.querySelector('#in-temp'), inRhText: this.querySelector('#in-rh-text'),
        inTrendIcon: this.querySelector('#in-trend-icon'), inTrendLabel: this.querySelector('#in-trend-label'),
        inAh: this.querySelector('#in-ah'), inDp: this.querySelector('#in-dp'), inDpRow: this.querySelector('#in-dp-row'),
        inVol: this.querySelector('#in-vol'),
        balance: this.querySelector('#balance'),
        banner: this.querySelector('#banner'), bannerIcon: this.querySelector('#banner-icon'),
        bannerHeadline: this.querySelector('#banner-headline'), bannerSub: this.querySelector('#banner-sub'),
        bannerMetric: this.querySelector('#banner-metric'), estimateNote: this.querySelector('#estimate-note'),
        balanceBenefit: this.querySelector('#balance-benefit'), balanceCost: this.querySelector('#balance-cost'),
        benefitAmount: this.querySelector('#benefit-amount'), costAmount: this.querySelector('#cost-amount'),
        moldBadge: this.querySelector('#mold-badge'), moldBadgeText: this.querySelector('#mold-badge-text'),
        moldBanner: this.querySelector('#mold-banner'), moldBannerIcon: this.querySelector('#mold-banner-icon'),
        moldBannerHeadline: this.querySelector('#mold-banner-headline'), moldBannerSub: this.querySelector('#mold-banner-sub'),
      };
      this._applyToggles();
    }

    if (!hasRequired) {
      this.content.placeholder.style.display = 'block';
      this.content.cols.style.display = 'none';
      this.content.balance.style.display = 'none';
      this.content.banner.style.display = 'none';
      this.content.moldBanner.style.display = 'none';
      return;
    }
    this.content.placeholder.style.display = 'none';
    this.content.banner.style.display = 'flex';
    this._applyToggles();

    if ([tOut, rhOut, tIn, rhIn].some((v) => v === null || isNaN(v))) return;

    const ahOut = this._absHum(tOut, rhOut), ahIn = this._absHum(tIn, rhIn);
    const dpOut = this._dewPoint(tOut, rhOut), dpIn = this._dewPoint(tIn, rhIn);
    const diff = ahIn - ahOut;
    const tempDiff = tIn - tOut;
    const waterGrams = Math.abs(diff) * this.config.room_volume_m3;
    const heatLossWh = 0.34 * this.config.room_volume_m3 * Math.abs(tempDiff);
    const heatLossText = this.config.show_heat_loss ? ` · ca. ${heatLossWh.toFixed(0)} Wh Wärmeverlust` : '';
    const whPerGram = waterGrams > 0.1 ? heatLossWh / waterGrams : Infinity;

    const trendOut = this.config.show_trend ? this._trend(this._histOut, rhOut) : { icon: 'mdi:trending-neutral', label: '' };
    const trendIn = this.config.show_trend ? this._trend(this._histIn, rhIn) : { icon: 'mdi:trending-neutral', label: '' };

    this.content.outTemp.textContent = tOut.toFixed(1) + '°C';
    this.content.outRhText.textContent = rhOut.toFixed(0) + '% ';
    this.content.outTrendIcon.setAttribute('icon', trendOut.icon);
    this.content.outTrendLabel.textContent = trendOut.label;
    this.content.outAh.textContent = ahOut.toFixed(1) + ' g/m³';
    this.content.outDp.textContent = dpOut.toFixed(1) + '°C';
    this.content.outWind.textContent = (wind !== null && !isNaN(wind)) ? wind.toFixed(1) + ' km/h' : '–';
    this.content.inTemp.textContent = tIn.toFixed(1) + '°C';
    this.content.inRhText.textContent = rhIn.toFixed(0) + '% ';
    this.content.inTrendIcon.setAttribute('icon', trendIn.icon);
    this.content.inTrendLabel.textContent = trendIn.label;
    this.content.inAh.textContent = ahIn.toFixed(1) + ' g/m³';
    this.content.inDp.textContent = dpIn.toFixed(1) + '°C';
    this.content.inVol.textContent = this.config.room_volume_m3 + ' m³';

    if (this.config.show_mold_warning && rhIn > 70) {
      this.content.moldBadge.style.display = 'flex';
      this.content.moldBadge.style.background = 'rgba(229,57,53,0.25)';
      this.content.moldBadge.style.color = '#e53935';
      this.content.moldBadgeText.textContent = 'Hoch';
      this.content.moldBanner.style.display = 'flex';
      this.content.moldBanner.style.background = 'rgba(229,57,53,0.15)';
      this.content.moldBannerIcon.setAttribute('icon', 'mdi:mold');
      this.content.moldBannerHeadline.textContent = '🍄 Schimmelgefahr: Hoch';
      this.content.moldBannerSub.textContent = `Raumluftfeuchte aktuell ${rhIn.toFixed(0)}% – über 70% steigt das Risiko deutlich, besonders an kalten Außenwänden/Ecken. Unabhängig von der Lüftungsempfehlung oben: möglichst bald lüften und ggf. Heizung leicht erhöhen.`;
    } else if (this.config.show_mold_warning && rhIn > 60) {
      this.content.moldBadge.style.display = 'flex';
      this.content.moldBadge.style.background = 'rgba(255,152,0,0.25)';
      this.content.moldBadge.style.color = '#ff9800';
      this.content.moldBadgeText.textContent = 'Erhöht';
      this.content.moldBanner.style.display = 'flex';
      this.content.moldBanner.style.background = 'rgba(255,152,0,0.12)';
      this.content.moldBannerIcon.setAttribute('icon', 'mdi:mold');
      this.content.moldBannerHeadline.textContent = '🍄 Schimmelgefahr: Erhöht';
      this.content.moldBannerSub.textContent = `Raumluftfeuchte aktuell ${rhIn.toFixed(0)}% – Richtwert für Wohnräume ist 40–60%. Im Auge behalten, noch kein akutes Risiko.`;
    } else {
      this.content.moldBadge.style.display = 'none';
      this.content.moldBanner.style.display = 'none';
    }

    this.content.benefitAmount.textContent = (diff > 0 ? '+' : '') + diff.toFixed(1) + ' g/m³';
    this.content.costAmount.textContent = tempDiff.toFixed(1) + ' °C';
    const benefitLevel = diff > 2 ? 'rgba(76,175,80,0.25)' : diff > 0.5 ? 'rgba(76,175,80,0.12)' : 'rgba(127,127,127,0.1)';
    const costLevel = tempDiff > 15 ? 'rgba(229,57,53,0.22)' : tempDiff > 5 ? 'rgba(255,152,0,0.15)' : 'rgba(127,127,127,0.1)';
    this.content.balanceBenefit.style.background = benefitLevel;
    this.content.balanceCost.style.background = costLevel;

    const windActive = this.config.show_wind && wind !== null && !isNaN(wind);
    const windFast = windActive && wind > 10;
    const windNote = windFast ? ` (${wind.toFixed(0)} km/h Wind bereits eingerechnet)` : '';

    let icon, color, headline, sub, metric;
    if (diff <= -0.5) {
      icon = 'mdi:window-closed-variant';
      color = 'rgba(229,57,53,0.18)';
      headline = '❌ Nicht lüften';
      sub = `Draußen ${Math.abs(diff).toFixed(1)} g/m³ feuchter – würde die Raumluft zusätzlich befeuchten. Das gilt unabhängig von der Temperatur.`;
      metric = `Bei vollem Luftaustausch: ca. ${waterGrams.toFixed(0)} g Wasser würden zusätzlich reinkommen`;
    } else if (diff > -0.5 && diff <= 0.5) {
      icon = 'mdi:minus-circle-outline';
      color = 'rgba(127,127,127,0.18)';
      headline = '➖ Kein großer Unterschied';
      sub = 'Feuchtigkeit drinnen/draußen ist ähnlich – Lüften bringt aktuell wenig, unabhängig von der Temperaturkosten-Frage.';
      metric = '';
    } else if (whPerGram > 4) {
      icon = 'mdi:scale-balance';
      color = 'rgba(255,152,0,0.20)';
      headline = '⚖️ Abwägen – lohnt sich kaum';
      sub = `${diff.toFixed(1)} g/m³ Nutzen kosten hier ca. ${whPerGram.toFixed(1)} Wh pro Gramm entferntem Wasser – vergleichsweise teuer erkauft. Nur lüften, falls es wirklich nötig ist (z.B. Geruch), sonst eher warten.`;
      metric = `Nutzen: ca. ${waterGrams.toFixed(0)} g Wasser raus${heatLossText}`;
    } else {
      icon = 'mdi:window-open-variant';
      color = 'rgba(76,175,80,0.18)';
      headline = '✅ Lüften empfohlen';
      const minutes = this._ventDurationMinutes(Math.abs(tempDiff), windActive ? wind : null);
      sub = `Draußen ${diff.toFixed(1)} g/m³ trockener – ca. ${minutes.toFixed(0)} Min. stoßlüften${windNote}.`;
      metric = `Bei vollem Luftaustausch: ca. ${waterGrams.toFixed(0)} g Wasser raus${heatLossText} (Volumen ${this.config.room_volume_m3} m³)`;
    }
    this.content.banner.style.background = color;
    this.content.bannerIcon.setAttribute('icon', icon);
    this.content.bannerHeadline.textContent = headline;
    this.content.bannerSub.textContent = sub;
    this.content.bannerMetric.textContent = metric;
  }
  getCardSize() {
    let size = 2;
    if (this.config && this.config.show_columns) size += 2;
    if (this.config && this.config.show_balance) size += 1;
    return size;
  }
}

/**
 * Visueller GUI-Editor für BlushLueftungCard (nutzt das native ha-form
 * Element, wie es die meisten Lovelace-Karten fuer ihre Editoren nutzen).
 */
class BlushLueftungCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...BlushLueftungCard.getStubConfig(), ...config };
  }
  get _schema() {
    return [
      { name: 'name', selector: { text: {} } },
      { name: 'temp_out', required: true, selector: { entity: { domain: 'sensor', device_class: 'temperature' } } },
      { name: 'hum_out', required: true, selector: { entity: { domain: 'sensor', device_class: 'humidity' } } },
      { name: 'temp_in', required: true, selector: { entity: { domain: 'sensor', device_class: 'temperature' } } },
      { name: 'hum_in', required: true, selector: { entity: { domain: 'sensor', device_class: 'humidity' } } },
      { name: 'wind', selector: { entity: { domain: 'sensor' } } },
      { name: 'room_volume_m3', selector: { number: { min: 1, max: 2000, step: 1, mode: 'box', unit_of_measurement: 'm³' } } },
      { name: 'room_volume_is_estimate', selector: { boolean: {} } },
      { type: 'grid', name: '', schema: [
        { name: 'show_columns', selector: { boolean: {} } },
        { name: 'show_balance', selector: { boolean: {} } },
        { name: 'show_dewpoint', selector: { boolean: {} } },
        { name: 'show_wind', selector: { boolean: {} } },
        { name: 'show_trend', selector: { boolean: {} } },
        { name: 'show_heat_loss', selector: { boolean: {} } },
        { name: 'show_mold_warning', selector: { boolean: {} } },
      ]},
    ];
  }
  _computeLabel(schemaItem) {
    const labels = {
      name: 'Raumname (z.B. "Schlafzimmer")',
      temp_out: 'Außentemperatur-Sensor',
      hum_out: 'Außen-Luftfeuchte-Sensor',
      temp_in: 'Innentemperatur-Sensor',
      hum_in: 'Innen-Luftfeuchte-Sensor',
      wind: 'Windgeschwindigkeit-Sensor (optional, leer = keine Windkorrektur)',
      room_volume_m3: 'Raumvolumen',
      room_volume_is_estimate: 'Volumen ist nur geschätzt',
      show_columns: 'Innen/Außen-Kästen anzeigen',
      show_balance: 'Nutzen/Kosten-Kacheln anzeigen',
      show_dewpoint: 'Taupunkt anzeigen',
      show_wind: 'Windgeschwindigkeit anzeigen',
      show_trend: 'Feuchte-Trendpfeil anzeigen',
      show_heat_loss: 'Wärmeverlust (Wh) anzeigen',
      show_mold_warning: 'Schimmel-Warnung anzeigen',
    };
    return labels[schemaItem.name] || schemaItem.name;
  }
  set hass(hass) {
    this._hass = hass;
    if (!this._form) {
      this._form = document.createElement('ha-form');
      this._form.addEventListener('value-changed', (ev) => {
        ev.stopPropagation();
        this._config = ev.detail.value;
        this.dispatchEvent(new CustomEvent('config-changed', {
          detail: { config: this._config },
          bubbles: true,
          composed: true,
        }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = hass;
    this._form.schema = this._schema;
    this._form.data = this._config;
    this._form.computeLabel = this._computeLabel;
  }
}

customElements.define('blush-lueftung-card', BlushLueftungCard);
customElements.define('blush-lueftung-card-editor', BlushLueftungCardEditor);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'blush-lueftung-card',
  name: 'Blush Lüftungsempfehlung',
  description: 'Kosten-Nutzen-Abwägung Innen-/Außenluft mit stetiger Dauer-Formel und Wh/g-Verhältnis. Alle Sensoren echt optional ohne versteckten Fallback. Fast jeder Baustein einzeln ein-/ausschaltbar. Mit visuellem GUI-Editor.',
});
