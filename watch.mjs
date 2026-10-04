// Surveille le retour en stock de la Nintendo Switch 2 Édition 40e anniversaire Zelda (projet PERSO).
// Zéro IA, zéro dépendance. Alerte sur Discord via un webhook (secret DISCORD_WEBHOOK_STOCK).
//
// Usage :
//   node watch.mjs stock [--dry]   vérifie les revendeurs (toutes les 10 min)
//   node watch.mjs news  [--dry]   scanne les actus du jour (chaque matin)
//   node watch.mjs test            envoie un message de test sur Discord
//
// Sources du mode stock :
//   1. En direct, toutes les 10 min : Amazon FR, Amazon DE, E.Leclerc, Carrefour, Auchan.
//   2. Alert&Go, une fois par heure : page qui suit 11 revendeurs, mise à jour environ une fois
//      par jour. Elle couvre ceux qui bloquent les robots (Fnac, Cdiscount, Micromania, Cultura,
//      Boulanger, JoyBuy).
// Le Nintendo Store est derrière une file d'attente (queue-it) : on le couvre par les actus.
import { readFile, writeFile } from "node:fs/promises";

const PRODUIT = "Switch 2 Édition 40e anniversaire Zelda";
const PRIX_MAX = 600; // au-dessus = revendeur tiers (scalper), pas d'alerte
const ALERTETGO = "https://alertetgo.com/console-nintendo-switch-2-zelda-40e-anniversaire-switch-2/";
// Google Actualités n'accepte pas les parenthèses : une requête par angle, résultats fusionnés.
const NEWS = ['"Switch 2" Zelda stock', '"Switch 2" Zelda réassort', '"Switch 2" Zelda "40e anniversaire"', '"Switch 2" Zelda précommande']
  .map((q) => "https://news.google.com/rss/search?q=" + encodeURIComponent(q + " when:1d") + "&hl=fr&gl=FR&ceid=FR:fr");
// Un article compte s'il parle de la Switch 2, de Zelda et du stock dans son titre.
const MOTS_STOCK = /(r[ée]assort|stock|\bdrop\b|pr[ée]commande|disponible|rupture|restock)/i;
const REVENDEURS = ["Amazon DE", "Amazon", "Fnac", "E.Leclerc", "Cdiscount", "Carrefour", "Cultura", "Auchan", "Micromania", "Boulanger", "JoyBuy"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const AVEUGLE_MAX = 6; // 6 passages sans rien pouvoir lire (environ 1 h) -> on prévient

const args = process.argv.slice(2);
const mode = args[0];
const dry = args.includes("--dry");
const webhook = process.env.DISCORD_WEBHOOK_STOCK;

const loadJson = async (f, def) => { try { return JSON.parse(await readFile(f, "utf8")); } catch { return def; } };
const saveJson = (f, o) => writeFile(f, JSON.stringify(o, null, 2) + "\n");
const nowParis = () => new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date());
const prix = (s) => { const m = s?.match(/(\d[\d\s  ]*,\d{2})\s*€/); return m ? Number(m[1].replace(/[\s  ]/g, "").replace(",", ".")) : null; };

const HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Sec-Fetch-User": "?1",
  "sec-ch-ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"', "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"',
};

async function get(url) {
  const r = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(25000) });
  return { status: r.status, text: await r.text() };
}

async function discord(content, embed) {
  if (dry || !webhook) { console.log("[DISCORD" + (dry ? " dry" : " absent") + "]", content, embed ? JSON.stringify(embed, null, 2) : ""); if (!dry && !webhook) throw new Error("DISCORD_WEBHOOK_STOCK absent"); return; }
  const r = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "Stock Zelda", content, embeds: embed ? [embed] : [], allowed_mentions: { parse: ["everyone"] } }) });
  if (!r.ok) throw new Error(`Discord ${r.status} ${await r.text()}`);
}

// --- Source 1 : Alert&Go ---------------------------------------------------------------
async function lireAlertetgo() {
  const { status, text } = await get(ALERTETGO);
  if (status !== 200) return { ok: false, raison: `HTTP ${status}` };
  const plain = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const maj = plain.match(/mis à jour le (\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})/)?.[1] ?? null;
  const re = new RegExp(`(${REVENDEURS.map((r) => r.replace(".", "\\.")).join("|")}) (Non disponible|Disponible|En stock|Pr[ée]commande[^ ]*|Rupture[^ ]*)([^A-Z]{0,30})`, "g");
  const etats = {};
  for (const m of plain.matchAll(re)) {
    if (etats[m[1]]) continue;
    const libelle = m[2];
    const dispo = !/non disponible|rupture/i.test(libelle);
    etats[m[1]] = { dispo, libelle, prix: prix(m[3]) };
  }
  if (Object.keys(etats).length < 5) return { ok: false, raison: `structure changée (${Object.keys(etats).length} revendeurs lus)` };
  return { ok: true, maj, etats };
}

