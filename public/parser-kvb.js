/* ===================================================================
   parser-kvb.js — Modul der Kommandozentrale
   Liest die Berichte der KVB im Browser. Keine Übertragung, kein
   Sprachmodell, keine erfundenen Werte.

   Öffentliche Schnittstelle (siehe vertrag.md):
     KVB.erkenne(buffer)  -> Berichtstyp oder null
     KVB.quartal(buffer)  -> "JJJJQn" oder null — liest sonst nichts
     KVB.kopfdaten(buffer)-> { typ, quartal } in einem Durchgang
     KVB.parse(buffer)    -> vollständiger Datenstand nach vertrag.md

   Erkannte Berichte und die Module, die sie erzeugen:
     HW0021  Häufigkeitsstatistik, Ziffernliste  -> modul "ziffern"
     HW0024  Gesamtübersicht, Leistungsgruppen   -> modul "leistungsgruppen"
     Antibiotikabericht (zwei Fassungen)         -> modul "antibiotika"
     Arzneimittel-Trendmeldung nach WSV          -> modul "wsv"
     Sprechstundenbedarf-Trendmeldung            -> modul "ssb"
     Honorarbescheid                             -> modul "honorar"
     Honorarzusammenstellung                     -> modul "honorarzusammenstellung"

   Geprüft gegen 48 echte Berichte aus elf Quartalen (2024Q1 bis 2026Q2):
   6 HW0021, 5 HW0024, 12 Antibiotikaberichte in zwei Fassungen,
   8 Arzneimittel- und 8 Sprechstundenbedarf-Trendmeldungen,
   8 Honorarbescheide und 1 Honorarzusammenstellung.
   Der Layoutwechsel 2024/2025 ist eingeschlossen.

   Geprüft ausschließlich mit pdf.js 3.11.174 (Build ce8716743).
   Der Parser weigert sich, unter einer anderen Fassung zu laufen —
   siehe pruefeFassung() weiter unten.
   =================================================================== */
