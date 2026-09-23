# 🌬️ Blush Lüftungsempfehlung

Eine Custom Lovelace Card für [Home Assistant](https://www.home-assistant.io/), die anhand von Innen- und Außensensoren eine **fundierte Lüftungsempfehlung** gibt — nicht nur "feucht/trocken", sondern eine echte Kosten-Nutzen-Abwägung.

## Warum diese Karte?

Die reine relative Luftfeuchtigkeit (%) ist beim Lüften irreführend, weil sie stark von der Temperatur abhängt: kalte Luft mit 94 % rF trägt trotzdem viel weniger Wasser als warme Luft mit 47 % rF. Diese Karte rechnet stattdessen mit der **absoluten Luftfeuchtigkeit** (g/m³) und dem **Taupunkt** — den physikalisch korrekten Größen — und wägt zusätzlich den **Wärmeverlust** gegen den **Feuchtigkeitsnutzen** ab.

## Features

- ✅ / ❌ / ➖ / ⚖️ — vier klare Empfehlungs-Zustände statt nur Ja/Nein
- Absolute Luftfeuchtigkeit (g/m³) und Taupunkt, innen und außen
- Konkrete Wassermenge (g), die ein voller Luftaustausch entfernt/hinzufügt
- Geschätzter Wärmeverlust (Wh) pro Luftaustausch
- Stetige Lüftungsdauer-Formel (Stack-Effekt-Näherung), durch Windgeschwindigkeit korrigiert
- Kosten-Nutzen-Verhältnis (Wh pro Gramm entferntem Wasser) statt starrer Schwellenwerte
- Unabhängige Schimmel-Warnung (Richtwert 60 %/70 % relative Raumluftfeuchte)
- Live-Trendpfeil für die Luftfeuchtigkeit (steigend/fallend/stabil, letzte 20 Min.)
- Vollständiger visueller GUI-Editor (kein YAML nötig)
- Fast jeder Baustein einzeln ein-/ausschaltbar, um die Karte schlanker zu machen
- Mehrere Karten für mehrere Räume möglich (mit eigenem Raumnamen im Titel)

## Screenshot

*(Screenshot hier einfügen, sobald verfügbar)*

## Installation

### Über HACS (empfohlen, sobald als Custom Repository hinzugefügt)

1. HACS → Frontend →⋮ → Benutzerdefinierte Repositories
2. Dieses Repository als Typ "Dashboard" hinzufügen
3. "Blush Lüftungsempfehlung" installieren
4. Home Assistant neu laden (Strg+Shift+R im Browser reicht meist)

### Manuell

1. `blush-lueftung-card.js` nach `/config/www/` kopieren
2. Einstellungen → Dashboards → Ressourcen → Ressource hinzufügen
   - URL: `/local/blush-lueftung-card.js`
   - Typ: JavaScript-Modul
3. Seite neu laden

## Verwendung

Karte hinzufügen → "Blush Lüftungsempfehlung" suchen → im visuellen Editor die vier Pflicht-Sensoren auswählen:

| Feld | Pflicht | Beschreibung |
|---|---|---|
| Raumname | Nein | Wird im Kartentitel angezeigt, nützlich bei mehreren Karten |
| Außentemperatur-Sensor | **Ja** | `sensor.*` mit `device_class: temperature` |
| Außen-Luftfeuchte-Sensor | **Ja** | `sensor.*` mit `device_class: humidity` |
| Innentemperatur-Sensor | **Ja** | `sensor.*` mit `device_class: temperature` |
| Innen-Luftfeuchte-Sensor | **Ja** | `sensor.*` mit `device_class: humidity` |
| Windgeschwindigkeit-Sensor | Nein | Beeinflusst die Dauer-Schätzung; leer = keine Windkorrektur |
| Raumvolumen (m³) | Nein | Standard: 50 m³. Für genaue Wassermengen-/Wärmeverlust-Schätzung wichtig |
| Volumen ist nur geschätzt | Nein | Zeigt einen dezenten Hinweis in der Karte |
| 7 Anzeige-Schalter | Nein | Kästen, Nutzen/Kosten-Kacheln, Taupunkt, Wind, Trend, Wärmeverlust, Schimmel-Warnung einzeln ein-/ausschaltbar |

### Beispiel-YAML

```yaml
type: custom:blush-lueftung-card
name: Wohnzimmer
temp_out: sensor.aussen_temperatur
hum_out: sensor.aussen_luftfeuchtigkeit
temp_in: sensor.wohnzimmer_temperatur
hum_in: sensor.wohnzimmer_luftfeuchtigkeit
wind: sensor.aussen_windgeschwindigkeit
room_volume_m3: 92
room_volume_is_estimate: true
show_columns: true
show_balance: true
show_dewpoint: true
show_wind: true
show_trend: true
show_heat_loss: true
show_mold_warning: true
```

## Wie die Empfehlung berechnet wird

1. **Absolute Luftfeuchtigkeit** (g/m³) wird aus Temperatur + relativer Feuchte berechnet (Magnus-Formel)
2. **Differenz** (innen − außen) bestimmt die Grundrichtung:
   - ≤ −0,5 g/m³ → ❌ Nicht lüften
   - −0,5 … +0,5 g/m³ → ➖ Kein großer Unterschied
   - \> +0,5 g/m³ → Nutzen vorhanden, weiter zu Schritt 3
3. **Kosten-Nutzen-Verhältnis**: geschätzter Wärmeverlust (Wh, über die volumetrische Wärmekapazität von Luft ≈ 0,34 Wh/(m³·K)) geteilt durch die entfernte Wassermenge (g)
   - \> 4 Wh/g → ⚖️ Abwägen – lohnt sich kaum
   - ≤ 4 Wh/g → ✅ Lüften empfohlen, mit Dauer-Schätzung (`18 / √ΔT` Minuten, durch Wind verkürzt)

## Bekannte Grenzen

- **Kein Sensor-Frische-Check**: Ein eingefrorener Sensor (z. B. leere Batterie) würde unbemerkt mit einem alten Wert weiterrechnen. Ließe sich über `last_changed`/`last_updated` ergänzen — bewusst noch nicht eingebaut.
- Die Lüftungsdauer- und Wärmeverlust-Formeln sind **plausible Näherungen**, keine Laborwerte. Echte Luftaustauschraten hängen zusätzlich von Fenstergröße, Öffnungsart (Kipp vs. ganz offen) und Windrichtung relativ zum Fenster ab — Werte, die ohne entsprechende Sensoren nicht erfassbar sind.
- Die Schimmel-Warnung prüft nur den **aktuellen** Wert, nicht ob eine erhöhte Feuchte schon länger anhält.

## Lizenz

MIT — siehe [LICENSE](LICENSE)
