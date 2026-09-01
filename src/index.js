/* ===================================================================
   index.js — die Endpunkte der Kommandozentrale

   Läuft bei Cloudflare, hinter Cloudflare Access. Access entscheidet,
   wer welchen Pfad überhaupt erreicht; dieser Code entscheidet, was
   auf dem erreichten Pfad passiert.

   Aufbaustand: Rollenerkennung und Selbsttest der Ablagen.
   Die Endpunkte aus ablage.md Abschnitt 3 kommen im nächsten Schritt.
   =================================================================== */

/* --- Wer ist das? ---------------------------------------------------

   Access setzt bei jeder durchgelassenen Anfrage die angemeldete
   E-Mail-Adresse als Kopfzeile. Steht sie in der Inhaber-Liste, ist es
   die Rolle "freigabe", sonst "upload".

   Warum das sicher ist, obwohl es nur eine Kopfzeile ist: Wer diese
   Kopfzeile fälschen wollte, müsste den Worker direkt erreichen —
   und davor sitzt Access. Ein Upload-Zugang bekommt die geschützten
   Pfade gar nicht erst geliefert. Die eigentliche Absicherung ist
   Access; diese Prüfung hier steuert nur, was die Seite anzeigt.
   -------------------------------------------------------------------- */

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
  const rolle = email && liste.includes(email) ? "freigabe" : "upload";
  return { email, rolle, listeGefuellt: liste.length > 0 };
}

/* --- Antworten ---------------------------------------------------- */

function json(daten, status = 200) {
  return new Response(JSON.stringify(daten, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

/* --- Ist eine Ablage erreichbar? ----------------------------------- */

async function ablageErreichbar(bucket, name) {
  if (!bucket) {
    return {
      ablage: name,
      erreichbar: false,
      meldung: "Keine Verbindung eingerichtet — Bindung fehlt in wrangler.jsonc oder Bucket existiert nicht."
    };
  }
  try {
    const liste = await bucket.list({ limit: 1 });
    return {
      ablage: name,
      erreichbar: true,
      objekte_gefunden: liste.objects.length
    };
  } catch (fehler) {
    return {
      ablage: name,
      erreichbar: false,
      meldung: String((fehler && fehler.message) || fehler)
    };
  }
}

/* =================================================================== */

export default {
  async fetch(request, env) {
    const pfad = new URL(request.url).pathname;

    /* Alles, was keine Seite und kein Endpunkt ist */
    if (!pfad.startsWith("/api/")) {
      return new Response("Diese Adresse gibt es nicht.", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    const { email, rolle, listeGefuellt } = identitaet(request, env);

    /* ---------------------------------------------------------------
       GET /api/upload — welche Rolle hat die angemeldete Person?

       Liegt bewusst auf demselben Pfad wie der Upload selbst, weil nur
       dieser Pfad für Mitarbeiterinnen freigegeben ist. Die Antwort
       enthält nichts als die eigene Rolle und die eigene Adresse —
       keine Zahl, keinen Datenstand, keine Liste anderer Personen.
       --------------------------------------------------------------- */
    if (pfad === "/api/upload" && request.method === "GET") {
      return json({
        rolle,
        angemeldet_als: email || null,
        inhaberliste_hinterlegt: listeGefuellt
      });
    }

    /* ---------------------------------------------------------------
       GET /api/selbsttest — nur für Praxisinhaber.
       Prüft, ob der Worker beide Ablagen erreicht.
       --------------------------------------------------------------- */
    if (pfad === "/api/selbsttest" && request.method === "GET") {
      if (rolle !== "freigabe") {
        return json({ fehler: "Für diese Auskunft nicht berechtigt." }, 403);
      }
      const ablagen = [
        await ablageErreichbar(env.AUSWERTUNG, "kz-auswertung"),
        await ablageErreichbar(env.BETRIEB, "kz-betrieb")
      ];
      return json({
        angemeldet_als: email,
        rolle,
        inhaberliste_hinterlegt: listeGefuellt,
        ablagen,
        alles_in_ordnung: listeGefuellt && ablagen.every(a => a.erreichbar)
      });
    }

    /* --------------------------------------------------------------- */
    return json({ fehler: "Diesen Endpunkt gibt es nicht." }, 404);
  }
};