// --- Sources directes (toutes les 10 min) ----------------------------------------------
// Chaque fiche a un test "page valide" (on est bien sur la bonne fiche) et un test "rupture".
// Dispo = page valide ET plus de mention de rupture. Si la mention disparaît, on alerte :
// mieux vaut une fausse alerte de temps en temps qu'un réassort raté.
const DIRECTS = [
  { cle: "amazon-fr", nom: "Amazon FR", url: "https://www.amazon.fr/dp/B0F2TN43GH", amazon: true },
  { cle: "amazon-de", nom: "Amazon DE", url: "https://www.amazon.de/dp/B0F2TN43GH", amazon: true },
  { cle: "leclerc", nom: "E.Leclerc", url: "https://www.e.leclerc/fp/console-nintendo-switch-2-edition-40e-anniversaire-de-the-legend-of-zelda-nintendo-switch-2-0045496337292",
    valide: /<title>[^<]*Zelda/i, rupture: /pr[ée]commande [ée]puis[ée]e|[ée]puis[ée]/i },
  { cle: "carrefour", nom: "Carrefour", url: "https://www.carrefour.fr/p/s-3523670319052",
    valide: /<title>[^<]*Zelda/i, rupture: /Produit indisponible/i },
  { cle: "auchan", nom: "Auchan", url: "https://www.auchan.fr/nintendo-console-de-jeu-nintendo-switch-2-edition-zelda/pr-C1893413",
    valide: /<title>[^<]*Zelda/i, rupture: /"price":\s*null/ },
];

