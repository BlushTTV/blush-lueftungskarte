/**
 * Blush Lüftungsempfehlung Card
 * Vergleicht Innen-/Außenluft (absolute Feuchte, Taupunkt) und gibt eine
 * Kosten-Nutzen-Lüftungsempfehlung. Fast jeder Baustein einzeln ein-/ausschaltbar.
 *
 * Algorithmus:
 * 1. Außenluft feuchter (abs.) -> Nicht lüften
 * 2. Innen-rF <= Zielwert -> Kein Lüftbedarf
 * 3. Kaum Unterschied -> neutral
 * 4. Wh pro Gramm zu hoch -> Abwägen
 * 5. Sonst Lüften empfohlen; Dauer skaliert mit dem Anteil bis zum Zielwert.
 *
 * Optional: Fensterkontakt(e)
 * - Fenster offen: Countdown bis zur empfohlenen Dauer, "Jetzt schließen", Warnung bei zu langem Lüften
 * - Nach dem Schließen: "Zuletzt gelüftet vor X (Y lang)" (aus dem HA-Verlauf) und eine
 *   Nachlaufzeit, in der keine neue Lüftempfehlung kommt (Feuchte steigt nach dem Lüften kurz wieder an).
 *
 * Bekannte Grenzen: kein Frische-Check der Sensoren; Kontakt unterscheidet nicht gekippt/ganz offen.
 */
