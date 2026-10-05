// ============================================================
// GESTEST — CLOUD FUNCTIONS
//
// Perché esistono: prima, quiz.html scaricava nel browser di
// chiunque visitasse la pagina l'elenco completo degli allievi, il
// PIN in chiaro e le domande con la risposta corretta già segnata,
// perché tutto il controllo (PIN giusto? risposta esatta? nome
// nell'elenco?) avveniva lato client, contro un database con lettura
// pubblica. Qui invece questi tre controlli li fa il server: il
// browser non riceve mai l'elenco intero, il PIN vero, o quale
// opzione sia quella giusta.
//
// Tre funzioni pubbliche (chiamabili da chiunque, ma senza mai
// restituire più dati del necessario):
//   - cercaAllievi   : autocompletamento, restituisce solo le
//                      corrispondenze al pezzo di nome digitato
//   - iniziaTest     : verifica nome/PERID/PIN/assenza di un
//                      tentativo già fatto, poi restituisce le
//                      domande SENZA la risposta corretta
//   - inviaRisultato : riceve le risposte scelte, ricalcola lui
//                      stesso il punteggio confrontando con i dati
//                      veri (mai fidandosi di un punteggio mandato
//                      dal client), e salva il risultato
// ============================================================

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2/options");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

admin.initializeApp();
const db = getFirestore();

// Regione più vicina all'Italia, e un limite di istanze basso: i
// volumi di questo sistema sono poche centinaia di chiamate a
// sessione, non serve scalare oltre.
setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

// ------------------------------------------------------------
// UTILITY, le stesse regole di normalizzazione già usate nel quiz
// ------------------------------------------------------------
function normalizza(testo) {
  return (testo || "").toString().trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}
function nomeSenzaPerid(nome) {
  return (nome || "").replace(/\s*\(\d+\)\s*$/, "").trim();
}
function peridDiNome(nome) {
  const corrispondenza = (nome || "").match(/\((\d+)\)\s*$/);
  return corrispondenza ? corrispondenza[1] : "";
}

// Legge il test attualmente attivo, usando l'SDK admin (non
// soggetto alle regole di sicurezza). Il documento è diviso in due
// per sicurezza fin dal progetto: "test/{id}" con solo i campi
// pubblici (nome, durata, stato del turno...), e
// "test/{id}/privato/dati" con PIN, domande e l'elenco allievi
// completo, mai leggibile dal pubblico. Qui li unisco solo per uso
// interno della funzione.
async function leggiTestAttivo() {
  const puntatore = await db.doc("stato/attivo").get();
  const idTest = puntatore.exists ? puntatore.data().idTest : null;
  if (!idTest) return null;

  const [pubblico, privato] = await Promise.all([
    db.doc("test/" + idTest).get(),
    db.doc("test/" + idTest + "/privato/dati").get()
  ]);
  if (!pubblico.exists || pubblico.data().attivo !== true) return null;
  if (!privato.exists) return null;

  return { id: idTest, dati: { ...pubblico.data(), ...privato.data() } };
}

// ============================================================
// CERCA ALLIEVI — autocompletamento
// Riceve solo il pezzo di testo digitato finora, restituisce al
// massimo 8 nominativi corrispondenti. Il browser non vede mai
// l'elenco intero.
// ============================================================
exports.cercaAllievi = onCall(async (richiesta) => {
  const testoDigitato = normalizza(richiesta.data && richiesta.data.testo);
  if (testoDigitato.length < 2) return { corrispondenze: [] };

  const attivo = await leggiTestAttivo();
  if (!attivo) return { corrispondenze: [] };

  const studenti = attivo.dati.studenti || [];
  const corrispondenze = studenti
    .filter(nome => normalizza(nomeSenzaPerid(nome)).includes(testoDigitato))
    .slice(0, 8);

  return { corrispondenze };
});

