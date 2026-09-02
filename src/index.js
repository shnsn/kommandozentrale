/* ===================================================================
   index.js — die Endpunkte der Kommandozentrale

   Läuft bei Cloudflare, hinter Cloudflare Access. Access entscheidet,
   wer welchen Pfad überhaupt erreicht; dieser Code entscheidet, was
   auf dem erreichten Pfad passiert.

   Endpunkte nach ablage.md Abschnitt 3:
     GET  /api/upload      eigene Rolle (auch für Mitarbeiterinnen)
     POST /api/upload      Datei annehmen, nach roh/ legen  (beide Rollen)
     GET  /api/wartend     Liste der wartenden Vorgänge      (nur Inhaber)
     GET  /api/roh/<id>    das Original zum Parsen im Browser (nur Inhaber)
     POST /api/freigabe    übernehmen oder verwerfen          (nur Inhaber)
     GET  /api/stand       freigegebene Datenstände fürs Dashboard (nur Inhaber)
     GET  /api/selbsttest  Verbindungsprüfung                 (nur Inhaber)

   Datenformat: vertrag.md Version 2.
   =================================================================== */

const FORMATVERSION = 2;

/* Module nach vertrag.md Abschnitt 1 */
const MODULE = [
  "con", "ziffern", "leistungsgruppen", "wsv", "antibiotika",
  "ssb", "honorar", "honorarzusammenstellung", "dmp", "prognose"
];

/* Was KVB.erkenne() liefert -> welches Modul daraus wird.
   Sieben Berichtsarten, Stand parser-kvb.js vom 01.09.2026. */
const MODUL_ZU_TYP = {
  HW0021: "ziffern",
  HW0024: "leistungsgruppen",
  antibiotika: "antibiotika",
  wsv: "wsv",
  ssb: "ssb",
  honorar: "honorar",
  honorarzusammenstellung: "honorarzusammenstellung"
};

const QUARTAL_MUSTER = /^\d{4}Q[1-4]$/;
const KENNUNG_MUSTER = /^[a-z]+-(?:\d{4}Q[1-4]|offen)-[0-9a-f]{8}$/;

const MAX_BYTES = 20 * 1024 * 1024;

/* =================================================================
   Wer ist das?

   Access setzt bei jeder durchgelassenen Anfrage die angemeldete
   E-Mail-Adresse als Kopfzeile. Steht sie in der Inhaber-Liste, ist
   es die Rolle "freigabe", sonst "upload".

   Warum das trägt, obwohl es nur eine Kopfzeile ist: Wer sie fälschen
   wollte, müsste den Worker direkt erreichen — und davor sitzt Access.
   Ein Upload-Zugang bekommt die geschützten Pfade gar nicht geliefert.
   Access ist die Absicherung; diese Prüfung steuert das Verhalten.
   ================================================================= */