(function (global) {
"use strict";

/* =================================================================
   Geprüfte pdf.js-Fassung

   Dieser Parser wertet Textgeometrie aus: it.transform für gedrehte
   Beschriftungen, it.width für die Zeichenbreite, aus der er
   Wortpositionen rechnet. Diese Werte haben sich zwischen den großen
   pdf.js-Fassungen verändert. Eine andere Fassung wirft keinen
   Fehler — sie verschiebt Spaltengrenzen still, und dann stehen
   falsche Zahlen da, ohne dass jemand es merkt.

   Deshalb prüft der Parser die Fassung selbst und schlägt Alarm,
   statt sich darauf zu verlassen, dass jemand die Version im
   script-Tag richtig gesetzt hat.
   ================================================================= */
const PDFJS_GEPRUEFT = "3.11.174";

/* =================================================================
   Welcher Parserstand hier läuft

   Diese Datei wird an zwei Stellen gebraucht: als Quelle im
   Projektordner und als ausgelieferte Datei der Anwendung. Zwei
   Kopien laufen früher oder später auseinander, und das fällt
   niemandem auf — deshalb trägt jeder erzeugte Datenstand mit,
   welcher Parserstand ihn erzeugt hat (quelle.parser).

   Findet sich später ein Lesefehler, ist damit beantwortbar, welche
   Quartale neu eingelesen werden müssen: alle, die einen älteren
   Stand tragen.

   Die Nummer wird bei jeder inhaltlichen Änderung hochgezählt.
   Vergessen wird das nicht: pruef/stand-pruefen.mjs vergleicht die
   Prüfsumme der Datei mit der hinterlegten und schlägt fehl, wenn
   sich der Inhalt geändert hat, die Nummer aber nicht.
   ================================================================= */
const STAND = "2026-09-01.1";

function pdfjsFassung(){
  try { return (typeof pdfjsLib !== "undefined" && pdfjsLib.version) || null; }
  catch(e){ return null; }
}

/* Wird von jedem Einstieg aufgerufen. Wirft bei falscher Fassung,
   weil ein Abbruch mit klarer Meldung besser ist als eine Zahl,
   der niemand ansieht, dass sie verrutscht ist. */
function pruefeFassung(){
  const ist = pdfjsFassung();
  if (ist === PDFJS_GEPRUEFT) return;
  throw new Error(
    "Falsche pdf.js-Fassung: geladen ist " + (ist || "eine unbekannte Fassung") +
    ", geprüft wurde ausschließlich " + PDFJS_GEPRUEFT + ". " +
    "Der Parser rechnet mit Textkoordinaten; eine andere Fassung verschiebt " +
    "Spaltengrenzen still. Bitte die geprüfte Fassung einbinden.");
}

const NUM = /^-?\d{1,3}(\.\d{3})*(,\d+)?\s*%?$|^-?\d+(,\d+)?\s*%?$/;
const zahl = s => parseFloat(String(s).replace(/%/g,"").trim().replace(/\./g,"").replace(",","."));

/* --- Textstücke einer Seite in Wörter mit Position zerlegen ------- */
async function woerter(page){
  const tc = await page.getTextContent();
  const auf = [], gedreht = [];
  for (const it of tc.items){
    const s = it.str; if (!s || !s.trim()) continue;
    const [a,b,c,d,x,y] = it.transform;
    const istGedreht = Math.abs(b) > 0.01 || Math.abs(c) > 0.01;
    if (istGedreht){ gedreht.push({ text:s.trim(), x, y }); continue; }
    const proZeichen = it.width / Math.max(s.length,1);
    let pos = 0;
    for (const teil of s.split(/\s+/)){
      if (!teil) continue;
      const idx = s.indexOf(teil, pos);
      auf.push({ text:teil, x: x + idx*proZeichen, y });
      pos = idx + teil.length;
    }
  }
  return { auf, gedreht };
}

/* Gedrehte Beschriftungen zusammensetzen: gleiche x-Spalte, von unten nach oben */
function gedrehteLabels(gedreht){
  const spalten = new Map();
  for (const g of gedreht){
    const k = Math.round(g.x/2)*2;
    if (!spalten.has(k)) spalten.set(k, []);
    spalten.get(k).push(g);
  }
  const raus = [];
  for (const [k, cs] of spalten){
    cs.sort((p,q)=> p.y - q.y);
    raus.push({ text: cs.map(c=>c.text).join(""), x: Math.min(...cs.map(c=>c.x)) });
  }
  return raus;
}

/* Nach waagerechten Lücken gruppieren.
   Die Schwelle wird aus den Abständen selbst gebildet, nicht fest gesetzt:
   der Median aller Abstände ist der Abstand innerhalb einer Gruppe, alles
   deutlich Größere trennt zwei Gruppen. Damit ist die Gruppierung unabhängig
   davon, wie eng das Diagramm gesetzt ist. */
function gruppiereNachLuecke(items, faktor=1.6){
  const s = items.slice().sort((a,b)=>a.x-b.x);
  if (s.length < 2) return s.length ? [s] : [];
  const luecken = [];
  for (let i=1;i<s.length;i++) luecken.push(s[i].x - s[i-1].x);
  const sort = luecken.slice().sort((a,b)=>a-b);
  const median = sort[Math.floor(sort.length/2)];
  const schwelle = median * faktor;
  const raus = [[s[0]]];
  for (let i=1;i<s.length;i++){
    if (s[i].x - s[i-1].x > schwelle) raus.push([s[i]]);
    else raus[raus.length-1].push(s[i]);
  }
  return raus;
}

/* Wörter zu Zeilen gruppieren (gleiche Grundlinie) */
function zeilen(ws, tol=4){
  const s = ws.slice().sort((a,b)=> b.y-a.y || a.x-b.x);
  const z = []; let cur = [], basis = null;
  for (const w of s){
    if (basis === null || Math.abs(w.y - basis) <= tol){
      if (basis === null) basis = w.y;
      cur.push(w);
    } else { z.push(cur.sort((a,b)=>a.x-b.x)); cur = [w]; basis = w.y; }
  }
  if (cur.length) z.push(cur.sort((a,b)=>a.x-b.x));
  return z;
}

/* Spaltengrenzen aus der Kopfzeile ableiten — nie feste Koordinaten */
function grenzenAusKopf(zs, anzahl, erstesWort){
  for (let i=0;i<zs.length;i++){
    const t = zs[i].map(w=>w.text);
    if (t[0]==="1" && t[1]===erstesWort && t.includes(String(anzahl))){
      const g = []; let e = 1;
      for (const w of zs[i]){ if (w.text === String(e)){ g.push(w.x); e++; } if (e>anzahl) break; }
      if (g.length === anzahl) return { index:i, grenzen:g };
    }
  }
  return null;
}
function inZellen(zeile, kanten){
  const n = kanten.length-1, z = new Array(n).fill("");
  for (const w of zeile)
    for (let i=0;i<n;i++)
      if (w.x >= kanten[i] && w.x < kanten[i+1]){ z[i] = (z[i]+" "+w.text).trim(); break; }
  return z;
}

/* =================================================================
   Berichtstyp erkennen
   ================================================================= */
function typAusText(t){
  if (/Antibiotika zur systemischen Anwendung|J01-Information/.test(t)) return "antibiotika";
  if (/TRENDMELDUNG/.test(t) && /Wirtschaftlichkeitsziele|Wirkstoffvereinbarung/.test(t)) return "wsv";
  if (/Sprechstundenbedarf/.test(t)) return "ssb";
  if (/Honorarzusammenstellung/.test(t)) return "honorarzusammenstellung";
  if (/Honorarbescheid/.test(t) && /Gesamthonorarsumme/.test(t)) return "honorar";
  if (/Gesamtübersicht/.test(t)) return "HW0024";
  if (/Häufigkeitsstatistik/.test(t)) return "HW0021";
  return null;
}

async function erkenne(buffer){
  pruefeFassung();
  const pdf = await pdfjsLib.getDocument({data: buffer.slice(0)}).promise;
  const tc = await (await pdf.getPage(1)).getTextContent();
  return typAusText(tc.items.map(i=>i.str).join(" "));
}

/* Wo im jeweiligen Bericht die Quartalskennung steht. Bewusst eng
   gefasst, damit nicht irgendein anderes "Quartal" auf der Seite
   erwischt wird — im Honorarbescheid etwa der Schuldvortrag, der auf
   das FOLGENDE Quartal verweist. */
const QUARTALSMUSTER = {
  HW0021:                  /Quartal\s+(\d)\s*\/\s*(\d{4})/,
  HW0024:                  /Quartal\s+(\d)\s*\/\s*(\d{4})/,
  antibiotika:             /für Quartal\s+(\d)\s*\/\s*(\d{4})/,
  wsv:                     /TRENDMELDUNG\s+(\d)\s*\/\s*(\d{4})/,
  ssb:                     /Quartal\s+(\d)\s*\/\s*(\d{4})/,
  honorar:                 /Quartal:\s*(\d)\s*\/\s*(\d{4})/,
  honorarzusammenstellung: /Quartal\s+(\d)\s*\/\s*(\d{4})/
};

/* =================================================================
   Kopfdaten — Berichtstyp und Quartal, sonst nichts

   Für die Upload-Seite gedacht, die im Browser einer Mitarbeiterin
   läuft. Gelesen wird ausschließlich Seite 1, zurückgegeben werden
   ausschließlich Typ und Quartalskennung. Es entsteht kein
   Datenstand, keine Ziffer, kein Betrag — nichts, was die Seite
   anzeigen oder weitergeben könnte.

   Seite 1 wird zeilenweise gelesen und nicht über den Textfluss:
   die Honorarzusammenstellung stellt ihre Werte im PDF-Datenstrom
   vor die Beschriftung, dort führt der Textfluss in die Irre.
   ================================================================= */
async function kopfdaten(buffer){
  pruefeFassung();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({data: buffer.slice(0)}).promise;
  } catch (e) {
    return { typ:null, quartal:null, grund:"Die Datei lässt sich nicht als PDF öffnen." };
  }
  const seite = await pdf.getPage(1);
  const roh = (await seite.getTextContent()).items.map(i=>i.str).join(" ");
  const typ = typAusText(roh);
  if (!typ)
    return { typ:null, quartal:null, grund:"Diesen Bericht kenne ich nicht." };
  const muster = QUARTALSMUSTER[typ];
  const { auf } = await woerter(seite);
  const zeilig = zeilen(auf).map(z => z.map(w=>w.text).join(" ")).join("  ");
  const m = zeilig.match(muster) || roh.match(muster);
  return m
    ? { typ, quartal: m[2]+"Q"+m[1], grund:null }
    : { typ, quartal:null, grund:"Auf Seite 1 steht keine lesbare Quartalsangabe." };
}

/* Nur die Quartalskennung, im Format JJJJQn — oder null.
   Wirft nie: die Upload-Seite soll bei einer kaputten Datei eine
   Meldung zeigen, nicht stehenbleiben. Warum es nicht ging, steht
   in kopfdaten().grund. */
async function quartal(buffer){
  pruefeFassung();          // absichtlich VOR dem try: eine falsche
                            // pdf.js-Fassung ist kein Dateiproblem und
                            // darf nicht als "kein Quartal" durchgehen.
  try { return (await kopfdaten(buffer)).quartal; }
  catch (e) {
    if (/pdf\.js-Fassung/.test(e.message)) throw e;
    return null;
  }
}

/* =================================================================
   HW0021 — Ziffernliste
   ================================================================= */
async function parseHW0021(buffer){
  const pdf = await pdfjsLib.getDocument({data: buffer.slice(0)}).promise;
  const gops = [], gruppen = [];
  let offen = [], label = null, kopfseiten = 0;
  let quartal=null, bsnr=null, pruefgruppe=null, fallzahl=null;

  for (let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const breite = page.view[2];
    const { auf } = await woerter(page);
    const zs = zeilen(auf);

    if (p === 1){
      for (const z of zs){
        const t = z.map(w=>w.text);
        const nach = m => { const i=t.indexOf(m); return (i>=0 && t[i+1]) ? t[i+1] : null; };
        quartal = quartal || nach("Quartal");
        bsnr = bsnr || nach("BSNR");
        pruefgruppe = pruefgruppe || nach("Prüfgruppe");
        const i = t.indexOf("Kurativ");
        if (i>=0 && t[i+1] && NUM.test(t[i+1])) fallzahl = zahl(t[i+1]);
      }
    }

    const k = grenzenAusKopf(zs, 13, "GOP");
    if (!k) continue;
    kopfseiten++;
    const kanten = [0, ...k.grenzen.slice(1), breite];

    for (const z of zs.slice(k.index+2)){
      const text = z.map(w=>w.text).join(" ");
      if (text.startsWith("Erläuterungen")) break;
      const c = inZellen(z, kanten);
      if (text.startsWith("LSTGR")){ label = text; continue; }
      if (c[0].startsWith("Summe")){
        if (label === null) continue;                 // laufende Zwischensumme
        const m = c[0].match(/^Summe\s+(\d+)$/);
        const n = c.slice(1).filter(x=>x);
        gruppen.push({ lstgr: label,
          n_gop_soll: m ? parseInt(m[1],10) : null,
          haeufigkeit_soll: n[0] ? zahl(n[0]) : null,
          betrag_soll: n[1] ? zahl(n[1]) : null,
          gops: offen });
        offen.forEach(g => g.lstgr = label);
        offen = []; label = null; continue;
      }
      if (!/^\d{5}[A-Z]?$/.test(c[0])) continue;
      const v = i => (c[i] && NUM.test(c[i])) ? zahl(c[i]) : null;
      const g = { gop:c[0], lstgr:null, haeufigkeit:v(1), wert_gop:v(2), gesamtbetrag:v(3),
        eur_je_fall:v(4), eur_je_fall_pg:v(5), ansatz_in_faellen:v(6), leistungen_je_fall:v(7),
        ansatz_pct_fz:v(8), ansatz_pct_fz_pg:v(9), haeufigkeit_100:v(10),
        abweichung_pct:v(11), verbreitung_pct:v(12), herkunft:{ seite:p } };
      gops.push(g); offen.push(g);
    }
  }

  let ok=0, schlecht=0;
  for (const gr of gruppen){
    const b = gr.gops.reduce((s,x)=>s+(x.gesamtbetrag||0),0);
    const h = gr.gops.reduce((s,x)=>s+(x.haeufigkeit||0),0);
    gr.betrag_ist = b; gr.haeufigkeit_ist = h;
    gr.passt = Math.abs(b-(gr.betrag_soll||0)) < 0.05
            && Math.abs(h-(gr.haeufigkeit_soll||0)) < 0.5
            && gr.gops.length === gr.n_gop_soll;
    gr.passt ? ok++ : schlecht++;
  }
  const pruefungen = [
    { name:"summenprobe", ergebnis: schlecht ? "fehler":"ok", erwartet:gruppen.length, gefunden:ok },
    { name:"vollstaendigkeit", ergebnis: gops.length>=30 ? "ok":"fehler",
      erwartet:"mindestens 30 Ziffern", gefunden:gops.length },
    { name:"layout", ergebnis: kopfseiten>0 ? "ok":"fehler",
      erwartet:"Tabellenkopf gefunden", gefunden:kopfseiten+" Seiten" },
    { name:"plausibilitaet", ergebnis:(fallzahl>500 && fallzahl<20000) ? "ok":"fehler",
      erwartet:"Fallzahl 500 bis 20000", gefunden:fallzahl }
  ];
  return { modul:"ziffern", quartal: quartal ? quartal.replace(/^(\d)\/(\d{4})$/,"$2Q$1") : null,
    erzeugt:new Date().toISOString(), version:2,
    status: pruefungen.some(p=>p.ergebnis==="fehler") ? "unsicher" : "wartet",
    quelle:{ bsnr, pruefgruppe, seiten:pdf.numPages },
    pruefungen, daten:{ faelle_gesamt:fallzahl, gop:gops, gruppen } };
}

/* =================================================================
   HW0024 — Leistungsgruppen
   ================================================================= */
async function parseHW0024(buffer){
  const pdf = await pdfjsLib.getDocument({data: buffer.slice(0)}).promise;
  const gruppen = []; let quartal=null, bsnr=null, kopfseiten=0;

  for (let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const breite = page.view[2];
    const { auf } = await woerter(page);
    const zs = zeilen(auf);
    if (p===1){
      for (const z of zs){
        const t = z.map(w=>w.text);
        const nach = m => { const i=t.indexOf(m); return (i>=0&&t[i+1]) ? t[i+1] : null; };
        quartal = quartal || nach("Quartal"); bsnr = bsnr || nach("BSNR");
      }
    }
    let k = null;
    for (let i=0;i<zs.length;i++){
      const t = zs[i].map(w=>w.text);
      if (t[0]==="1" && t.includes("11")){
        const g=[]; let e=1;
        for (const w of zs[i]){ if (w.text===String(e)){ g.push(w.x); e++; } if (e>11) break; }
        if (g.length===11){ k={index:i, grenzen:g}; break; }
      }
    }
    if (!k) continue;
    kopfseiten++;
    const kanten = [0, ...k.grenzen.slice(1), breite];
    let code=null, puffer=[];
    for (const z of zs.slice(k.index+1)){
      const c = inZellen(z, kanten);
      if (/^\d{2}$/.test(c[0])){ code=c[0]; puffer=[]; continue; }
      const zahlen = c.slice(1).filter(x=>x && NUM.test(x));
      if (zahlen.length < 4){ if (c[0] && !zahlen.length) puffer.push(c[0]); continue; }
      const v = i => (c[i] && NUM.test(c[i])) ? zahl(c[i]) : null;
      const bez = (c[0]+" "+puffer.join(" ")).trim();
      const summe = /^(summe|inkl)/i.test(bez);
      gruppen.push({ lstgr: summe ? null : code, bezeichnung:bez, summenzeile:summe,
        leistungsbedarf_gesamt:v(5), eur_je_fall_praxis:v(6), eur_je_fall_pg:v(7),
        eur_je_fall_pg_gewichtet:v(8), abweichung_pct:v(10), herkunft:{ seite:p } });
      puffer=[]; if (summe) code=null;
    }
  }
  const pruefungen = [
    { name:"layout", ergebnis: kopfseiten>0 ? "ok":"fehler", gefunden:kopfseiten+" Seiten" },
    { name:"vollstaendigkeit", ergebnis: gruppen.length>=5 ? "ok":"fehler",
      erwartet:"mindestens 5 Leistungsgruppen", gefunden:gruppen.length }
  ];
  return { modul:"leistungsgruppen", quartal: quartal ? quartal.replace(/^(\d)\/(\d{4})$/,"$2Q$1") : null,
    erzeugt:new Date().toISOString(), version:2,
    status: pruefungen.some(p=>p.ergebnis==="fehler") ? "unsicher" : "wartet",
    quelle:{ bsnr, seiten:pdf.numPages }, pruefungen, daten:{ gruppen } };
}

/* =================================================================
   Antibiotikabericht
   Zwei Fassungen: bis Q1/2025 zwei Seiten ohne Klassentabelle (A),
   ab Q2/2025 drei Seiten mit Klassentabelle (B). Beide sind gültig.
   ================================================================= */
async function parseAntibiotika(buffer){
  const pdf = await pdfjsLib.getDocument({data: buffer.slice(0)}).promise;
  const seiten = [];
  for (let p=1; p<=pdf.numPages; p++) seiten.push(await pdf.getPage(p));
  const texte = [];
  for (const s of seiten) texte.push((await s.getTextContent()).items.map(i=>i.str).join(" "));
  const ganz = texte.join("\n");

  const mq = ganz.match(/für Quartal\s+(\d)\s*\/\s*(\d{4})/);
  const quartal = mq ? `${mq[2]}Q${mq[1]}` : null;
  const mb = ganz.match(/(\d{9})\s*\(inkl/);
  const u18 = ganz.match(/Anteil Ihrer AMPs unter 18 Jahren:\s*([\d,]+)\s*%/);
  const u18afg = ganz.match(/Anteil der AMPs in Ihrer Arztfachgruppe unter 18 Jahren:\s*([\d,]+)\s*%/);

  /* Verlauf: gedrehte Balkenbeschriftungen, je Quartal drei Werte */
  const { auf: auf1, gedreht } = await woerter(seiten[0]);
  const labels = gedrehteLabels(gedreht).filter(l => /^\d{1,2},\d%$/.test(l.text));
  const achse = auf1.filter(w => /^Q[1-4]\/\d{2}$/.test(w.text)).sort((a,b)=>a.x-b.x);
  /* Die Beschriftungen stehen als Dreiergruppen über den Balken. Ein fester
     Abstand um die Achsenbeschriftung reicht nicht: bei acht Quartalen rücken
     die Gruppen so dicht zusammen, dass ein Nachbarwert mitgefasst wird.
     Deshalb werden die Gruppen über die Lücken gebildet — die Lücke zwischen
     zwei Gruppen ist rund doppelt so groß wie die innerhalb einer Gruppe. */
  const verlaufGruppen = gruppiereNachLuecke(labels);
  const verlaufPasst = verlaufGruppen.length === achse.length
                    && verlaufGruppen.every(g => g.length === 3);
  const verlauf = achse.map((a,i) => {
    const g = verlaufPasst ? verlaufGruppen[i] : null;
    return g ? { quartal:a.text, praxis:zahl(g[0].text), bezirk:zahl(g[1].text), bayern:zahl(g[2].text) }
             : { quartal:a.text, praxis:null, bezirk:null, bayern:null };
  });

  /* Wirkstofftabelle — zeilenweise über Positionen, nicht über den Textfluss */
  const wirkstoffe = [];
  if (seiten[1]){
    const { auf: auf2 } = await woerter(seiten[1]);
    for (const z of zeilen(auf2)){
      const t = z.map(w=>w.text);
      if (!/^\d{2}$/.test(t[0])) continue;
      const iAtc = t.findIndex(x => /^J01/.test(x));
      if (iAtc < 0) continue;
      const werte = [];
      for (let i=t.length-1; i>=0 && werte.length<4; i--)
        if (NUM.test(t[i])) werte.unshift(zahl(t[i])); else break;
      if (werte.length !== 4) continue;
      const name = t.slice(iAtc+1, t.length-4).join(" ").replace(/^-\s*/,"").trim();
      wirkstoffe.push({ rang:+t[0], atc:t[iAtc], name, amp:werte[0],
        praxis:werte[1], bezirk:werte[2], bayern:werte[3], herkunft:{ seite:2 } });
    }
  }

  /* Klassentabelle, nur in Fassung B */
  const klassen = [];
  if (seiten.length >= 3){
    const { auf } = await woerter(seiten[2]);
    const zs = zeilen(auf);
    let kopf = -1;
    for (let i=0;i<zs.length;i++){
      const t = zs[i].map(w=>w.text);
      if (t.includes("Antibiotika-Klasse") && t.some(x=>/^AFG-BY/.test(x))){ kopf = i; break; }
    }
    if (kopf >= 0){
      for (const z of zs.slice(kopf+1)){
        const n = z.filter(w => NUM.test(w.text));
        const name = z.filter(w => !NUM.test(w.text)).map(w=>w.text).join(" ").trim();
        if (n.length === 4 && name)
          klassen.push({ klasse:name, anzahl:zahl(n[0].text), praxis:zahl(n[1].text),
            bezirk:zahl(n[2].text), bayern:zahl(n[3].text), herkunft:{ seite:3 } });
      }
    }
  }

  const fassung = (pdf.numPages>=3 && klassen.length) ? "B"
                : (pdf.numPages===2 ? "A" : "unbekannt");
  const summeAnteile = wirkstoffe.reduce((s,w)=>s+w.praxis, 0);
  const pruefungen = [
    { name:"layout", ergebnis: (quartal && fassung!=="unbekannt") ? "ok":"fehler",
      erwartet:"bekannte Berichtsfassung", gefunden:`Fassung ${fassung}, ${pdf.numPages} Seiten` },
    { name:"vollstaendigkeit_wirkstoffe", ergebnis: wirkstoffe.length>=5 ? "ok":"fehler",
      erwartet:"mindestens 5 Wirkstoffe", gefunden:wirkstoffe.length },
    { name:"verlauf_gruppen", ergebnis: verlaufPasst ? "ok":"fehler",
      erwartet:`${achse.length} Quartale mit je 3 Balkenwerten`,
      gefunden:`${verlaufGruppen.length} Gruppen (${verlaufGruppen.map(g=>g.length).join("/")})`,
      hinweis:"Stimmt die Zuordnung nicht, bleibt der Verlauf leer statt falsch" },
    fassung==="B"
      ? { name:"vollstaendigkeit_klassen", ergebnis: klassen.length===4 ? "ok":"fehler",
          erwartet:4, gefunden:klassen.length }
      : { name:"vollstaendigkeit_klassen", ergebnis:"offen",
          hinweis:"Diese Berichtsfassung enthält keine Klassentabelle" },
    { name:"summenprobe_anteile",
      ergebnis: (summeAnteile>=60 && summeAnteile<=101) ? "ok":"warnung",
      gefunden: Math.round(summeAnteile*10)/10,
      hinweis:"Top-15-Liste — eine Summe unter 100 % ist richtig, nicht fehlerhaft" }
  ];
  return { modul:"antibiotika", fassung, quartal, erzeugt:new Date().toISOString(), version:2,
    status: pruefungen.some(p=>p.ergebnis==="fehler") ? "unsicher" : "wartet",
    quelle:{ bsnr: mb?mb[1]:null, seiten:pdf.numPages },
    pruefungen,
    daten:{
      amp_u18_praxis: u18?zahl(u18[1]):null,
      amp_u18_afg: u18afg?zahl(u18afg[1]):null,
      verlauf, wirkstoffe, klassen,
      kennzahlen: klassen.map(k=>({ name:k.klasse, wert:k.praxis,
        vergleich:{ fachgruppe_regional:k.bezirk, fachgruppe_bayern:k.bayern, zeitraum:quartal } }))
    } };
}


/* =================================================================
   Arzneimittel-Trendmeldung (Wirkstoffvereinbarung)
   Drei Zielarten: Generika, Leitsubstanzen, Mengenziel.
   Beim Mengenziel gilt die umgekehrte Richtung — weniger ist besser.
   ================================================================= */
async function parseWSV(buffer){
  const pdf = await pdfjsLib.getDocument({data: buffer.slice(0)}).promise;
  const ziele = [];
  let quartal=null, bsnr=null, abschnitt=null, kopfgefunden=0;

  for (let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const { auf } = await woerter(page);
    const zs = zeilen(auf);
    if (p===1){
      const t = zs.map(z=>z.map(w=>w.text).join(" ")).join(" ");
      const mq = t.match(/TRENDMELDUNG\s+(\d)\s*\/\s*(\d{4})/);
      if (mq) quartal = `${mq[2]}Q${mq[1]}`;
      const mb = t.match(/Betriebsstätte\s+(\d{9})/);
      if (mb) bsnr = mb[1];
    }
    let kopf = null;   // Spaltenanker der aktuellen Tabelle
    for (const z of zs){
      const t = z.map(w=>w.text);
      const zeile = t.join(" ");
      if (/^Generikaziele/.test(zeile)) { abschnitt="generika"; continue; }
      if (/^Leitsubstanzziele/.test(zeile)) { abschnitt="leitsubstanz"; continue; }
      if (/^Mengenziel/.test(zeile)) { abschnitt="menge"; continue; }

      // Kopfzeile einer Zieltabelle: enthält Zielwert und Ergebnis
      // Die Kopfzeile ist über mehrere Zeilen verteilt — jedes Stück zählt
      if (t.includes("Zielwert") || t.includes("Ergebnis") || t.includes("Arzneimittelgruppe")){
        kopf = true; kopfgefunden++; continue;
      }
      if (!abschnitt) continue;

      // Datenzeile: beginnt mit der Zielnummer, endet mit drei Zahlen
      if (!/^\d+(\.\d+)?$/.test(t[0])) continue;
      const zahlenRechts = [];
      for (let i=t.length-1; i>=1 && zahlenRechts.length<3; i--){
        if (NUM.test(t[i])) zahlenRechts.unshift(t[i]); else break;
      }
      if (zahlenRechts.length !== 3) continue;
      const text = t.slice(1, t.length-3).join(" ").trim();
      if (!text) continue;
      const zielwert = zahl(zahlenRechts[0]);
      const ddd = zahl(zahlenRechts[1]);
      const wert = zahl(zahlenRechts[2]);
      const wenigerIstBesser = (abschnitt === "menge");
      ziele.push({
        nr: t[0], art: abschnitt, bezeichnung: text,
        zielwert, ddd, wert,
        einheit: wenigerIstBesser ? "DDD je Verordnungsfall" : "%",
        weniger_ist_besser: wenigerIstBesser,
        erreicht: wenigerIstBesser ? (wert <= zielwert) : (wert >= zielwert),
        abstand: wenigerIstBesser ? (zielwert - wert) : (wert - zielwert),
        herkunft: { seite: p }
      });
    }
  }

  const erreicht = ziele.filter(z=>z.erreicht).length;
  const knapp = ziele.filter(z=>!z.erreicht && Math.abs(z.abstand) <= 5).length;
  const pruefungen = [
    { name:"layout", ergebnis: (quartal && kopfgefunden>0) ? "ok":"fehler",
      erwartet:"Quartal und Zieltabellen gefunden", gefunden:`${kopfgefunden} Tabellenköpfe` },
    { name:"vollstaendigkeit", ergebnis: ziele.length>=5 ? "ok":"fehler",
      erwartet:"mindestens 5 Wirkstoffziele", gefunden:ziele.length },
    { name:"plausibilitaet",
      ergebnis: ziele.every(z=>z.zielwert>0 && z.wert>=0) ? "ok":"fehler",
      erwartet:"Zielwerte und Istwerte positiv", gefunden:`${ziele.length} Ziele geprüft` }
  ];
  return { modul:"wsv", quartal, erzeugt:new Date().toISOString(), version:2,
    status: pruefungen.some(p=>p.ergebnis==="fehler") ? "unsicher" : "wartet",
    quelle:{ bsnr, seiten:pdf.numPages }, pruefungen,
    daten:{ ziele, ziele_gesamt:ziele.length, ziele_erreicht:erreicht, ziele_knapp:knapp } };
}

/* =================================================================
   Sprechstundenbedarf-Trendmeldung
   Drei Tabellen. Die Produktliste ist eine TOP-30-Auswahl — ihre
   Zeilensumme darf die Gesamtsumme nicht erreichen, das ist richtig
   und kein Fehler.
   ================================================================= */
async function parseSSB(buffer){
  const pdf = await pdfjsLib.getDocument({data: buffer.slice(0)}).promise;
  const tabellen = []; let aktuell=null, quartal=null, bsnr=null, kopfgefunden=0;

  for (let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const { auf } = await woerter(page);
    const zs = zeilen(auf);
    if (p===1){
      const t = zs.map(z=>z.map(w=>w.text).join(" ")).join(" ");
      const mq = t.match(/Quartal\s+(\d)\s*\/\s*(\d{4})/);
      if (mq) quartal = `${mq[2]}Q${mq[1]}`;
      const mb = t.match(/Betriebsstätte\s+(\d{9})/);
      if (mb) bsnr = mb[1];
    }
    for (const z of zs){
      const t = z.map(w=>w.text);
      const zeile = t.join(" ");

      // Tabellenkopf erkennt zugleich die Tabellenart
      const mk = zeile.match(/^(Arzneimittel und andere Produkte|Impfstoffe|Verbandstoffe|Sonstige)\s+Anzahl/);
      if (mk){
        aktuell = tabellen.find(x=>x.name===mk[1]);
        if (!aktuell){ aktuell = { name:mk[1], positionen:[], summe_top:null, gesamt:null }; tabellen.push(aktuell); }
        kopfgefunden++; continue;
      }
      if (!aktuell) continue;

      const zahlenRechts = [];
      for (let i=t.length-1; i>=0 && zahlenRechts.length<2; i--){
        if (NUM.test(t[i])) zahlenRechts.unshift(t[i]); else break;
      }
      if (zahlenRechts.length !== 2) continue;
      const name = t.slice(0, t.length-2).join(" ").trim();
      if (!name) continue;
      const eintrag = { anzahl: zahl(zahlenRechts[0]), kosten: zahl(zahlenRechts[1]) };
      if (/^SUMME TOP/i.test(name)) { aktuell.summe_top = eintrag; continue; }
      if (/^Gesamtsumme/i.test(name)) {
        aktuell.gesamt = eintrag; aktuell = null;   // Tabelle ist zu Ende
        continue;
      }
      aktuell.positionen.push({ bezeichnung:name, ...eintrag, herkunft:{ seite:p } });
    }
  }

  // Summenprobe: Zeilensumme darf die Gesamtsumme nicht übersteigen
  let geprueft=0, verletzt=0;
  for (const tb of tabellen){
    if (!tb.gesamt) continue;
    geprueft++;
    const summe = tb.positionen.reduce((s,x)=>s+x.kosten,0);
    tb.positionen_summe = Math.round(summe*100)/100;
    tb.vollstaendig = Math.abs(summe - tb.gesamt.kosten) < 0.05;
    if (summe - tb.gesamt.kosten > 0.05) verletzt++;
  }
  const gesamtkosten = tabellen.reduce((s,t)=> s + (t.gesamt ? t.gesamt.kosten : 0), 0);
  const impf = tabellen.find(t=>t.name==="Impfstoffe");
  const pruefungen = [
    { name:"layout", ergebnis: (quartal && kopfgefunden>0) ? "ok":"fehler",
      erwartet:"Quartal und Tabellenköpfe gefunden", gefunden:`${kopfgefunden} Köpfe, ${tabellen.length} Tabellen` },
    { name:"vollstaendigkeit", ergebnis: tabellen.length>=1 ? "ok":"fehler",
      erwartet:"mindestens eine Tabelle", gefunden:tabellen.length },
    { name:"summenprobe", ergebnis: verletzt ? "fehler":"ok",
      erwartet:"Zeilensumme höchstens Gesamtsumme", gefunden:`${geprueft} Tabellen geprüft`,
      hinweis:"TOP-30-Liste — eine Zeilensumme unter der Gesamtsumme ist richtig" }
  ];
  return { modul:"ssb", quartal, erzeugt:new Date().toISOString(), version:2,
    status: pruefungen.some(p=>p.ergebnis==="fehler") ? "unsicher" : "wartet",
    quelle:{ bsnr, seiten:pdf.numPages }, pruefungen,
    daten:{ tabellen, kosten_gesamt: Math.round(gesamtkosten*100)/100,
      kosten_impfstoffe: impf && impf.gesamt ? impf.gesamt.kosten : null,
      kosten_ohne_impfstoffe: Math.round((gesamtkosten - (impf&&impf.gesamt?impf.gesamt.kosten:0))*100)/100 } };
}


/* =================================================================
   Honorarbescheid
   Seite 1 und 2 tragen die Zahlen, ab Seite 3 folgt nur Rechtstext.
   Geprüft wird gegen die Bescheidlogik selbst: Gesamthonorar minus
   Verrechnungen minus Schuldvortrag muss die ausgewiesene Restzahlung
   ergeben, und die Einzelpositionen müssen das Gesamthonorar ergeben.
   Stimmt das nicht, ist der Datenstand unsicher.
   ================================================================= */
async function parseHonorar(buffer){
  const pdf = await pdfjsLib.getDocument({data: buffer.slice(0)}).promise;
  const text = [];
  for (let p=1; p<=Math.min(2,pdf.numPages); p++){
    const { auf } = await woerter(await pdf.getPage(p));
    for (const z of zeilen(auf)) text.push(z.map(w=>w.text).join(" "));
  }
  const ganz = text.join("\n");

  const geld = re => { const m = ganz.match(re); return m ? zahl(m[1]) : null; };
  const mq = ganz.match(/Quartal:\s*(\d)\s*\/\s*(\d{4})/);
  const quartal = mq ? mq[2]+"Q"+mq[1] : null;
  const bsnr = (ganz.match(/Betriebsst[äa]ttennummer:\s*(\d{9})/)||[])[1] || null;
  const hnr  = (ganz.match(/Honorarabrechnungsnummer:\s*([\d/]+)/)||[])[1] || null;

  const gesamt  = geld(/Gesamthonorarsumme \(saldiert\)\s+([\d.,]+)\s*EUR/);
  const verrech = geld(/Verrechnungen\/Abschlagszahlung\w*\s*\(saldiert\)\s*-?\s*([\d.,]+)\s*EUR/);
  const schuld  = geld(/Schuldvortrag auf Quartal\s+\d\/\d{4}\s+([\d.,]+)\s*EUR/);
  const rest    = geld(/Restzahlung\s+([\d.,]+)\s*EUR/);
  const vk      = ganz.match(/Verwaltungskosten f[üu]r EDV-Abrechner\s+\d\/\d{4}\s+([\d,]+)\s+\d+\s+([\d.,]+)/);

  /* Einzelpositionen: nur der Honorarblock zwischen "Einzelaufstellung"
     und der Zeile "Gesamthonorar". Was danach kommt — Verwaltungskosten,
     Förderungen, Abschlagszahlungen, TI-Pauschale — gehört nicht in die
     Gesamthonorarsumme und darf die Summenprobe nicht verfälschen. */
  const iVon = text.findIndex(t => /^Einzelaufstellung/.test(t));
  const iBis = text.findIndex((t,i) => i>iVon && /^Gesamthonorar\s/.test(t));
  const positionen = [];
  if (iVon>=0 && iBis>iVon){
    /* Das Quartal in der Zeile ist NICHT immer das Quartal des Bescheides:
       Nachberechnungen tragen das Quartal, das sie berichtigen. Solche
       Zeilen sind gerade die interessanten und dürfen nicht wegfallen. */
    const re = /^(.+?)\s+(\d)\/(\d{4})\s+(\d{6,8})\s+([\d.,]+)\s+([\d.,]+)$/;
    for (const t of text.slice(iVon+1, iBis)){
      const m = t.match(re);
      if (!m) continue;
      const fuer = m[3]+"Q"+m[2];
      positionen.push({ buchungstext:m[1].trim(), fuer_quartal:fuer,
        nachberechnung: fuer !== quartal, material:m[4],
        belastung:zahl(m[5]), gutschrift:zahl(m[6]) });
    }
  }
  const summePos = Math.round(positionen.reduce((a,p)=>a+p.gutschrift-p.belastung,0)*100)/100;
  const probe = (gesamt!=null && verrech!=null && rest!=null)
    ? Math.round((gesamt - verrech - (schuld||0) - rest)*100)/100 : null;

  const pruefungen = [
    { name:"layout", ergebnis: (quartal && gesamt!=null) ? "ok":"fehler",
      erwartet:"Quartal und Gesamthonorarsumme auf Seite 1",
      gefunden: (quartal||"kein Quartal")+", "+(gesamt!=null?gesamt+" EUR":"keine Summe") },
    { name:"restzahlungsprobe",
      ergebnis: probe===null ? "fehler" : (Math.abs(probe)<=0.02 ? "ok":"fehler"),
      erwartet:"Gesamthonorar − Verrechnungen − Schuldvortrag = Restzahlung",
      gefunden: probe===null ? "nicht prüfbar" : "Differenz "+probe+" EUR" },
    { name:"summenprobe_positionen",
      ergebnis: (gesamt!=null && positionen.length && Math.abs(summePos-gesamt)<=0.02) ? "ok":"fehler",
      erwartet: gesamt, gefunden: summePos,
      hinweis:"Die Einzelpositionen des Honorarblocks müssen die Gesamthonorarsumme ergeben" }
  ];
  return { modul:"honorar", quartal, erzeugt:new Date().toISOString(), version:2,
    status: pruefungen.some(p=>p.ergebnis==="fehler") ? "unsicher" : "wartet",
    quelle:{ bsnr, hnr, seiten:pdf.numPages }, pruefungen,
    daten:{ gesamthonorar:gesamt, verrechnungen:verrech, schuldvortrag:schuld||0,
      restzahlung:rest, verwaltungskosten_pct: vk?zahl(vk[1]):null,
      verwaltungskosten: vk?zahl(vk[2]):null, positionen,
      nachberechnungen: positionen.filter(p=>p.nachberechnung) } };
}

/* =================================================================
   Honorarzusammenstellung
   Das ergiebigere Dokument: Fallzahlen je Kostenträger, Fallwert,
   Aufteilung nach Leistungsart und nach Betriebsstätte.
   Der Textfluss dieses Berichts ist vertauscht — die Zahlen stehen im
   Datenstrom vor ihrer Beschriftung. Gelesen wird deshalb zeilen- und
   spaltenweise über die Positionen, nie über den Textfluss.
   ================================================================= */
async function parseHonorarZusammenstellung(buffer){
  const pdf = await pdfjsLib.getDocument({data: buffer.slice(0)}).promise;
  const seite = async n => zeilen((await woerter(await pdf.getPage(n))).auf);

  const z1 = await seite(1);
  const t1 = z1.map(z => z.map(w=>w.text).join(" "));
  const finde = re => { for (const t of t1){ const m = t.match(re); if (m) return m; } return null; };

  const mq = finde(/Quartal\s+(\d)\/(\d{4})/);
  const quartal = mq ? mq[2]+"Q"+mq[1] : null;
  const mb = finde(/Betriebsst[äa]ttennummer\s+(\d{9})/);
  const paar = re => { const m = finde(re); return m ? {faelle:zahl(m[1]), honorar:zahl(m[2])} : null; };

  const ersatz = paar(/^Ersatzkassen\s+([\d.]+)\s+([\d.,]+)$/);
  const regio  = paar(/^Regionalkassen\s+([\d.]+)\s+([\d.,]+)$/);
  const gkv    = paar(/^Zwischenergebnis GKV\s+([\d.]+)\s+([\d.,]+)$/);
  const sonst  = paar(/^Sonstige Kostentr[äa]ger\s+([\d.]+)\s+([\d.,]+)$/);
  const gesamt = paar(/^Gesamtergebnis\s+([\d.]+)\s+([\d.,]+)$/);
  const mMit   = finde(/^F[äa]lle mit Honorar\s+([\d.]+)$/);
  const mFw    = finde(/^\*?Fallwert\s+([\d.,]+)$/);
  const faelleMitHonorar = mMit ? zahl(mMit[1]) : null;
  const fallwert = mFw ? zahl(mFw[1]) : null;

  /* Seite 2: Leistungsarten der Praxis insgesamt. Mehrzeilige
     Bezeichnungen laufen NACH der Zahlenzeile weiter und werden dort
     angehängt. */
  const leistungsarten = [], staetten = [];
  if (pdf.numPages >= 2){
    for (const z of await seite(2)){
      const roh = z.map(w=>w.text).join(" ");
      const mst = roh.match(/^davon f[üu]r (Neben)?[Bb]etriebsst[äa]tte (\d{9})\s+([\d.,]+)$/);
      if (mst){ staetten.push({ bsnr:mst[2], neben:!!mst[1], honorar:zahl(mst[3]) }); continue; }
      const werte = z.filter(w => w.x > 250 && NUM.test(w.text));
      if (werte.length === 4){
        const bez = z.filter(w => w.x <= 250).map(w=>w.text).join(" ").trim();
        if (!bez) continue;
        leistungsarten.push({ leistungsart:bez, ersatzkassen:zahl(werte[0].text),
          regionalkassen:zahl(werte[1].text), sonstige:zahl(werte[2].text),
          gesamt:zahl(werte[3].text) });
      } else if (leistungsarten.length && !werte.length
                 && /^[A-Za-zÄÖÜäöüß0-9(]/.test(roh)
                 && !/^(Leistungsart|Euro|Honorarzusammenstellung|Seite|Datum|Betriebsst|Quartal|LANR|\d{5} -)/.test(roh)){
        const l = leistungsarten[leistungsarten.length-1];
        if (l.leistungsart.length < 90) l.leistungsart = (l.leistungsart+" "+roh).trim();
      }
    }
  }
  const zGesamt = leistungsarten.find(l => /^Gesamt$/.test(l.leistungsart));
  const einzel  = leistungsarten.filter(l => !/^Gesamt$/.test(l.leistungsart));
  const summeEinzel = Math.round(einzel.reduce((a,l)=>a+l.gesamt,0)*100)/100;
  const fwGerechnet = (gesamt && faelleMitHonorar)
    ? Math.round(gesamt.honorar/faelleMitHonorar*100)/100 : null;
  const summeStaetten = Math.round(staetten.reduce((a,s)=>a+s.honorar,0)*100)/100;

  const pruefungen = [
    { name:"layout", ergebnis: (quartal && gesamt) ? "ok":"fehler",
      erwartet:"Quartal und Gesamtergebnis auf Seite 1",
      gefunden: (quartal||"kein Quartal")+", "+(gesamt?gesamt.faelle+" Fälle":"keine Fälle") },
    { name:"summenprobe_kostentraeger",
      ergebnis: (gkv && ersatz && regio && Math.abs(ersatz.faelle+regio.faelle-gkv.faelle)<1
                 && Math.abs(ersatz.honorar+regio.honorar-gkv.honorar)<=0.02) ? "ok":"fehler",
      erwartet:"Ersatzkassen + Regionalkassen = GKV",
      gefunden: (gkv&&ersatz&&regio) ? ersatz.faelle+"+"+regio.faelle+"="+gkv.faelle+" Fälle" : "nicht prüfbar" },
    { name:"fallwertprobe",
      ergebnis: (fallwert!=null && fwGerechnet!=null && Math.abs(fallwert-fwGerechnet)<=0.02) ? "ok":"fehler",
      erwartet: fallwert, gefunden: fwGerechnet,
      hinweis:"Gesamthonorar geteilt durch Fälle mit Honorar" },
    { name:"summenprobe_leistungsarten",
      ergebnis: (zGesamt && Math.abs(summeEinzel-zGesamt.gesamt)<=0.05) ? "ok":"fehler",
      erwartet: zGesamt?zGesamt.gesamt:null, gefunden: summeEinzel },
    { name:"summenprobe_betriebsstaetten",
      ergebnis: (staetten.length===2 && gesamt && Math.abs(summeStaetten-gesamt.honorar)<=0.05)
                ? "ok":"warnung",
      erwartet: gesamt?gesamt.honorar:null, gefunden: summeStaetten }
  ];
  return { modul:"honorarzusammenstellung", quartal, erzeugt:new Date().toISOString(), version:2,
    status: pruefungen.some(p=>p.ergebnis==="fehler") ? "unsicher" : "wartet",
    quelle:{ bsnr: mb?mb[1]:null, seiten:pdf.numPages }, pruefungen,
    daten:{ ersatzkassen:ersatz, regionalkassen:regio, gkv, sonstige:sonst, gesamt,
      faelle_mit_honorar:faelleMitHonorar, fallwert, fallwert_gerechnet:fwGerechnet,
      leistungsarten:einzel, betriebsstaetten:staetten } };
}

/* ----------------------------------------------------------------- */
async function parse(buffer){
  pruefeFassung();
  const typ = await erkenne(buffer);
  let d;
  if (typ === "HW0021") d = await parseHW0021(buffer);
  else if (typ === "HW0024") d = await parseHW0024(buffer);
  else if (typ === "antibiotika") d = await parseAntibiotika(buffer);
  else if (typ === "wsv") d = await parseWSV(buffer);
  else if (typ === "ssb") d = await parseSSB(buffer);
  else if (typ === "honorar") d = await parseHonorar(buffer);
  else if (typ === "honorarzusammenstellung") d = await parseHonorarZusammenstellung(buffer);
  else throw new Error("Diesen Bericht kenne ich nicht — bitte Fehlerdiagnose erzeugen und weitergeben.");

  /* An einer Stelle gestempelt, damit kein Parser es vergessen kann. */
  d.quelle = Object.assign({}, d.quelle, { parser: STAND, pdfjs: PDFJS_GEPRUEFT });
  return d;
}

global.KVB = { STAND, PDFJS_GEPRUEFT, pdfjsFassung, pruefeFassung,
               erkenne, quartal, kopfdaten, parse, parseHW0021, parseHW0024, parseAntibiotika, parseWSV, parseSSB,
               parseHonorar, parseHonorarZusammenstellung };
})(typeof window !== "undefined" ? window : globalThis);