// ============================================================
// INIZIA TEST — verifica identità e PIN, consegna le domande
// SENZA la risposta corretta.
// ============================================================
exports.iniziaTest = onCall(async (richiesta) => {
  const dati = richiesta.data || {};
  const nomeCompleto = (dati.nomeCompleto || "").toString();
  const peridInserito = (dati.perid || "").toString().trim();
  const pinInserito = (dati.pin || "").toString().trim();

  const attivo = await leggiTestAttivo();
  if (!attivo) {
    throw new HttpsError("failed-precondition", "Al momento non risulta nessun test attivo.");
  }
  const t = attivo.dati;

  if (t.avviatoTimestamp) {
    throw new HttpsError("failed-precondition", "Il test è già iniziato per tutti gli altri allievi. Non è più possibile accedere.");
  }

  const studenti = t.studenti || [];
  const nominativoTrovato = studenti.find(n => normalizza(nomeSenzaPerid(n)) === normalizza(nomeSenzaPerid(nomeCompleto)));
  if (!nominativoTrovato) {
    throw new HttpsError("not-found", "Nome non trovato nell'elenco.");
  }

  const testHaPerid = studenti.length > 0 && studenti.every(n => /\(\d+\)\s*$/.test(n));
  if (testHaPerid) {
    const peridAtteso = peridDiNome(nominativoTrovato);
    if (!peridAtteso || peridInserito !== peridAtteso) {
      throw new HttpsError("permission-denied", "Il PERID inserito non corrisponde al nominativo scelto.");
    }
  }

  if (pinInserito !== String(t.pin || "").trim()) {
    throw new HttpsError("permission-denied", "PIN non corretto.");
  }

  const assenti = new Set((t.assenti || []).map(normalizza));
  if (assenti.has(normalizza(nominativoTrovato))) {
    throw new HttpsError("permission-denied", "Risulti segnato come assente per questa sessione.");
  }

  const istantaneaRisultati = await db.collection("test/" + attivo.id + "/risultati")
    .where("nome", "==", nominativoTrovato)
    .where("annullato", "==", false)
    .get();
  if (!istantaneaRisultati.empty) {
    throw new HttpsError("already-exists", "Risulta che questo nominativo ha già completato il test in precedenza.");
  }

  // Le domande vanno al client SENZA il campo "corretta": ogni
  // opzione porta solo un indice di posizione, che il client userà
  // per dire quale ha scelto, non per sapere quale sia giusta.
  const domande = (t.domande || []).map(d => ({
    id: d.id,
    testo: d.testo,
    opzioni: (d.opzioni || []).map((testoOpzione, indice) => ({ indice, testo: testoOpzione }))
  }));

  return {
    idTest: attivo.id,
    nomeCompleto: nominativoTrovato,
    durataMinuti: t.durataMinuti || 0,
    domande
  };
});