function inhaberListe(env) {
  return String(env.INHABER || "")
    .split(/[,;\s]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function identitaet(request, env) {
  const email = (request.headers.get("Cf-Access-Authenticated-User-Email") || "")
    .trim()
    .toLowerCase();
  const liste = inhaberListe(env);
  return {
    email,
    rolle: email && liste.includes(email) ? "freigabe" : "upload",
    listeGefuellt: liste.length > 0
  };
}

/* ================================================================= */

function json(daten, status = 200) {
  return new Response(JSON.stringify(daten, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function fehler(text, status) {
  return json({ fehler: text }, status);
}

async function pruefsumme(bytes) {
  const roh = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(roh)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function jetzt() {
  return new Date().toISOString();
}

/* Eine Zeile ins Protokoll. R2 kann nicht anhängen, also lesen und neu
   schreiben. Bei wenigen Vorgängen je Quartal ist das unproblematisch;
   bei zwei exakt gleichzeitigen Uploads könnte eine Zeile verloren gehen.
   Das Protokoll ist eine Nachvollziehbarkeitshilfe, keine Datenquelle —
   die Datenstände selbst liegen als eigene Objekte. */
async function protokoll(env, eintrag) {
  const jahr = new Date().getUTCFullYear();
  const schluessel = `protokoll/${jahr}.jsonl`;
  let bisher = "";
  try {
    const alt = await env.AUSWERTUNG.get(schluessel);
    if (alt) bisher = await alt.text();
  } catch (e) {
    /* Ein fehlgeschlagenes Protokoll darf den Vorgang nicht verhindern. */
  }
  try {
    await env.AUSWERTUNG.put(
      schluessel,
      bisher + JSON.stringify({ zeitpunkt: jetzt(), ...eintrag }) + "\n",
      { httpMetadata: { contentType: "application/x-ndjson" } }
    );
  } catch (e) {
    /* siehe oben */
  }
}

/* =================================================================
   POST /api/upload

   Nimmt genau eine Datei entgegen. Antwortet mit Dateiname, erkanntem
   Berichtstyp, erkanntem Quartal und Vorgangsnummer — sonst nichts.
   Keine Zahl aus dem Bericht, kein Datenstand, keine Fehlermeldung,
   die Inhalte verrät. Das gilt für beide Rollen gleichermaßen.
   ================================================================= */

async function upload(request, env, wer) {
  let formular;
  try {
    formular = await request.formData();
  } catch (e) {
    return fehler("Die Anfrage konnte nicht gelesen werden.", 400);
  }

  const datei = formular.get("datei");
  if (!datei || typeof datei.arrayBuffer !== "function") {
    return fehler("Keine Datei erhalten.", 400);
  }

  const typ = String(formular.get("typ") || "");
  const modul = MODUL_ZU_TYP[typ];
  if (!modul) {
    return fehler("Dieser Berichtstyp ist nicht bekannt.", 400);
  }

  const gemeldetesQuartal = String(formular.get("quartal") || "");
  const quartal = QUARTAL_MUSTER.test(gemeldetesQuartal) ? gemeldetesQuartal : "offen";

  const bytes = await datei.arrayBuffer();
  if (bytes.byteLength === 0) return fehler("Die Datei ist leer.", 400);
  if (bytes.byteLength > MAX_BYTES) return fehler("Die Datei ist zu groß.", 400);

  /* Ist es überhaupt ein PDF? Die ersten fünf Zeichen verraten es. */
  const kopf = new TextDecoder().decode(new Uint8Array(bytes, 0, 5));
  if (kopf !== "%PDF-") return fehler("Das ist keine PDF-Datei.", 400);

  const summe = await pruefsumme(bytes);
  const kurz = summe.slice(0, 8);
  const kennung = `${modul}-${quartal}-${kurz}`;

  /* Doppelupload: eine Marke je Prüfsumme, damit die Prüfung ein
     einzelner Zugriff bleibt und nicht das Durchsuchen der Ablage. */
  const marke = `pruefsummen/${summe}`;
  const schonDa = await env.AUSWERTUNG.head(marke);
  if (schonDa) {
    return json({
      dateiname: datei.name || null,
      berichtstyp: typ,
      quartal: quartal === "offen" ? null : quartal,
      vorgang: kennung,
      ergebnis: "bereits vorhanden"
    });
  }

  const zeitstempel = jetzt().replace(/[:.]/g, "-");
  const rohSchluessel = `roh/${quartal}/${modul}-${zeitstempel}-${kurz}.pdf`;

  await env.AUSWERTUNG.put(rohSchluessel, bytes, {
    httpMetadata: { contentType: "application/pdf" }
  });

  /* Der wartende Vorgang. Noch ohne "daten" — die entstehen erst beim
     Parsen im Browser der freigebenden Person (vertrag.md Abschnitt 2). */
  const vorgang = {
    kennung,
    modul,
    quartal: quartal === "offen" ? null : quartal,
    erzeugt: jetzt(),
    version: FORMATVERSION,
    status: "wartet",
    quelle: {
      dateiname: datei.name || null,
      pruefsumme: `sha256:${summe}`,
      hochgeladen_von: wer.email,
      hochgeladen_am: jetzt()
    },
    roh_schluessel: rohSchluessel,
    pruefungen: [],
    daten: {}
  };

  await env.AUSWERTUNG.put(`wartet/${kennung}.json`, JSON.stringify(vorgang, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });

  await env.AUSWERTUNG.put(marke, kennung);

  await protokoll(env, {
    vorgang: "hochgeladen",
    kennung,
    modul,
    quartal: vorgang.quartal,
    person: wer.email,
    dateiname: datei.name || null,
    pruefsumme: `sha256:${summe}`
  });

  return json({
    dateiname: datei.name || null,
    berichtstyp: typ,
    quartal: vorgang.quartal,
    vorgang: kennung,
    ergebnis: "angenommen"
  });
}

/* =================================================================
   GET /api/wartend — nur Inhaber
   ================================================================= */

async function wartend(env) {
  const liste = await env.AUSWERTUNG.list({ prefix: "wartet/", limit: 500 });
  const vorgaenge = [];
  for (const objekt of liste.objects) {
    const inhalt = await env.AUSWERTUNG.get(objekt.key);
    if (!inhalt) continue;
    try {
      vorgaenge.push(JSON.parse(await inhalt.text()));
    } catch (e) {
      vorgaenge.push({ fehlerhaft: objekt.key });
    }
  }
  vorgaenge.sort((a, b) =>
    String(b.quelle && b.quelle.hochgeladen_am).localeCompare(
      String(a.quelle && a.quelle.hochgeladen_am)
    )
  );
  return json({ anzahl: vorgaenge.length, vorgaenge });
}

/* =================================================================
   GET /api/roh/<kennung> — nur Inhaber
   Liefert das Original, damit der Parser im Browser darüber laufen kann.
   ================================================================= */

async function rohdatei(env, kennung) {
  if (!KENNUNG_MUSTER.test(kennung)) {
    return fehler("Ungültige Vorgangsnummer.", 400);
  }
  const eintrag = await env.AUSWERTUNG.get(`wartet/${kennung}.json`);
  if (!eintrag) return fehler("Diesen Vorgang gibt es nicht.", 404);

  let vorgang;
  try {
    vorgang = JSON.parse(await eintrag.text());
  } catch (e) {
    return fehler("Der Vorgang ist beschädigt.", 500);
  }

  const pdf = await env.AUSWERTUNG.get(vorgang.roh_schluessel);
  if (!pdf) return fehler("Die Originaldatei fehlt in der Ablage.", 404);

  return new Response(pdf.body, {
    headers: {
      "content-type": "application/pdf",
      "cache-control": "no-store"
    }
  });
}

/* =================================================================
   POST /api/freigabe — nur Inhaber

   Erwartet:
     { kennung, entscheidung: "uebernehmen" | "verwerfen",
       begruendung?, datenstand? }

   Bei "uebernehmen" wird der im Browser erzeugte Datenstand nach
   stand/ geschrieben. Bei "verwerfen" wird nur protokolliert.
   Das Original bleibt in beiden Fällen liegen (ablage.md Abschnitt 4).
   ================================================================= */

async function freigabe(request, env, wer) {
  let eingabe;
  try {
    eingabe = await request.json();
  } catch (e) {
    return fehler("Die Anfrage konnte nicht gelesen werden.", 400);
  }

  const kennung = String(eingabe.kennung || "");
  if (!KENNUNG_MUSTER.test(kennung)) {
    return fehler("Ungültige Vorgangsnummer.", 400);
  }

  const eintrag = await env.AUSWERTUNG.get(`wartet/${kennung}.json`);
  if (!eintrag) return fehler("Diesen Vorgang gibt es nicht mehr.", 404);
  const vorgang = JSON.parse(await eintrag.text());

  /* --- verwerfen ---------------------------------------------------- */
  if (eingabe.entscheidung === "verwerfen") {
    const begruendung = String(eingabe.begruendung || "").trim();
    if (!begruendung) {
      return fehler("Zum Verwerfen gehört eine Begründung.", 400);
    }
    await env.AUSWERTUNG.delete(`wartet/${kennung}.json`);
    await protokoll(env, {
      vorgang: "verworfen",
      kennung,
      modul: vorgang.modul,
      quartal: vorgang.quartal,
      person: wer.email,
      begruendung,
      pruefsumme: vorgang.quelle && vorgang.quelle.pruefsumme
    });
    return json({ ergebnis: "verworfen", vorgang: kennung });
  }

  if (eingabe.entscheidung !== "uebernehmen") {
    return fehler("Unbekannte Entscheidung.", 400);
  }

  /* --- übernehmen --------------------------------------------------- */
  const stand = eingabe.datenstand;
  if (!stand || typeof stand !== "object") {
    return fehler("Es wurde kein Datenstand mitgeschickt.", 400);
  }
  if (!MODULE.includes(stand.modul)) {
    return fehler("Unbekanntes Modul im Datenstand.", 400);
  }
  if (!QUARTAL_MUSTER.test(String(stand.quartal || ""))) {
    return fehler("Der Datenstand nennt kein gültiges Quartal.", 400);
  }
  if (stand.version !== FORMATVERSION) {
    return fehler(`Der Datenstand hat nicht Formatversion ${FORMATVERSION}.`, 400);
  }
  if (stand.modul !== vorgang.modul) {
    return fehler("Der Datenstand gehört zu einem anderen Bericht als der Vorgang.", 400);
  }

  /* Eine fehlgeschlagene Prüfung setzt den Status zwingend auf
     "unsicher" — vertrag.md Abschnitt 3. Das entscheidet der Server,
     nicht die Seite. */
  const pruefungen = Array.isArray(stand.pruefungen) ? stand.pruefungen : [];
  const unsicher = pruefungen.some(p => p && p.ergebnis === "fehler");

  const fertig = {
    ...stand,
    status: unsicher ? "unsicher" : "freigegeben",
    quelle: {
      ...(stand.quelle || {}),
      ...(vorgang.quelle || {}),
      freigegeben_von: wer.email,
      freigegeben_am: jetzt()
    },
    roh_schluessel: vorgang.roh_schluessel
  };

  const zielSchluessel = `stand/${fertig.modul}-${fertig.quartal}.json`;
  const vorhanden = await env.AUSWERTUNG.head(zielSchluessel);

  await env.AUSWERTUNG.put(zielSchluessel, JSON.stringify(fertig, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });
  await env.AUSWERTUNG.delete(`wartet/${kennung}.json`);

  await protokoll(env, {
    vorgang: vorhanden ? "ersetzt" : "freigegeben",
    kennung,
    modul: fertig.modul,
    quartal: fertig.quartal,
    status: fertig.status,
    person: wer.email,
    pruefsumme: fertig.quelle.pruefsumme
  });

  return json({
    ergebnis: vorhanden ? "ersetzt" : "freigegeben",
    status: fertig.status,
    modul: fertig.modul,
    quartal: fertig.quartal
  });
}

/* =================================================================
   GET /api/stand — nur Inhaber
   ================================================================= */

async function staende(env, url) {
  const quartal = url.searchParams.get("quartal");
  const liste = await env.AUSWERTUNG.list({ prefix: "stand/", limit: 1000 });
  const staende = [];
  for (const objekt of liste.objects) {
    if (quartal && !objekt.key.includes(quartal)) continue;
    const inhalt = await env.AUSWERTUNG.get(objekt.key);
    if (!inhalt) continue;
    try {
      staende.push(JSON.parse(await inhalt.text()));
    } catch (e) {
      /* Ein beschädigter Datenstand wird übergangen, nicht geraten. */
    }
  }
  return json({ anzahl: staende.length, staende });
}

/* =================================================================
   Verbindungsprüfung
   ================================================================= */

async function ablageErreichbar(bucket, name) {
  if (!bucket) {
    return { ablage: name, erreichbar: false, meldung: "Bindung fehlt." };
  }
  try {
    const liste = await bucket.list({ limit: 1 });
    return { ablage: name, erreichbar: true, objekte_gefunden: liste.objects.length };
  } catch (f) {
    return { ablage: name, erreichbar: false, meldung: String((f && f.message) || f) };
  }
}

/* ================================================================= */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pfad = url.pathname;

    if (!pfad.startsWith("/api/")) {
      return new Response("Diese Adresse gibt es nicht.", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    const wer = identitaet(request, env);
    const nurInhaber = () => wer.rolle === "freigabe";

    /* --- für beide Rollen erreichbar ------------------------------- */

    if (pfad === "/api/upload" && request.method === "GET") {
      return json({
        rolle: wer.rolle,
        angemeldet_als: wer.email || null,
        inhaberliste_hinterlegt: wer.listeGefuellt
      });
    }

    if (pfad === "/api/upload" && request.method === "POST") {
      if (!wer.email) return fehler("Nicht angemeldet.", 401);
      return upload(request, env, wer);
    }

    /* --- ab hier nur Praxisinhaber --------------------------------- */

    if (pfad === "/api/wartend" && request.method === "GET") {
      if (!nurInhaber()) return fehler("Nicht berechtigt.", 403);
      return wartend(env);
    }

    if (pfad.startsWith("/api/roh/") && request.method === "GET") {
      if (!nurInhaber()) return fehler("Nicht berechtigt.", 403);
      return rohdatei(env, decodeURIComponent(pfad.slice("/api/roh/".length)));
    }

    if (pfad === "/api/freigabe" && request.method === "POST") {
      if (!nurInhaber()) return fehler("Nicht berechtigt.", 403);
      return freigabe(request, env, wer);
    }

    if (pfad === "/api/stand" && request.method === "GET") {
      if (!nurInhaber()) return fehler("Nicht berechtigt.", 403);
      return staende(env, url);
    }

    if (pfad === "/api/selbsttest" && request.method === "GET") {
      if (!nurInhaber()) return fehler("Für diese Auskunft nicht berechtigt.", 403);
      const ablagen = [
        await ablageErreichbar(env.AUSWERTUNG, "kz-auswertung"),
        await ablageErreichbar(env.BETRIEB, "kz-betrieb")
      ];
      return json({
        angemeldet_als: wer.email,
        rolle: wer.rolle,
        inhaberliste_hinterlegt: wer.listeGefuellt,
        formatversion: FORMATVERSION,
        ablagen,
        alles_in_ordnung: wer.listeGefuellt && ablagen.every(a => a.erreichbar)
      });
    }

    return fehler("Diesen Endpunkt gibt es nicht.", 404);
  }
};
