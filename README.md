# KassenWart 1.0

KassenWart ist ein lokales, touchfreundliches Getränke- und Snackterminal für Vereine, Werkstätten und Gemeinschaftsräume.

## Funktionen

- Anmeldung über eine vierstellige Nutzer-ID
- Getränke- und Snackbuchungen mit optionaler Bestandsführung
- Nutzerverwaltung und Zahlungserfassung
- Buchungsverlauf und Preisänderungen
- frei änderbarer Terminalname
- einstellbare Abmeldezeiten, Buchungstöne und Anzeigedauer von Meldungen
- Wartungsbereich innerhalb der Einstellungen
- automatische Anpassung an Smartphones, Tablets und große Bildschirme
- lokale Datenspeicherung im Browser (IndexedDB)
- optional freischaltbare Monats- und Jahresauswertung für Verwaltung und Nutzer, Theme-Auswahl und Testnutzer

## Erster Start

Die Datei `index.html` kann direkt im vorgesehenen lokalen Browser oder in Fully Kiosk geöffnet werden.

Die Datenbank ist bei einer Erstinstallation leer: Es werden keine Produkte und keine Nutzer vorgegeben. Produkte und Nutzer werden im Adminbereich angelegt.

- Standardname: **KassenWart**
- Standarddesign: **Hell**
- Standard-Admin-PIN: `999999`
- Automatische Nutzerabmeldung: **20 Sekunden**
- Automatische Adminabmeldung: **1 Minute**
- Erfolgsbenachrichtigungen: **3 Sekunden**

Die Admin-PIN sollte nach der Einrichtung unter **Einstellungen → Wartung → Admin-PIN ändern** geändert werden.

## Zusatzinhalte

Unter **Verwaltung → Einstellungen → Zusatzinhalte freischalten** können zehnstellige Codes aus Buchstaben und Zahlen eingegeben werden. Erfolgreich freigeschaltete Zusatzinhalte werden anschließend eingeblendet und bleiben bis zum Wiederherstellen der Werkseinstellungen aktiviert.

Die Freischaltcodes werden in einer separaten privaten Dokumentation verwaltet, die nicht Bestandteil der öffentlichen ZIP-Datei ist.

## Lizenz

KassenWart wird unter der [GNU General Public License Version 3](LICENSE) veröffentlicht (`GPL-3.0-only`).

Copyright (c) 2026 Kevin Schmitz - voidnexus.de
