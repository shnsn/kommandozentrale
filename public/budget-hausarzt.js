/* ===================================================================
   budget-hausarzt.js — Fällt eine Ziffer unter die Obergrenze?

   Quelle: Honorarverteilungsmaßstab der KVB, Fassung gültig ab
   01.01.2020 i.d.F. der Änderungen ab 01.10.2022.
     · Anlage 2, Abschnitt hausärztliche Versorgung — Zuordnung der QZV
     · Nr. 7.1.2 — Umfang der Obergrenze
     · Nr. 3 und Nr. 5.1 — Vorwegabzüge im hausärztlichen Bereich

   Zwei Dinge aus Nr. 7.1.2 und 7.1.3, die man wissen muss:

   1. Der Obergrenze unterliegen ALLE Leistungen — außer den dort unter
      a) bis d) genannten Ausnahmen. Es ist also keine Liste dessen, was
      budgetiert ist, sondern eine Liste dessen, was es nicht ist.

   2. RLV und QZV sind EIN gemeinsamer Topf: "sofern das RLV einer
      Arztpraxis nicht ausgeschöpft ist, kann das noch zur Verfügung
      stehende Honorarvolumen mit Leistungen aus den QZV ausgefüllt
      werden und umgekehrt" (Nr. 7.1.3). Für die Frage, ob Nachholen
      Geld bringt, ist die Unterscheidung RLV/QZV deshalb belanglos.
      Entscheidend ist allein: innerhalb oder außerhalb der Obergrenze.

   Was diese Datei NICHT leisten kann: Ausnahme a) in Nr. 7.1.2 sind
   die Leistungen außerhalb der Gesamtvergütung — Impfungen,
   Früherkennung, DMP und anderes. Die stehen nicht im HVM, sondern in
   den Gesamtverträgen. Ziffern, die weder als Vorwegabzug noch als QZV
   erkannt werden, bleiben deshalb "offen": Sie können im RLV liegen
   (budgetiert) oder außerhalb der Gesamtvergütung (frei).
   =================================================================== */

const BUDGET_STAND = "HVM der KVB, Fassung 01.10.2022";

/* Innerhalb der Obergrenze: die QZV nach Anlage 2. */
const QZV_HAUSARZT = {
 "01100": "Besondere Inanspruchnahme",
 "01101": "Besondere Inanspruchnahme",
 "01102": "Besondere Inanspruchnahme",
 "02300": "Kleinchirurgie",
 "02301": "Kleinchirurgie",
 "02302": "Kleinchirurgie",
 "02310": "Kleinchirurgie",
 "02311": "Behandlung des diabetischen Fußes",
 "03241": "Langzeit-EKG",
 "03321": "Ergometrie",
 "03322": "Langzeit-EKG",
 "03324": "Langzeit-Blutdruckmessung",
 "03330": "Spirometrie",
 "03331": "Proktologie Hausärzte",
 "30100": "Allergologie",
 "30110": "Allergologie",
 "30111": "Allergologie",
 "30120": "Allergologie",
 "30121": "Allergologie",
 "30122": "Allergologie",
 "30123": "Allergologie",
 "30130": "Hyposensibilisierungsbehandlung",
 "30131": "Hyposensibilisierungsbehandlung",
 "30200": "Chirotherapie",
 "30201": "Chirotherapie",
 "30400": "Physikalische Therapie",
 "30401": "Physikalische Therapie",
 "30402": "Physikalische Therapie",
 "30410": "Physikalische Therapie",
 "30411": "Physikalische Therapie",
 "30420": "Physikalische Therapie",
 "30421": "Physikalische Therapie",
 "30500": "Phlebologie",
 "30501": "Phlebologie",
 "30600": "Proktologie Hausärzte",
 "30601": "Proktologie Hausärzte",
 "30610": "Behandlung von Hämorrhoiden",
 "30611": "Behandlung von Hämorrhoiden",
 "30710": "Schmerztherapeutische spezielle Behandlung",
 "30712": "Schmerztherapeutische spezielle Behandlung",
 "30720": "Schmerztherapeutische spezielle Behandlung",
 "30721": "Schmerztherapeutische spezielle Behandlung",
 "30722": "Schmerztherapeutische spezielle Behandlung",
 "30723": "Schmerztherapeutische spezielle Behandlung",
 "30724": "Schmerztherapeutische spezielle Behandlung",
 "30730": "Schmerztherapeutische spezielle Behandlung",
 "30731": "Schmerztherapeutische spezielle Behandlung",
 "30740": "Schmerztherapeutische spezielle Behandlung",
 "30750": "Schmerztherapeutische spezielle Behandlung",
 "30751": "Schmerztherapeutische spezielle Behandlung",
 "30760": "Schmerztherapeutische spezielle Behandlung",
 "30790": "Akupunktur",
 "30791": "Akupunktur",
 "30900": "Kardiorespiratorische Polygraphie",
 "33010": "Sonographie Ia",
 "33011": "Sonographie Ia",
 "33012": "Sonographie Ia",
 "33042": "Sonographie Ia",
 "33043": "Sonographie Ia",
 "33044": "Sonographie Ia",
 "33046": "Sonographie Ia",
 "33050": "Sonographie Ia",
 "33052": "Sonographie Ia",
 "33060": "Sonographie III Hausärzte",
 "33061": "Sonographie III Hausärzte",
 "33062": "Sonographie III Hausärzte",
 "33080": "Sonographie Ia",
 "33081": "Sonographie Ia",
 "33090": "Sonographie Ia",
 "33091": "Sonographie Ia",
 "33092": "Sonographie Ia",
 "35100": "Psychosomatische Grundversorgung, Übende Verfahren",
 "35110": "Psychosomatische Grundversorgung, Übende Verfahren",
 "35111": "Psychosomatische Grundversorgung, Übende Verfahren",
 "35112": "Psychosomatische Grundversorgung, Übende Verfahren",
 "35113": "Psychosomatische Grundversorgung, Übende Verfahren",
 "35120": "Psychosomatische Grundversorgung, Übende Verfahren",
 "35130": "Richtlinienpsychotherapie I, probatorische Sitzung",
 "35131": "Richtlinienpsychotherapie I, probatorische Sitzung",
 "35140": "Richtlinienpsychotherapie I, probatorische Sitzung",
 "35141": "Richtlinienpsychotherapie I, probatorische Sitzung",
 "35142": "Richtlinienpsychotherapie I, probatorische Sitzung",
 "35150": "Richtlinienpsychotherapie I, probatorische Sitzung",
 "35163": "Richtlinienpsychotherapie I, probatorische Sitzung",
 "35164": "Richtlinienpsychotherapie I, probatorische Sitzung",
 "35165": "Richtlinienpsychotherapie I, probatorische Sitzung",
 "35166": "Richtlinienpsychotherapie I, probatorische Sitzung",
 "35167": "Richtlinienpsychotherapie I, probatorische Sitzung",
 "35168": "Richtlinienpsychotherapie I, probatorische Sitzung",
 "35169": "Richtlinienpsychotherapie I, probatorische Sitzung"
};