// ============================================================
// INVIA RISULTATO — ricalcola il punteggio lato server, non si
// fida di nessun punteggio mandato dal client. Stessa identica
// logica anti-doppio-invio di prima (scrittura solo in creazione,
// un secondo invio sulla stessa chiave viene rifiutato), ma qui
// dentro una funzione, con un controllo esplicito in più prima di
// scrivere.
// ============================================================
exports.inviaRisultato = onCall(async (richiesta) => {
  const dati = richiesta.data || {};
  const nomeCompleto = (dati.nomeCompleto || "").toString();
  const peridInserito = (dati.perid || "").toString().trim();
  const pinInserito = (dati.pin || "").toString().trim();
  const risposteInviate = Array.isArray(dati.risposte) ? dati.risposte : [];
  const scadutoPerTempo = !!dati.scadutoPerTempo;
  const usciteFocus = Number.isFinite(dati.usciteFocus) ? dati.usciteFocus : 0;
  const tempoFuoriFocusMs = Number.isFinite(dati.tempoFuoriFocusMs) ? dati.tempoFuoriFocusMs : 0;

  const attivo = await leggiTestAttivo();
  if (!attivo) {
    throw new HttpsError("failed-precondition", "Nessun test attivo.");
  }
  const t = attivo.dati;

  const studenti = t.studenti || [];
  const nominativoTrovato = studenti.find(n => normalizza(nomeSenzaPerid(n)) === normalizza(nomeSenzaPerid(nomeCompleto)));
  if (!nominativoTrovato) {
    throw new HttpsError("not-found", "Nome non trovato nell'elenco.");
  }
  const testHaPerid = studenti.length > 0 && studenti.every(n => /\(\d+\)\s*$/.test(n));
  if (testHaPerid) {
    const peridAtteso = peridDiNome(nominativoTrovato);
    if (!peridAtteso || peridInserito !== peridAtteso) {
      throw new HttpsError("permission-denied", "PERID non corrispondente.");
    }
  }
  if (pinInserito !== String(t.pin || "").trim()) {
    throw new HttpsError("permission-denied", "PIN non corretto.");
  }

  const domande = t.domande || [];
  const mappaDomande = new Map(domande.map(d => [d.id, d]));

  let punteggio = 0;
  const risposteSalvate = risposteInviate.map(r => {
    const domanda = mappaDomande.get(r.domandaId);
    if (!domanda) return { id: r.domandaId, testo: "", risposta: "", corretta: "NO" };
    const opzioneScelta = Number.isInteger(r.opzioneScelta) ? r.opzioneScelta : -1;
    const testoScelto = (opzioneScelta >= 0 && domanda.opzioni[opzioneScelta]) ? domanda.opzioni[opzioneScelta] : "";
    const corretta = opzioneScelta === domanda.corretta;
    if (corretta) punteggio++;
    return { id: domanda.id, testo: domanda.testo, risposta: testoScelto, corretta: corretta ? "SI" : "NO" };
  });

  const numeroSessione = (t.azzeramenti || 0) + 1;
  const nomeNormalizzato = normalizza(nominativoTrovato);
  const collezioneRisultati = db.collection("test/" + attivo.id + "/risultati");

  // Transazione: leggo quanti tentativi esistono già per questo nome
  // e scrivo il nuovo nella stessa operazione atomica, così due invii
  // arrivati nello stesso istante non possono mai ottenere lo stesso
  // numero di tentativo o sovrascriversi a vicenda.
  const risultato = await db.runTransaction(async (transazione) => {
    const esistenti = await transazione.get(
      collezioneRisultati.where("nome", "==", nominativoTrovato)
    );
    const numeroTentativo = esistenti.size + 1;
    const chiave = numeroTentativo === 1 ? nomeNormalizzato : nomeNormalizzato + "__t" + numeroTentativo;
    const riferimento = collezioneRisultati.doc(chiave);

    const giaEsistente = await transazione.get(riferimento);
    if (giaEsistente.exists) {
      throw new HttpsError("already-exists", "Risultato già inviato in precedenza.");
    }

    const payload = {
      nome: nominativoTrovato,
      timestamp: new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" }),
      punteggio,
      totaleDomande: domande.length,
      scadutoPerTempo: scadutoPerTempo ? "SI" : "NO",
      risposte: risposteSalvate,
      annullato: false,
      numeroTentativo,
      usciteFocus,
      tempoFuoriFocusMs,
      numeroSessione
    };
    transazione.set(riferimento, payload);
    // Contatori pubblici, solo numeri: servono alla locandina, che non
    // può leggere i risultati veri (nomi, punteggi, risposte).
    transazione.update(db.doc("test/" + attivo.id), {
      completatiTotali: FieldValue.increment(1),
      completatiSessione: FieldValue.increment(1)
    });
    return payload;
  });

  return { punteggio: risultato.punteggio, totaleDomande: risultato.totaleDomande };
});

// ============================================================
// CHIUDI TURNO: si attiva da sola quando "terminatoTimestamp" viene
// scritto su un test (da admin, locandina o live, con "Termina
// manualmente" o con la chiusura automatica quando hanno consegnato
// tutti). Gira sul server, quindi la pulizia arriva sempre fino in
// fondo anche se la pagina da cui è partita la chiusura viene chiusa.
// ============================================================
const SOGLIA_CONNESSIONE_MS_TURNO = 180000;
const MASSIMO_TENTATIVI_ATTESA = 36; // 36 x 5s = 3 minuti di attesa massima

function attendi(ms) {
  return new Promise(risolvi => setTimeout(risolvi, ms));
}

async function contaInSvolgimento(riferimentoPresenze) {
  const istantanea = await riferimentoPresenze.get();
  const ora = Date.now();
  let numero = 0;
  istantanea.forEach(documento => {
    const dati = documento.data();
    const fresco = dati.ultimoAggiornamento && (ora - Number(dati.ultimoAggiornamento)) <= SOGLIA_CONNESSIONE_MS_TURNO;
    if (fresco && dati.stato === "in_corso") numero++;
  });
  return numero;
}