class BlushLueftungCard extends HTMLElement {
  static getConfigElement() { return document.createElement('blush-lueftung-card-editor'); }
  static getStubConfig() {
    return {
      name: '', temp_out: '', hum_out: '', temp_in: '', hum_in: '',
      window: [], cooldown_minutes: 30,
      room_volume_m3: 50, room_volume_is_estimate: true,
      target_humidity: 55, min_humidity: 40,
      show_columns: true, show_dewpoint: true, show_trend: true,
      show_balance: true, show_heat_loss: true, show_mold_warning: true,
    };
  }
  setConfig(config) {
    const win = Array.isArray(config.window) ? config.window.filter(Boolean) : (config.window ? [config.window] : []);
    this.config = {
      name: config.name || '',
      temp_out: config.temp_out || '', hum_out: config.hum_out || '',
      temp_in: config.temp_in || '', hum_in: config.hum_in || '',
      window: win,
      cooldown_minutes: Math.min(180, Math.max(0, config.cooldown_minutes ?? 30)),
      room_volume_m3: Math.max(1, config.room_volume_m3 || 50),
      room_volume_is_estimate: config.room_volume_is_estimate !== false,
      target_humidity: Math.min(80, Math.max(30, config.target_humidity || 55)),
      min_humidity: Math.min(60, Math.max(20, config.min_humidity || 40)),
      show_columns: config.show_columns !== false,
      show_dewpoint: config.show_dewpoint !== false,
      show_trend: config.show_trend !== false,
      show_balance: config.show_balance !== false,
      show_heat_loss: config.show_heat_loss !== false,
      show_mold_warning: config.show_mold_warning !== false,
    };
    this._histOut = this._histOut || [];
    this._histIn = this._histIn || [];
    if (this.content) this._applyToggles();
  }
  connectedCallback() {
    this._timer = setInterval(() => { if (this._hass) this.hass = this._hass; }, 30000);
  }
  disconnectedCallback() { clearInterval(this._timer); }
  _applyToggles() {
    if (!this.content) return;
    const c = this.config;
    this.content.title.textContent = 'Lüftungsempfehlung' + (c.name ? ' – ' + c.name : '');
    this.content.cols.style.display = c.show_columns ? 'flex' : 'none';
    this.content.balance.style.display = c.show_balance ? 'flex' : 'none';
    this.content.outDpRow.style.display = c.show_dewpoint ? 'flex' : 'none';
    this.content.inDpRow.style.display = c.show_dewpoint ? 'flex' : 'none';
    this.content.inWinRow.style.display = c.window.length ? 'flex' : 'none';
    ['outTrendIcon', 'outTrendLabel', 'inTrendIcon', 'inTrendLabel'].forEach((k) => {
      this.content[k].style.display = c.show_trend ? '' : 'none';
    });
    this.content.inVol.textContent = c.room_volume_m3 + ' m³';
    const trendNote = c.show_trend ? 'Trend bezieht sich auf die letzten 20 Min. seit Laden der Seite' : '';
    this.content.estimateNote.textContent = c.room_volume_is_estimate
      ? '⚠︎ Raumvolumen geschätzt – bitte nachmessen und anpassen' + (trendNote ? ' · ' + trendNote : '')
      : (trendNote ? '· ' + trendNote : '');
  }
  _svp(t) { return 6.112 * Math.exp((17.62 * t) / (243.12 + t)); }
  _absHum(t, rh) { return 216.7 * ((rh / 100) * this._svp(t)) / (t + 273.15); }
  _dewPoint(t, rh) {
    const a = 17.62, b = 243.12;
    const gamma = Math.log(rh / 100) + (a * t) / (b + t);
    return (b * gamma) / (a - gamma);
  }
  _fmtMin(min) {
    const m = Math.max(0, Math.round(min));
    if (m < 60) return `${m} Min.`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h} Std. ${r} Min.` : `${h} Std.`;
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
  _ventDurationMinutes(tempDiffAbs, fraction) {
    // Stoßlüften: Luftaustausch durch thermischen Auftrieb, wächst mit ~√ΔT
    const base = 18 / Math.sqrt(Math.max(tempDiffAbs, 0.5));
    // Nur so lange wie nötig, um den Zielwert zu erreichen
    const needFactor = Math.max(0.35, Math.min(1, fraction));
    return Math.min(25, Math.max(3, base * needFactor));
  }
  async _fetchLastVent(entityId, closedAt) {
    this._lastVentKey = closedAt;
    try {
      const res = await this._hass.callWS({
        type: 'history/history_during_period',
        start_time: new Date(closedAt - 24 * 3600 * 1000).toISOString(),
        end_time: new Date(closedAt + 1000).toISOString(),
        entity_ids: [entityId],
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      const arr = (res && res[entityId]) || [];
      const ts = (e) => {
        const v = e.lc ?? e.lu ?? e.last_changed ?? e.last_updated;
        return typeof v === 'number' ? v * 1000 : Date.parse(v);
      };
      const st = (e) => e.s ?? e.state;
      let openedAt = null;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (st(arr[i]) === 'on') { openedAt = ts(arr[i]); break; }
      }
      this._lastVent = (openedAt && openedAt < closedAt) ? { openedAt, closedAt } : null;
    } catch (e) {
      this._lastVent = null;
    }
    if (this._hass) this.hass = this._hass;
  }
  set hass(hass) {
    this._hass = hass;
    const c = this.config;
    const g = (id) => { const s = id && hass.states[id]; return s ? parseFloat(s.state) : null; };
    const hasRequired = c.temp_out && c.hum_out && c.temp_in && c.hum_in;
    const tOut = g(c.temp_out), rhOut = g(c.hum_out);
    const tIn = g(c.temp_in), rhIn = g(c.hum_in);

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
            .banner .metric { font-size:0.82em; opacity:0.7; line-height:1.4; }
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
              <div class="col">
                <div class="col-head"><ha-icon icon="mdi:tree"></ha-icon> Draußen</div>
                <div class="big" id="out-temp"></div>
                <div class="row"><span>Luftfeuchte</span><span class="val"><ha-icon id="out-trend-icon"></ha-icon><span id="out-rh-text"></span><span class="trend-label" id="out-trend-label"></span></span></div>
                <div class="row"><span>Absolut</span><span class="val" id="out-ah"></span></div>
                <div class="row" id="out-dp-row"><span>Taupunkt</span><span class="val" id="out-dp"></span></div>
              </div>
              <div class="col">
                <div class="mold-badge" id="mold-badge"><ha-icon icon="mdi:mold"></ha-icon><span id="mold-badge-text"></span></div>
                <div class="col-head"><ha-icon icon="mdi:sofa"></ha-icon> Innen</div>
                <div class="big" id="in-temp"></div>
                <div class="row"><span>Luftfeuchte</span><span class="val"><ha-icon id="in-trend-icon"></ha-icon><span id="in-rh-text"></span><span class="trend-label" id="in-trend-label"></span></span></div>
                <div class="row"><span>Absolut</span><span class="val" id="in-ah"></span></div>
                <div class="row" id="in-dp-row"><span>Taupunkt</span><span class="val" id="in-dp"></span></div>
                <div class="row"><span>Volumen</span><span class="val" id="in-vol"></span></div>
                <div class="row" id="in-win-row"><span>Fenster</span><span class="val"><ha-icon id="in-win-icon"></ha-icon><span id="in-win"></span></span></div>
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
              <ha-icon icon="mdi:mold"></ha-icon>
              <div class="txt"><b id="mold-banner-headline"></b><span id="mold-banner-sub"></span></div>
            </div>
            <div class="estimate-note" id="estimate-note"></div>
          </div>
        </ha-card>`;
      const q = (s) => this.querySelector(s);
      this.content = {
        title: q('#card-title'), placeholder: q('#placeholder'), cols: q('#cols'),
        outTemp: q('#out-temp'), outRhText: q('#out-rh-text'), outTrendIcon: q('#out-trend-icon'), outTrendLabel: q('#out-trend-label'),
        outAh: q('#out-ah'), outDp: q('#out-dp'), outDpRow: q('#out-dp-row'),
        inTemp: q('#in-temp'), inRhText: q('#in-rh-text'), inTrendIcon: q('#in-trend-icon'), inTrendLabel: q('#in-trend-label'),
        inAh: q('#in-ah'), inDp: q('#in-dp'), inDpRow: q('#in-dp-row'), inVol: q('#in-vol'),
        inWinRow: q('#in-win-row'), inWin: q('#in-win'), inWinIcon: q('#in-win-icon'),
        balance: q('#balance'), balanceBenefit: q('#balance-benefit'), balanceCost: q('#balance-cost'),
        benefitAmount: q('#benefit-amount'), costAmount: q('#cost-amount'),
        banner: q('#banner'), bannerIcon: q('#banner-icon'), bannerHeadline: q('#banner-headline'),
        bannerSub: q('#banner-sub'), bannerMetric: q('#banner-metric'), estimateNote: q('#estimate-note'),
        moldBadge: q('#mold-badge'), moldBadgeText: q('#mold-badge-text'),
        moldBanner: q('#mold-banner'), moldBannerHeadline: q('#mold-banner-headline'), moldBannerSub: q('#mold-banner-sub'),
      };
      this._applyToggles();
    }

    if (!hasRequired) {
      this.content.placeholder.style.display = 'block';
      ['cols', 'balance', 'banner', 'moldBanner'].forEach((k) => { this.content[k].style.display = 'none'; });
      return;
    }
    this.content.placeholder.style.display = 'none';
    this.content.banner.style.display = 'flex';
    this._applyToggles();

    if ([tOut, rhOut, tIn, rhIn].some((v) => v === null || isNaN(v))) return;

    const V = c.room_volume_m3;
    const ahOut = this._absHum(tOut, rhOut), ahIn = this._absHum(tIn, rhIn);
    const dpOut = this._dewPoint(tOut, rhOut), dpIn = this._dewPoint(tIn, rhIn);
    const diff = ahIn - ahOut;
    const tempDiff = tIn - tOut;
    const ahSatIn = this._absHum(tIn, 100);
    const rhAfter = Math.max(0, Math.min(100, (ahOut / ahSatIn) * 100));
    const ahTarget = this._absHum(tIn, c.target_humidity);
    const excessGrams = Math.max(0, ahIn - ahTarget) * V;
    const fraction = diff > 0 ? Math.max(0, (ahIn - ahTarget) / diff) : 0;
    const waterGrams = Math.abs(diff) * V;
    const heatLossWh = 0.34 * V * Math.abs(tempDiff);
    const heatLossText = c.show_heat_loss ? ` · ca. ${heatLossWh.toFixed(0)} Wh Wärmeverlust bei vollem Austausch` : '';
    const whPerGram = (diff > 0 && excessGrams > 0.1) ? heatLossWh / waterGrams : Infinity;

    const noTrend = { icon: 'mdi:trending-neutral', label: '' };
    const trendOut = c.show_trend ? this._trend(this._histOut, rhOut) : noTrend;
    const trendIn = c.show_trend ? this._trend(this._histIn, rhIn) : noTrend;

    const ct = this.content;
    ct.outTemp.textContent = tOut.toFixed(1) + '°C';
    ct.outRhText.textContent = rhOut.toFixed(0) + '% ';
    ct.outTrendIcon.setAttribute('icon', trendOut.icon);
    ct.outTrendLabel.textContent = trendOut.label;
    ct.outAh.textContent = ahOut.toFixed(1) + ' g/m³';
    ct.outDp.textContent = dpOut.toFixed(1) + '°C';
    ct.inTemp.textContent = tIn.toFixed(1) + '°C';
    ct.inRhText.textContent = rhIn.toFixed(0) + '% ';
    ct.inTrendIcon.setAttribute('icon', trendIn.icon);
    ct.inTrendLabel.textContent = trendIn.label;
    ct.inAh.textContent = ahIn.toFixed(1) + ' g/m³';
    ct.inDp.textContent = dpIn.toFixed(1) + '°C';

    if (c.show_mold_warning && rhIn > 60) {
      const high = rhIn > 70;
      ct.moldBadge.style.display = 'flex';
      ct.moldBadge.style.background = high ? 'rgba(229,57,53,0.25)' : 'rgba(255,152,0,0.25)';
      ct.moldBadge.style.color = high ? '#e53935' : '#ff9800';
      ct.moldBadgeText.textContent = high ? 'Hoch' : 'Erhöht';
      ct.moldBanner.style.display = 'flex';
      ct.moldBanner.style.background = high ? 'rgba(229,57,53,0.15)' : 'rgba(255,152,0,0.12)';
      ct.moldBannerHeadline.textContent = high ? '🍄 Schimmelgefahr: Hoch' : '🍄 Schimmelgefahr: Erhöht';
      ct.moldBannerSub.textContent = high
        ? `Raumluftfeuchte aktuell ${rhIn.toFixed(0)}% – über 70% steigt das Risiko deutlich, besonders an kalten Außenwänden/Ecken.`
        : `Raumluftfeuchte aktuell ${rhIn.toFixed(0)}% – Richtwert für Wohnräume ist 40–60%. Im Auge behalten.`;
    } else {
      ct.moldBadge.style.display = 'none';
      ct.moldBanner.style.display = 'none';
    }

    ct.benefitAmount.textContent = (diff > 0 ? '+' : '') + diff.toFixed(1) + ' g/m³';
    ct.costAmount.textContent = tempDiff.toFixed(1) + ' °C';
    ct.balanceBenefit.style.background = diff > 2 ? 'rgba(76,175,80,0.25)' : diff > 0.5 ? 'rgba(76,175,80,0.12)' : 'rgba(127,127,127,0.1)';
    ct.balanceCost.style.background = tempDiff > 15 ? 'rgba(229,57,53,0.22)' : tempDiff > 5 ? 'rgba(255,152,0,0.15)' : 'rgba(127,127,127,0.1)';

    const afterText = `Nach vollem Luftaustausch ca. ${rhAfter.toFixed(0)}% rF innen`;
    const tooDryNote = rhAfter < c.min_humidity ? ` – unter ${c.min_humidity}%, also nicht zu lange lüften` : '';
    const minutesNow = this._ventDurationMinutes(Math.abs(tempDiff), fraction);

    let icon, color, headline, sub, metric, needsVent = false;
    if (diff <= -0.5) {
      icon = 'mdi:window-closed-variant';
      color = 'rgba(229,57,53,0.18)';
      headline = '❌ Nicht lüften';
      sub = `Draußen ${Math.abs(diff).toFixed(1)} g/m³ feuchter – Lüften würde die Raumluft zusätzlich befeuchten.`;
      metric = `${afterText}. Bei vollem Luftaustausch kämen ca. ${waterGrams.toFixed(0)} g Wasser rein.`;
    } else if (rhIn <= c.target_humidity) {
      icon = 'mdi:check-circle-outline';
      color = 'rgba(33,150,243,0.15)';
      headline = '👍 Kein Lüftbedarf';
      sub = `Innen ${rhIn.toFixed(0)}% rF – bereits unter dem Zielwert von ${c.target_humidity}%. Wegen der Feuchte musst du nicht lüften, es würde nur Wärme kosten. Für frische Luft reicht kurzes Stoßlüften.`;
      metric = `${afterText}${tooDryNote}.${c.show_heat_loss ? ` Voller Austausch würde ca. ${heatLossWh.toFixed(0)} Wh kosten.` : ''}`;
    } else if (diff <= 0.5) {
      icon = 'mdi:minus-circle-outline';
      color = 'rgba(127,127,127,0.18)';
      headline = '➖ Lüften bringt kaum etwas';
      sub = `Innen ${rhIn.toFixed(0)}% rF liegt über dem Zielwert, aber die Außenluft ist kaum trockener. Lüften senkt die Feuchte aktuell kaum.`;
      metric = afterText + '.';
      needsVent = true;
    } else if (whPerGram > 4) {
      icon = 'mdi:scale-balance';
      color = 'rgba(255,152,0,0.20)';
      headline = '⚖️ Abwägen – lohnt sich kaum';
      sub = `Um auf ${c.target_humidity}% zu kommen, kostet jedes entfernte Gramm Wasser ca. ${whPerGram.toFixed(1)} Wh Wärme. Nur lüften, wenn es wirklich nötig ist.`;
      metric = `Bis Zielwert ca. ${excessGrams.toFixed(0)} g Wasser raus · ${afterText}${tooDryNote}.`;
      needsVent = true;
    } else {
      icon = 'mdi:window-open-variant';
      color = 'rgba(76,175,80,0.18)';
      headline = '✅ Lüften empfohlen';
      sub = `Innen ${rhIn.toFixed(0)}% rF, Ziel ${c.target_humidity}%. Draußen ${diff.toFixed(1)} g/m³ trockener – ca. ${minutesNow.toFixed(0)} Min. stoßlüften.`;
      metric = `Bis Zielwert ca. ${excessGrams.toFixed(0)} g Wasser raus${heatLossText} · ${afterText}${tooDryNote}.`;
      needsVent = true;
    }

    if (c.window.length) {
      const states = c.window.map((id) => hass.states[id]).filter(Boolean);
      const openStates = states.filter((s) => s.state === 'on');
      const now = Date.now();
      if (!states.length) {
        ct.inWin.textContent = 'unbekannt';
        ct.inWinIcon.setAttribute('icon', 'mdi:help-circle-outline');
      } else if (openStates.length) {
        const openedAt = Math.min(...openStates.map((s) => Date.parse(s.last_changed)));
        const openMin = (now - openedAt) / 60000;
        if (!this._ventPlan || this._ventPlan.key !== openedAt) {
          this._ventPlan = { key: openedAt, planned: Math.round(minutesNow), needed: needsVent };
        }
        const planned = this._ventPlan.planned;
        ct.inWin.textContent = `offen · ${this._fmtMin(openMin)}`;
        ct.inWinIcon.setAttribute('icon', 'mdi:window-open-variant');
        metric = `Geöffnet seit ${this._fmtMin(openMin)} · ${afterText}`;

        if (diff <= -0.5) {
          icon = 'mdi:window-open-variant';
          color = 'rgba(229,57,53,0.22)';
          headline = '🪟 Fenster offen – besser schließen';
          sub = `Draußen ist die Luft feuchter als drinnen. Offenes Fenster erhöht die Raumfeuchte.`;
        } else if (Math.abs(tempDiff) < 5) {
          icon = 'mdi:window-open-variant';
          color = 'rgba(76,175,80,0.15)';
          headline = `🪟 Fenster offen seit ${this._fmtMin(openMin)}`;
          sub = 'Kaum Temperaturunterschied – offen lassen kostet kaum Heizenergie.';
        } else if (this._ventPlan.needed && rhIn <= c.target_humidity) {
          icon = 'mdi:check-circle-outline';
          color = 'rgba(76,175,80,0.22)';
          headline = '✅ Ziel erreicht – Fenster schließen';
          sub = `Luftfeuchte innen ist auf ${rhIn.toFixed(0)}% gesunken (Ziel ${c.target_humidity}%).`;
        } else if (openMin < planned) {
          icon = 'mdi:timer-outline';
          color = 'rgba(76,175,80,0.18)';
          headline = `🪟 Lüften läuft – noch ca. ${this._fmtMin(Math.ceil(planned - openMin))}`;
          sub = `Empfohlen waren ca. ${planned} Min. stoßlüften.`;
        } else if (openMin < planned * 2 + 5) {
          icon = 'mdi:window-closed-variant';
          color = 'rgba(255,152,0,0.22)';
          headline = '⏰ Jetzt Fenster schließen';
          sub = `Offen seit ${this._fmtMin(openMin)}, empfohlen waren ca. ${planned} Min. Länger lüften bringt kaum noch etwas.`;
        } else {
          icon = 'mdi:alert-outline';
          color = 'rgba(229,57,53,0.22)';
          headline = '⚠️ Fenster zu lange offen';
          sub = `Seit ${this._fmtMin(openMin)} offen (empfohlen ca. ${planned} Min.). Wände und Möbel kühlen aus, das kostet unnötig Heizenergie.`;
        }
      } else {
        this._ventPlan = null;
        const latest = states.reduce((a, b) => (Date.parse(a.last_changed) >= Date.parse(b.last_changed) ? a : b));
        const closedAt = Date.parse(latest.last_changed);
        const sinceClose = (now - closedAt) / 60000;
        if (this._lastVentKey !== closedAt) this._fetchLastVent(latest.entity_id, closedAt);
        const lv = (this._lastVent && this._lastVent.closedAt === closedAt) ? this._lastVent : null;
        const lastText = lv
          ? `Zuletzt gelüftet vor ${this._fmtMin(sinceClose)} (${this._fmtMin((lv.closedAt - lv.openedAt) / 60000)} lang)`
          : `Fenster zu seit ${this._fmtMin(sinceClose)}`;
        ct.inWin.textContent = 'zu';
        ct.inWinIcon.setAttribute('icon', 'mdi:window-closed-variant');

        if (needsVent && sinceClose < c.cooldown_minutes) {
          icon = 'mdi:timer-sand';
          color = 'rgba(33,150,243,0.15)';
          headline = '🕒 Gerade gelüftet';
          sub = `Nach dem Lüften steigt die Luftfeuchte erst noch etwas an, weil Wände und Möbel Feuchtigkeit abgeben. Neue Bewertung in ca. ${this._fmtMin(Math.ceil(c.cooldown_minutes - sinceClose))}.`;
          metric = `${lastText} · aktuell ${rhIn.toFixed(0)}% rF, Ziel ${c.target_humidity}%`;
        } else {
          metric = `${lastText} · ${metric}`;
        }
      }
    }

    ct.banner.style.background = color;
    ct.bannerIcon.setAttribute('icon', icon);
    ct.bannerHeadline.textContent = headline;
    ct.bannerSub.textContent = sub;
    ct.bannerMetric.textContent = metric;
  }
  getCardSize() {
    let size = 2;
    if (this.config && this.config.show_columns) size += 2;
    if (this.config && this.config.show_balance) size += 1;
    return size;
  }
}