/* Außerhalb der Obergrenze: Vorwegabzüge nach Nr. 3 und Nr. 5.1. */
const VORWEGABZUG = [
  { treffer: g => /^40\d{3}$/.test(g),
    grund: "Kostenpauschale Kapitel 40 — Vorwegabzug 5.1.2" },
  { treffer: g => ["01699","38100","38105"].includes(g),
    grund: "Vorwegabzug 5.1.2" },
  { treffer: g => /^97009[AB]?$/.test(g),
    grund: "Sicherstellungszuschlag — Vorwegabzug 5.1.5" },
  { treffer: g => /^0306[0-5]$/.test(g),
    grund: "ärztlich angeordnete Hilfeleistung — Vorwegabzug 5.1.6" },
  { treffer: g => g === "03362",
    grund: "hausärztlich-geriatrischer Betreuungskomplex — Vorwegabzug 5.1.6" },
  { treffer: g => g === "04355",
    grund: "Vorwegabzug 5.1.6" },
  { treffer: g => /^32\d{3}$/.test(g),
    grund: "Laboratoriumsmedizin — Vorwegabzug 3.1 und 5.1.7" }
];

/* Buchstabensuffixe der KVB (03220H, 01746M …) gehören zur Stammziffer.
   Das ist eine Annahme, keine Regel aus dem HVM. */
const stamm = g => String(g).replace(/[A-Z]+$/, "");

/* Liefert { lage, grund }.
   lage: "innerhalb" — budgetiert, Nachholen bringt nichts
         "ausserhalb" — Vorwegabzug, wird unabhängig vergütet
         "offen"      — nicht bestimmbar (RLV oder außerhalb der MGV) */
function budgetLage(gop){
  const g = stamm(gop);
  const q = QZV_HAUSARZT[g];
  if (q) return { lage:"innerhalb", grund:"Zusatzvolumen „" + q + "“ (Anlage 2)" };
  for (const v of VORWEGABZUG)
    if (v.treffer(String(gop)) || v.treffer(g)) return { lage:"ausserhalb", grund:v.grund };
  return { lage:"offen", grund:"weder Vorwegabzug noch Zusatzvolumen — RLV oder außerhalb der Gesamtvergütung" };
}