exports.chiudiTurno = onDocumentUpdated({ document: "test/{idTest}", timeoutSeconds: 300 }, async (evento) => {
  const prima = evento.data.before.data();
  const dopo = evento.data.after.data();

  // Solo nell'istante in cui "terminatoTimestamp" passa da vuoto a
  // valorizzato, mai sugli aggiornamenti successivi.
  if (prima.terminatoTimestamp || !dopo.terminatoTimestamp) return;

  const idTest = evento.params.idTest;
  const riferimentoTest = db.doc("test/" + idTest);
  const riferimentoPrivato = db.doc("test/" + idTest + "/privato/dati");
  const riferimentoPresenze = db.collection("test/" + idTest + "/presenze");
  const riferimentoRisultati = db.collection("test/" + idTest + "/risultati");

  // Aspetta chi sta ancora rispondendo, ricontrollando ogni 5 secondi,
  // fino a un massimo di 3 minuti.
  let tentativi = 0;
  while (tentativi < MASSIMO_TENTATIVI_ATTESA) {
    const numeroInSvolgimento = await contaInSvolgimento(riferimentoPresenze);
    if (numeroInSvolgimento === 0) break;
    await attendi(5000);
    tentativi++;
  }

  // Fotografo la sessione appena conclusa PRIMA di cancellare le presenze.
  const numeroSessioneAppenaConclusa = (dopo.azzeramenti || 0) + 1;
  try {
    const [istantaneaPresenze, istantaneaRisultati, istantaneaPrivato] = await Promise.all([
      riferimentoPresenze.get(),
      riferimentoRisultati.where("annullato", "==", false).get(),
      riferimentoPrivato.get()
    ]);

    const nomiCompletati = new Set();
    const numeroSessionePerNomeCompletato = new Map();
    istantaneaRisultati.forEach(documento => {
      const d = documento.data();
      const nome = (d.nome || "").trim().toLowerCase();
      if (nome) {
        nomiCompletati.add(nome);
        numeroSessionePerNomeCompletato.set(nome, typeof d.numeroSessione === "number" ? d.numeroSessione : null);
      }
    });

    const ora = Date.now();
    const nomiSessioneAttuale = new Set();
    let abbandonati = 0;
    istantaneaPresenze.forEach(documento => {
      const d = documento.data();
      const nomeNormalizzato = (d.nome || "").trim().toLowerCase();
      nomiSessioneAttuale.add(nomeNormalizzato);
      const fresco = d.ultimoAggiornamento && (ora - Number(d.ultimoAggiornamento)) <= SOGLIA_CONNESSIONE_MS_TURNO;
      if (!fresco && !nomiCompletati.has(nomeNormalizzato)) abbandonati++;
    });

    const nomiCompletatiSessioneAttuale = new Set([...nomiCompletati].filter(n => {
      const numeroSessioneRisultato = numeroSessionePerNomeCompletato.get(n);
      return numeroSessioneRisultato !== null
        ? numeroSessioneRisultato === numeroSessioneAppenaConclusa
        : nomiSessioneAttuale.has(n);
    }));

    const privato = istantaneaPrivato.exists ? istantaneaPrivato.data() : {};
    const numeroStudenti = (privato.studenti || []).length;
    const numeroAssenti = (privato.assenti || []).length;
    const copertiConnessiCompletati = new Set([...nomiSessioneAttuale, ...nomiCompletati]).size;
    const mancantiGenerali = Math.max(numeroStudenti - copertiConnessiCompletati - numeroAssenti, 0);

    if (nomiSessioneAttuale.size > 0) {
      await db.doc("test/" + idTest + "/sessioni/" + numeroSessioneAppenaConclusa).set({
        numeroSessione: numeroSessioneAppenaConclusa,
        partecipanti: nomiSessioneAttuale.size,
        completati: nomiCompletatiSessioneAttuale.size,
        abbandoni: abbandonati,
        mancantiGenerali,
        timestamp: new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" })
      });
    }
  } catch (erroreRiepilogo) {
    // Un problema nel riepilogo non deve mai impedire la pulizia.
    console.error("Errore nel calcolo del riepilogo di sessione per " + idTest, erroreRiepilogo);
  }

  // Pulizia: presenze rimaste e azzeramento del test per la prossima
  // sessione, compreso il contatore pubblico dei completati di sessione.
  const istantaneaDaCancellare = await riferimentoPresenze.get();
  const batch = db.batch();
  istantaneaDaCancellare.forEach(documento => batch.delete(documento.ref));
  batch.update(riferimentoTest, {
    avviatoTimestamp: null,
    pausaTimestamp: null,
    terminatoTimestamp: null,
    totalePausaMs: 0,
    secondiRimastiAllaPausa: null,
    completatiSessione: 0,
    azzeramenti: FieldValue.increment(1)
  });
  await batch.commit();
});