class BlushLueftungCardEditor extends HTMLElement {
  setConfig(config) {
    // Veraltete Optionen (Wind, bis v0.2.0) beim Speichern im Editor entfernen
    const { wind, show_wind, ...rest } = config;
    this._config = { ...BlushLueftungCard.getStubConfig(), ...rest };
  }
  get _schema() {
    return [
      { name: 'name', selector: { text: {} } },
      { name: 'temp_out', required: true, selector: { entity: { domain: 'sensor', device_class: 'temperature' } } },
      { name: 'hum_out', required: true, selector: { entity: { domain: 'sensor', device_class: 'humidity' } } },
      { name: 'temp_in', required: true, selector: { entity: { domain: 'sensor', device_class: 'temperature' } } },
      { name: 'hum_in', required: true, selector: { entity: { domain: 'sensor', device_class: 'humidity' } } },
      { name: 'window', selector: { entity: { domain: 'binary_sensor', multiple: true } } },
      { name: 'cooldown_minutes', selector: { number: { min: 0, max: 180, step: 5, mode: 'box', unit_of_measurement: 'Min.' } } },
      { name: 'room_volume_m3', selector: { number: { min: 1, max: 2000, step: 1, mode: 'box', unit_of_measurement: 'm³' } } },
      { name: 'room_volume_is_estimate', selector: { boolean: {} } },
      { type: 'grid', name: '', schema: [
        { name: 'target_humidity', selector: { number: { min: 30, max: 80, step: 1, mode: 'box', unit_of_measurement: '%' } } },
        { name: 'min_humidity', selector: { number: { min: 20, max: 60, step: 1, mode: 'box', unit_of_measurement: '%' } } },
      ]},
      { type: 'grid', name: '', schema: [
        { name: 'show_columns', selector: { boolean: {} } },
        { name: 'show_balance', selector: { boolean: {} } },
        { name: 'show_dewpoint', selector: { boolean: {} } },
        { name: 'show_trend', selector: { boolean: {} } },
        { name: 'show_heat_loss', selector: { boolean: {} } },
        { name: 'show_mold_warning', selector: { boolean: {} } },
      ]},
    ];
  }
  _computeLabel(item) {
    return {
      name: 'Raumname (z.B. "Schlafzimmer")',
      temp_out: 'Außentemperatur-Sensor',
      hum_out: 'Außen-Luftfeuchte-Sensor',
      temp_in: 'Innentemperatur-Sensor',
      hum_in: 'Innen-Luftfeuchte-Sensor',
      window: 'Fensterkontakt(e) (optional, mehrere möglich)',
      cooldown_minutes: 'Nachlaufzeit nach dem Lüften (nur mit Fensterkontakt)',
      room_volume_m3: 'Raumvolumen',
      room_volume_is_estimate: 'Volumen ist nur geschätzt',
      target_humidity: 'Ziel-Luftfeuchte (ab hier Lüftbedarf)',
      min_humidity: 'Untergrenze (Warnung "zu trocken")',
      show_columns: 'Innen/Außen-Kästen anzeigen',
      show_balance: 'Nutzen/Kosten-Kacheln anzeigen',
      show_dewpoint: 'Taupunkt anzeigen',
      show_trend: 'Feuchte-Trendpfeil anzeigen',
      show_heat_loss: 'Wärmeverlust (Wh) anzeigen',
      show_mold_warning: 'Schimmel-Warnung anzeigen',
    }[item.name] || item.name;
  }
  set hass(hass) {
    this._hass = hass;
    if (!this._form) {
      this._form = document.createElement('ha-form');
      this._form.addEventListener('value-changed', (ev) => {
        ev.stopPropagation();
        this._config = ev.detail.value;
        this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
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
  description: 'Lüftungsempfehlung mit Zielwert und optionalem Fensterkontakt (Countdown, "Jetzt schließen", Nachlaufzeit): absolute Feuchte, Taupunkt, Wärmeverlust, Schimmel-Warnung. Mit GUI-Editor.',
});