async function lireDirect(src) {
  let { status, text } = await get(src.url);
  // Amazon sert parfois un captcha aux serveurs : on retente 2 fois après une courte pause.
  for (let i = 0; src.amazon && i < 2 && /validateCaptcha|Saisissez les caractères|Geben Sie die Zeichen/i.test(text); i++) {
    await new Promise((r) => setTimeout(r, 3000));
    ({ status, text } = await get(src.url));
  }
  if (status !== 200) return { ok: false, raison: `HTTP ${status}` };
  if (src.amazon) {
    if (/validateCaptcha|Saisissez les caractères|Geben Sie die Zeichen/i.test(text)) return { ok: false, raison: "captcha" };
    if (!/B0F2TN43GH/.test(text)) return { ok: false, raison: "page inattendue" };
    const panier = /id="add-to-cart-button"|id="buy-now-button"/.test(text);
    const rupture = /id="outOfStock"/.test(text);
    const i = text.indexOf("corePrice");
    const p = i >= 0 ? prix(text.slice(i, i + 4000).match(/a-offscreen">([^<]+)</)?.[1]) : null;
    const dispo = panier && !rupture;
    if (dispo && p !== null && p > PRIX_MAX) return { ok: true, dispo: false, note: `revendeur tiers à ${p} €` };
    return { ok: true, dispo, prix: p };
  }
  if (!src.valide.test(text)) return { ok: false, raison: "page inattendue (bot bloqué ?)" };
  // On ne cherche la mention de rupture que dans la page sans scripts, pour éviter le bruit.
  const visible = src.cle === "auchan" ? text : text.replace(/<script[\s\S]*?<\/script>/gi, " ");
  return { ok: true, dispo: !src.rupture.test(visible), prix: null };
}

// --- Mode stock ------------------------------------------------------------------------
async function modeStock() {
  const st = await loadJson("state-stock.json", {});
  st.dispo ??= {}; st.dernierOk ??= {}; st.aveugle ??= 0;
  // Alert&Go ne change qu'une fois par jour : on le lit une fois par heure, pas toutes les 10 min.
  const lireAg = args.includes("--all") || new Date().getUTCMinutes() < 10 || !st.dernierOk.alertetgo;
  const resultats = await Promise.all(DIRECTS.map((s) => lireDirect(s).catch((e) => ({ ok: false, raison: e.message }))));
  const ag = lireAg ? await lireAlertetgo().catch((e) => ({ ok: false, raison: e.message })) : null;

  const actuel = {}; // clé -> {nom, url, prix} si dispo, null si en rupture. Absent si illisible.
  DIRECTS.forEach((s, i) => {
    const r = resultats[i];
    console.log(`${s.nom.padEnd(10)} ${JSON.stringify(r)}`);
    if (!r.ok) return;
    st.dernierOk[s.cle] = new Date().toISOString();
    actuel[s.cle] = r.dispo ? { nom: s.nom, url: s.url, prix: r.prix } : null;
  });
  if (ag) {
    console.log("Alert&Go  ", JSON.stringify(ag));
    if (ag.ok) {
      st.dernierOk.alertetgo = new Date().toISOString();
      st.majAlertetgo = ag.maj;
      for (const [rev, e] of Object.entries(ag.etats)) {
        actuel[`ag:${rev}`] = e.dispo && (e.prix === null || e.prix <= PRIX_MAX) ? { nom: `${rev} (via Alert&Go)`, url: ALERTETGO, prix: e.prix } : null;
      }
    }
  }

  const nouveaux = Object.entries(actuel).filter(([k, v]) => v && !st.dispo[k]);
  const finis = Object.keys(st.dispo).filter((k) => st.dispo[k] && k in actuel && !actuel[k]);

  if (nouveaux.length) {
    const lignes = nouveaux.map(([, v]) => `**[${v.nom}](${v.url})**${v.prix ? ` à ${String(v.prix).replace(".", ",")} €` : ""}`);
    await discord(`@everyone La ${PRODUIT} semble de retour en stock !`, {
      title: "Retour en stock, fonce !",
      description: lignes.join("\n") + `\n\n[Tous les revendeurs (Alert&Go)](${ALERTETGO})\n[Nintendo Store](https://store.nintendo.com/fr-fr/nintendo-switch-2-edition-40e-anniversaire-de-the-legend-of-zelda-P00211)`,
      color: 0x2ecc71, footer: { text: `Vérifié le ${nowParis()}. Le script voit que la mention « rupture » a disparu : vérifie vite sur la fiche.` },
    });
  }
  if (finis.length) {
    await discord("", { title: "De nouveau en rupture", description: finis.map((k) => k.replace(/^ag:/, "")).join(", "), color: 0x95a5a6, footer: { text: nowParis() } });
  }
  for (const [k, v] of Object.entries(actuel)) st.dispo[k] = !!v;

  // Sonde aveugle : aucune source directe lisible.
  if (resultats.every((r) => !r.ok)) {
    st.aveugle += 1;
    if (st.aveugle === AVEUGLE_MAX) {
      await discord("", { title: "La surveillance ne voit plus rien", description: `Depuis environ 1 h, aucun revendeur ne se lit.\n${DIRECTS.map((s, i) => `${s.nom} : ${resultats[i].raison}`).join("\n")}\nTant que ça dure, tu ne seras pas prévenu.`, color: 0xe67e22 });
    }
  } else {
    if (st.aveugle >= AVEUGLE_MAX) await discord("", { title: "La surveillance voit de nouveau", description: "Au moins un revendeur se relit.", color: 0x3498db });
    st.aveugle = 0;
  }

  st.dernierPassage = new Date().toISOString().slice(0, 10); // 1 commit par jour minimum : garde le cron actif
  await saveJson("state-stock.json", st);
}

// --- Mode actus (chaque matin) ---------------------------------------------------------
// Envoie toujours un message : les actus du jour sur le stock (ou « rien de neuf ») et l'état
// des sources. Ce message quotidien prouve aussi que la surveillance tourne.
async function modeNews() {
  const st = await loadJson("state-news.json", { vus: [] });
  const items = [];
  for (const url of NEWS) {
    const { status, text } = await get(url);
    if (status !== 200) { console.log("Google Actualités HTTP", status); continue; }
    for (const [, it] of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const titre = (it.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      const lien = it.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "";
      if (!items.some((x) => x.lien === lien)) items.push({ titre, lien });
    }
  }
  const pertinents = items.filter((i) => /switch\s*2/i.test(i.titre) && /zelda/i.test(i.titre) && MOTS_STOCK.test(i.titre) && !st.vus.includes(i.lien));
  console.log(`${items.length} articles, ${pertinents.length} nouveaux sur le stock`);

  const stock = await loadJson("state-stock.json", { dernierOk: {}, dispo: {} });
  const noms = { "amazon-fr": "Amazon FR", "amazon-de": "Amazon DE", leclerc: "E.Leclerc", carrefour: "Carrefour", auchan: "Auchan", alertetgo: "Alert&Go" };
  const fmt = (t) => new Date(t).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" });
  const sondes = Object.entries(noms).map(([k, n]) => {
    const t = stock.dernierOk?.[k];
    const frais = t && Date.now() - Date.parse(t) < 3 * 3.6e6;
    return `${frais ? "OK" : "aveugle"} : ${n}${!frais && t ? ` (dernière lecture le ${fmt(t)})` : ""}`;
  });
  const dispoNow = Object.entries(stock.dispo ?? {}).filter(([, v]) => v).map(([k]) => k.replace(/^ag:/, ""));
  const actus = pertinents.length
    ? pertinents.slice(0, 8).map((i) => `- [${i.titre.slice(0, 180)}](${i.lien})`).join("\n")
    : "Rien de neuf sur le stock dans les actus des dernières 24 h.";

  await discord("", {
    title: "Le point du matin : Switch 2 Zelda",
    description: `**Actus**\n${actus}\n\n**En stock en ce moment** : ${dispoNow.length ? dispoNow.join(", ") : "nulle part"}\n\n**Sources**\n${sondes.join("\n")}${stock.majAlertetgo ? `\nAlert&Go mis à jour le ${stock.majAlertetgo}` : ""}`,
    color: pertinents.length ? 0x3498db : 0x95a5a6, footer: { text: nowParis() },
  });
  st.vus = [...pertinents.map((i) => i.lien), ...st.vus].slice(0, 300);
  st.dernierScan = new Date().toISOString().slice(0, 10);
  await saveJson("state-news.json", st);
}

if (mode === "stock") await modeStock();
else if (mode === "news") await modeNews();
else if (mode === "test") await discord("Test : la surveillance du stock Zelda est branchée. Tu recevras un @everyone ici dès qu'un revendeur a la console.", null);
else { console.error("Mode attendu : stock | news | test"); process.exit(2); }
