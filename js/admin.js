const CATEGORIES = [
  ["theatre", "Théâtre"],
  ["humour", "Humour"],
  ["danse", "Danse"],
  ["concert", "Concert"],
  ["festival", "Festival"],
  ["conference", "Conférence"],
  ["cinema", "Cinéma"],
  ["sport", "Sport"],
  ["famille", "Famille"],
  ["expo", "Expo / marché"],
  ["soiree", "Soirée"],
  ["gastronomie", "Gastronomie"],
];

const state = {
  session: null,
  view: "keys",
  settings: null,
  sources: [],
  events: [],
  filter: "draft",
  eventPage: 0,
  runs: [],
  schedule: null,
  busy: false,
  selected: null,
  message: "",
  error: "",
  poll: null,
};

const app = document.getElementById("app");

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Requête impossible");
  return data;
}

function stopPoll() {
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
}

function startPoll() {
  stopPoll();
  state.poll = setInterval(() => {
    refreshRuns().catch((error) => {
      state.error = error.message;
      render();
    });
  }, 1500);
}

async function refreshSession() {
  state.session = await api("/api/admin/session");
}

async function refreshSettings() {
  state.settings = await api("/api/admin/settings");
}

async function refreshSources() {
  state.sources = (await api("/api/admin/sources")).sources;
}

async function refreshEvents() {
  const query = state.filter === "images"
    ? "?image=proposed"
    : state.filter === "missing"
      ? "?flag=missing"
      : state.filter === "all"
        ? ""
        : `?status=${state.filter}`;
  state.events = (await api(`/api/admin/events${query}`)).events;
}

async function refreshRuns() {
  const data = await api("/api/admin/runs");
  state.runs = data.runs;
  state.busy = data.busy;
  state.missingImages = Number(data.missingImages || 0);
  state.schedule = await api("/api/admin/schedule");
  if (!data.busy) stopPoll();
  if (state.view === "agent") render();
}

function parisToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shiftIsoDay(iso, delta) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + delta)).toISOString().slice(0, 10);
}

function defaultWindow() {
  const today = parisToday();
  return { min: shiftIsoDay(today, -1), max: shiftIsoDay(today, 30) };
}

function field(name, label, value, extra = "") {
  return `<label>${label}<input name="${name}" value="${esc(value)}" ${extra}></label>`;
}

function renderAuth() {
  const setup = state.session.needsSetup;
  app.innerHTML = `
    <main class="auth">
      <form class="card stack" id="authForm">
        <h1>${setup ? "Premier accès" : "Administration"}</h1>
        <p class="lede">${
          setup
            ? "Choisis le mot de passe de l’admin. Sur Railway, définis ADMIN_PASSWORD avant d’ouvrir le site au public."
            : "Les clés Gemini et Google Maps se règlent ici. Elles ne repartent pas dans Git."
        }</p>
        <label>Mot de passe
          <input id="password" name="password" type="password" minlength="8" autocomplete="${setup ? "new-password" : "current-password"}" required>
        </label>
        <p class="error" id="formError">${esc(state.error)}</p>
        <button class="primary" type="submit">${setup ? "Créer l’accès" : "Entrer"}</button>
        <a href="/">Retour à la carte</a>
      </form>
    </main>`;
  document.getElementById("authForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    state.error = "";
    const password = new FormData(event.currentTarget).get("password");
    try {
      await api(setup ? "/api/admin/setup" : "/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      await boot();
    } catch (error) {
      state.error = error.message;
      render();
    }
  });
}

function cursorModelOptions(current) {
  const choices = [
    ["", "Auto"],
    ["composer-2.5", "Composer 2.5"],
    ["grok-4.7", "Grok 4.7"],
    ["gpt-5.4-mini", "GPT-5.4 Mini"],
    ["gemini-3.8-flash", "Gemini 3.8 Flash"],
    ["claude-sonnet-5", "Claude Sonnet 5"],
  ];
  const known = new Set(choices.map(([id]) => id));
  if (current && !known.has(current)) choices.push([current, current]);
  return choices
    .map(([id, label]) => `<option value="${esc(id)}" ${id === (current || "") ? "selected" : ""}>${esc(label)}</option>`)
    .join("");
}

function keysView() {
  const settings = state.settings;
  return `
    <section class="panel stack" style="padding:18px">
      <h2>Clés API</h2>
      <p class="hint">La collecte utilise Gemini ou Cursor. Google Maps sert à la carte publique. Une clé déjà enregistrée n’est plus affichée en clair.</p>
      <p>
        <span class="pill ${settings.gemini.configured ? "" : "warn"}">Gemini ${settings.gemini.configured ? settings.gemini.hint : "manquante"}</span>
        <span class="pill ${settings.cursor?.configured ? "" : "warn"}">Cursor ${settings.cursor?.configured ? settings.cursor.hint : "manquante"}</span>
        <span class="pill ${settings.maps.configured ? "" : "warn"}">Maps ${settings.maps.configured ? settings.maps.hint : "manquante"}</span>
      </p>
      <form id="keysForm" class="stack">
        <label>Collecte
          <select name="provider">
            <option value="gemini" ${settings.provider === "cursor" ? "" : "selected"}>Gemini</option>
            <option value="cursor" ${settings.provider === "cursor" ? "selected" : ""}>Cursor</option>
          </select>
        </label>
        <div class="grid">
          ${field("geminiApiKey", "Clé Gemini", "", 'placeholder="Colle une nouvelle clé pour la remplacer" autocomplete="off"')}
          ${field("cursorApiKey", "Clé Cursor", "", 'placeholder="crsr_…" autocomplete="off"')}
          ${field("googleMapsApiKey", "Clé Google Maps", "", 'placeholder="Maps JavaScript API" autocomplete="off"')}
        </div>
        ${field("model", "Modèle Gemini", settings.model)}
        <label>Modèle Cursor
          <select name="cursorModel">
            ${cursorModelOptions(settings.cursorModel)}
          </select>
        </label>
        <p class="hint">Cursor lance un agent cloud sans dépôt, puis le supprime. Il ne modifie pas le code. Laisser Auto utilise le modèle par défaut du compte.</p>
        <p class="error">${esc(state.error)}</p>
        <p class="hint">${esc(state.message)}</p>
        <div class="row">
          <button class="primary" type="submit">Enregistrer</button>
          <button class="ghost" type="button" id="testGemini">Tester Gemini</button>
          <button class="ghost" type="button" id="testCursor">Tester Cursor</button>
          <button class="danger" type="button" id="clearGemini">Retirer Gemini</button>
          <button class="danger" type="button" id="clearCursor">Retirer Cursor</button>
          <button class="danger" type="button" id="clearMaps">Retirer Maps</button>
        </div>
      </form>
    </section>
    <section class="panel stack" style="padding:18px">
      <h2>Mot de passe</h2>
      <form id="passwordForm" class="grid">
        ${field("current", "Actuel", "", 'type="password" autocomplete="current-password"')}
        ${field("next", "Nouveau", "", 'type="password" minlength="8" autocomplete="new-password"')}
        <button class="primary" type="submit">Changer</button>
      </form>
    </section>`;
}

function sourcesView() {
  const items = state.sources
    .map(
      (source) => `
      <article class="item">
        <strong>${esc(source.name)}</strong>
        <span class="meta">${esc(source.url)}</span>
        <div class="row">
          <button class="ghost" type="button" data-toggle="${esc(source.id)}" data-enabled="${source.enabled ? "0" : "1"}">${source.enabled ? "Désactiver" : "Activer"}</button>
          <button class="danger" type="button" data-delete-source="${esc(source.id)}">Supprimer</button>
        </div>
      </article>`
    )
    .join("");
  return `
    <section class="panel stack" style="padding:18px">
      <h2>Sources</h2>
      <p class="hint">L’agent lit ces pages publiques. Un site qui ne s’affiche qu’en JavaScript donne souvent un texte vide : pointe alors l’URL vers l’agenda HTML.</p>
      <form id="sourceForm" class="grid">
        ${field("name", "Nom", "")}
        ${field("url", "URL", "", 'placeholder="https://"')}
        <button class="primary" type="submit">Ajouter</button>
      </form>
      <div class="row"><button class="ghost" type="button" id="resetSources">Restaurer les sources par défaut</button></div>
      <p class="error">${esc(state.error)}</p>
      <div class="list">${items || '<p class="hint">Aucune source.</p>'}</div>
    </section>`;
}

function agentView() {
  const run = state.runs[0];
  const schedule = state.schedule || { enabled: true, time: "06:15", queries: [], nextRun: "" };
  const when = schedule.nextRun
    ? new Date(schedule.nextRun).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })
    : "";
  const kind = run?.trigger_name === "schedule" ? "quotidien" : "manuel";
  const provider = state.settings?.provider === "cursor" ? "cursor" : "gemini";
  const cursorReady = Boolean(state.settings?.cursor?.configured);
  const defaults = defaultWindow();
  const windowMin = state.windowMin || defaults.min;
  const windowMax = state.windowMax || defaults.max;
  const task = state.runTask === "images" ? "images" : "discover";
  const missing = Number(state.missingImages || 0);
  return `
    <section class="panel stack" style="padding:18px">
      <h2>Agent quotidien</h2>
      <p class="hint">Chaque jour, à l’heure de Paris, la collecte lit les sources activées sur 30 jours. Les événements arrivent en brouillon. Rien n’est publié sans toi.</p>
      <form id="scheduleForm" class="stack">
        <label class="check"><input type="checkbox" name="enabled" ${schedule.enabled ? "checked" : ""}> Collecte automatique</label>
        <div class="grid">
          <label>Heure (Paris)<input name="time" type="time" value="${esc(schedule.time)}" required></label>
        </div>
        <label>Recherches, une par ligne
          <textarea name="queries">${esc((schedule.queries || []).join("\n"))}</textarea>
        </label>
        <p class="hint">Prochaine collecte : ${esc(when)}</p>
        <p class="error">${esc(state.error)}</p>
        <p class="hint">${esc(state.message)}</p>
        <div class="row">
          <button class="primary" type="submit">Enregistrer le planning</button>
          <a href="#events" id="goDrafts">Voir les brouillons</a>
        </div>
      </form>
      <label>Moteur
        <select id="providerPick">
          <option value="gemini" ${provider === "gemini" ? "selected" : ""}>Gemini</option>
          <option value="cursor" ${provider === "cursor" ? "selected" : ""}>Cursor</option>
        </select>
      </label>
      <p class="hint">${provider === "cursor"
        ? "Cursor lance un agent cloud sans dépôt. Compte environ une minute par question."
        : "Gemini interroge Google, puis lit les pages."}${cursorReady ? "" : " La clé Cursor n’est pas encore enregistrée."}</p>
      <label>Passage
        <select id="runTask">
          <option value="discover" ${task === "discover" ? "selected" : ""}>Découvrir des sorties</option>
          <option value="images" ${task === "images" ? "selected" : ""}>Compléter les affiches manquantes</option>
        </select>
      </label>
      <div class="grid">
        <label>Début<input id="windowMin" type="date" value="${esc(windowMin)}" ${task === "images" ? "disabled" : ""}></label>
        <label>Fin<input id="windowMax" type="date" value="${esc(windowMax)}" ${task === "images" ? "disabled" : ""}></label>
      </div>
      <p class="hint">${task === "images"
        ? `${missing} sortie(s) sans affiche. Ce passage ouvre leur lien, pas les agendas. Une page qui sert à plusieurs sorties est ignorée. 40 pages au plus. L’adresse proposée se valide ensuite à la main.`
        : "Par défaut : hier et les 30 jours suivants. Ces dates ne servent qu’au lancement manuel. La collecte automatique garde les 30 jours. Les jours déjà parcourus sont relus après les jours neufs."}</p>
      <div class="row">
        <button class="primary" type="button" id="startRun" ${state.busy ? "disabled" : ""}>${state.busy ? "Collecte en cours…" : task === "images" ? "Compléter les affiches" : "Lancer maintenant"}</button>
      </div>
      <p class="hint">${run ? `${esc(kind)} · ${esc(run.status)} · ${run.created_count || 0} nouveau(x) · ${run.updated_count || 0} mis à jour` : "Aucune collecte."}</p>
      <pre class="log">${esc(run?.log || "")}</pre>
    </section>`;
}

const EVENT_PAGE_SIZE = 20;

function eventForm() {
  const event = state.selected;
  if (!event?.id) return "";
  const draft = event.status !== "published" && event.status !== "cancelled";
  const options = CATEGORIES.map(
    ([key, label]) => `<option value="${key}" ${event.category === key ? "selected" : ""}>${label}</option>`
  ).join("");
  const statusField = draft
    ? ""
    : `<label>Statut
          <select name="status">
            <option value="draft" ${event.status !== "published" && event.status !== "cancelled" ? "selected" : ""}>Brouillon</option>
            <option value="published" ${event.status === "published" ? "selected" : ""}>Publié</option>
            <option value="cancelled" ${event.status === "cancelled" ? "selected" : ""}>Annulé</option>
          </select>
        </label>`;
  const actions = draft
    ? `<button class="primary" type="submit">Valider</button><button class="danger" type="button" id="refuseDraft">Refuser</button>`
    : `<button class="primary" type="submit">Enregistrer</button>`;
  return `
    <form id="eventForm" class="stack">
      ${field("title", "Titre", event.title, "required")}
      <div class="grid">
        ${field("days", "Dates", (event.days || []).join(", "), 'placeholder="2026-10-12, 2026-10-13"')}
        ${field("time", "Horaire", event.time)}
        <label>Catégorie<select name="category">${options}</select></label>
        ${statusField}
        ${field("city", "Ville", event.city)}
        ${field("venue", "Lieu", event.venue)}
        ${field("lat", "Latitude", event.lat ?? "", 'inputmode="decimal"')}
        ${field("lng", "Longitude", event.lng ?? "", 'inputmode="decimal"')}
        ${field("price", "Prix", event.price)}
        ${field("source", "Source", event.source)}
      </div>
      ${field("url", "Lien", event.url)}
      <label>Description<textarea name="description">${esc(event.description)}</textarea></label>
      <label class="check"><input type="checkbox" name="free" ${event.free ? "checked" : ""}> Entrée gratuite</label>
      <div class="row">${actions}</div>
    </form>`;
}

function daysLabel(days) {
  const list = [...(days || [])].filter(Boolean).sort();
  if (!list.length) return "sans date";
  if (list.length === 1) return list[0];
  return `${list[0]} → ${list[list.length - 1]} · ${list.length} jours`;
}

function eventState(event) {
  if (event.flagStatus === "missing" && event.status !== "cancelled") return { label: "à vérifier", warn: true };
  if (event.status === "published") return { label: "publié", warn: false };
  if (event.status === "cancelled") return { label: "annulé", warn: true };
  return { label: "brouillon", warn: true };
}

function eventsView() {
  const size = EVENT_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(state.events.length / size));
  state.eventPage = Math.min(Math.max(state.eventPage || 0, 0), pages - 1);
  const slice = state.events.slice(state.eventPage * size, state.eventPage * size + size);
  const cards = slice
    .map((event) => {
      const stamp = eventState(event);
      return `
      <article class="event ${state.selected?.id === event.id ? "active" : ""}" data-event="${esc(event.id)}">
        <div class="event-main">
          ${event.image ? `<img class="thumb" src="${esc(event.image)}" alt="" referrerpolicy="no-referrer">` : ""}
          <div>
            <strong>${esc(event.title)}</strong>
            <div class="meta">${esc(event.city)} · ${esc(daysLabel(event.days))} · ${esc(stamp.label)}${event.imageStatus === "proposed" ? " · image à valider" : ""}</div>
          </div>
        </div>
        <span class="pill ${stamp.warn ? "warn" : ""}">${esc(stamp.label)}</span>
      </article>`;
    })
    .join("");
  const pager = state.events.length
    ? `<div class="row pager">
        <button class="ghost" type="button" data-page="-1" ${state.eventPage === 0 ? "disabled" : ""}>Précédent</button>
        <span class="meta">${state.eventPage + 1} / ${pages} · ${state.events.length}</span>
        <button class="ghost" type="button" data-page="1" ${state.eventPage >= pages - 1 ? "disabled" : ""}>Suivant</button>
      </div>`
    : "";
  return `
    <section class="panel stack" style="padding:18px">
      <h2>Événements</h2>
      <div class="row">
        <button class="ghost" type="button" data-filter="draft">Brouillons</button>
        <button class="ghost" type="button" data-filter="published">Publiés</button>
        <button class="ghost" type="button" data-filter="missing">À vérifier</button>
        <button class="ghost" type="button" data-filter="cancelled">Annulés</button>
        <button class="ghost" type="button" data-filter="all">Tous</button>
        <button class="ghost" type="button" data-filter="images">Images à valider</button>
        <button class="primary" type="button" id="publishDrafts">Publier tous les brouillons</button>
      </div>
      <p class="error">${esc(state.error)}</p>
      <p class="hint">${esc(state.message)}</p>
      <div class="events-workspace">
        <div class="event-browser">
          <div class="event-list">${cards || '<p class="hint">Rien dans ce filtre.</p>'}</div>
          ${pager}
        </div>
        <div class="event-editor">
          ${imageBox()}
          ${reviewBox()}
          ${eventForm()}
        </div>
      </div>
    </section>`;
}

function reviewBox() {
  const event = state.selected;
  if (!event?.id || event.flagStatus !== "missing" || event.status === "cancelled") return "";
  return `
    <div class="image-box">
      <h3>Plus annoncé</h3>
      <p class="hint">${esc(event.flagNote || "L’agent ne l’a plus vu sur sa source.")} Tu choisis : le noter annulé, le supprimer, ou le garder.</p>
      <div class="row">
        <button class="primary" type="button" id="flagCancel">Noter annulé</button>
        <button class="danger" type="button" id="flagDelete">Supprimer</button>
        <button class="ghost" type="button" id="flagKeep">Toujours là</button>
      </div>
    </div>`;
}

function imageBox() {
  const event = state.selected;
  if (!event?.id) {
    return `
      <div class="image-box">
        <h3>Illustration</h3>
        <p class="hint">Choisis une sortie dans la liste pour coller l’adresse d’une affiche.</p>
      </div>`;
  }
  const labels = { proposed: "À valider", approved: "Retenue", rejected: "Refusée" };
  const label = labels[event.imageStatus] || "Aucune";
  const verb = event.status !== "published" && event.status !== "cancelled" ? "valides" : "enregistres";
  const frame = event.image
    ? `<img class="shot" id="imageShot" src="${esc(event.image)}" alt="" referrerpolicy="no-referrer">`
    : `<div class="shot shot-empty">Aucune affiche</div>`;
  const page = /^https?:\/\//i.test(event.imagePage || "")
    ? `<a href="${esc(event.imagePage)}" target="_blank" rel="noopener">page source</a>`
    : "";
  return `
    <div class="image-box">
      <h3>Illustration</h3>
      <p class="hint">${esc(label)}${page ? ` · ${page}` : ""}. L’adresse est enregistrée quand tu ${verb}.</p>
      ${frame}
      <label>Adresse de l’affiche<input id="imageUrl" type="url" placeholder="https://" value="${esc(state.pendingFor === event.id && state.pendingImage != null ? state.pendingImage : (event.image || ""))}"></label>
      <div class="row">
        <button class="ghost" type="button" id="findImage" ${/^https?:\/\//i.test(event.url || "") ? "" : "disabled"}>Chercher l’affiche</button>
      </div>
    </div>`;
}

function renderApp() {
  const views = { keys: keysView, sources: sourcesView, agent: agentView, events: eventsView };
  app.innerHTML = `
    <div class="shell">
      <aside class="side">
        <div class="brand">Côte d'Azur Vivante</div>
        <nav class="nav">
          <button type="button" data-view="keys" class="${state.view === "keys" ? "active" : ""}">Clés API</button>
          <button type="button" data-view="sources" class="${state.view === "sources" ? "active" : ""}">Sources</button>
          <button type="button" data-view="agent" class="${state.view === "agent" ? "active" : ""}">Collecte</button>
          <button type="button" data-view="events" class="${state.view === "events" ? "active" : ""}">Événements</button>
        </nav>
        <a href="/">Voir la carte</a>
        <button class="ghost" type="button" id="logout">Sortir</button>
      </aside>
      <main class="main">${views[state.view]()}</main>
    </div>`;
  bindApp();
}

function render() {
  if (!state.session?.authenticated) renderAuth();
  else renderApp();
}

function formBody(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  data.free = Boolean(form.elements.free?.checked);
  if (typeof data.days === "string") {
    data.days = data.days.split(/[,\s]+/).map((day) => day.trim()).filter(Boolean);
  }
  return data;
}

function bindApp() {
  app.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.view = button.dataset.view;
      state.error = "";
      state.message = "";
      try {
        if (state.view === "sources") await refreshSources();
        if (state.view === "events") await refreshEvents();
        if (state.view === "agent") {
          await refreshSettings();
          await refreshRuns();
        }
        if (state.view === "keys") await refreshSettings();
      } catch (error) {
        state.error = error.message;
      }
      render();
    });
  });

  document.getElementById("logout")?.addEventListener("click", async () => {
    stopPoll();
    await api("/api/admin/logout", { method: "POST", body: "{}" });
    state.session.authenticated = false;
    render();
  });

  document.getElementById("keysForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.error = "";
    state.message = "";
    try {
      state.settings = await api("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify(formBody(event.currentTarget)),
      });
      state.message = "Clés enregistrées.";
    } catch (error) {
      state.error = error.message;
    }
    render();
  });

  document.getElementById("testGemini")?.addEventListener("click", async () => {
    state.error = "";
    state.message = "";
    try {
      const result = await api("/api/admin/settings/test-gemini", { method: "POST", body: "{}" });
      state.message = `${result.model} répond : ${result.reply}`;
    } catch (error) {
      state.error = error.message;
    }
    render();
  });

  document.getElementById("testCursor")?.addEventListener("click", async () => {
    state.error = "";
    state.message = "";
    try {
      const result = await api("/api/admin/settings/test-cursor", { method: "POST", body: "{}" });
      state.message = `Clé Cursor « ${result.name} » reconnue.`;
    } catch (error) {
      state.error = error.message;
    }
    render();
  });

  for (const [id, which] of [["clearGemini", "gemini"], ["clearCursor", "cursor"], ["clearMaps", "maps"]]) {
    document.getElementById(id)?.addEventListener("click", async () => {
      state.settings = await api("/api/admin/settings/clear", {
        method: "POST",
        body: JSON.stringify({ which }),
      });
      state.message = "Clé retirée.";
      render();
    });
  }

  document.getElementById("passwordForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.error = "";
    try {
      await api("/api/admin/password", { method: "POST", body: JSON.stringify(formBody(event.currentTarget)) });
      state.message = "Mot de passe changé.";
    } catch (error) {
      state.error = error.message;
    }
    render();
  });

  document.getElementById("sourceForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.error = "";
    try {
      await api("/api/admin/sources", { method: "POST", body: JSON.stringify(formBody(event.currentTarget)) });
      await refreshSources();
    } catch (error) {
      state.error = error.message;
    }
    render();
  });

  document.getElementById("resetSources")?.addEventListener("click", async () => {
    await api("/api/admin/sources/reset", { method: "POST", body: "{}" });
    await refreshSources();
    render();
  });

  app.querySelectorAll("[data-toggle]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/admin/sources/${button.dataset.toggle}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: button.dataset.enabled === "1" }),
      });
      await refreshSources();
      render();
    });
  });

  app.querySelectorAll("[data-delete-source]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/admin/sources/${button.dataset.deleteSource}`, { method: "DELETE" });
      await refreshSources();
      render();
    });
  });

  document.getElementById("scheduleForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.error = "";
    state.message = "";
    const form = event.currentTarget;
    const body = formBody(form);
    body.enabled = form.elements.enabled.checked;
    try {
      state.schedule = await api("/api/admin/schedule", { method: "PUT", body: JSON.stringify(body) });
      state.message = "Planning enregistré.";
    } catch (error) {
      state.error = error.message;
    }
    render();
  });

  document.getElementById("providerPick")?.addEventListener("change", async (event) => {
    const provider = event.target.value === "cursor" ? "cursor" : "gemini";
    state.error = "";
    try {
      state.settings = await api("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ provider }),
      });
      state.message = provider === "cursor" ? "Les prochaines collectes utilisent Cursor." : "Les prochaines collectes utilisent Gemini.";
    } catch (error) {
      state.error = error.message;
    }
    render();
  });

  document.getElementById("runTask")?.addEventListener("change", (event) => {
    state.runTask = event.target.value === "images" ? "images" : "discover";
    render();
  });

  document.getElementById("windowMin")?.addEventListener("input", (event) => {
    state.windowMin = event.target.value;
  });
  document.getElementById("windowMax")?.addEventListener("input", (event) => {
    state.windowMax = event.target.value;
  });

  document.getElementById("startRun")?.addEventListener("click", async () => {
    state.error = "";
    try {
      const provider = document.getElementById("providerPick")?.value === "cursor" ? "cursor" : "gemini";
      state.settings = await api("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ provider }),
      });
      const defaults = defaultWindow();
      const minDay = document.getElementById("windowMin")?.value || defaults.min;
      const maxDay = document.getElementById("windowMax")?.value || defaults.max;
      state.windowMin = minDay;
      state.windowMax = maxDay;
      const task = document.getElementById("runTask")?.value === "images" ? "images" : "discover";
      state.runTask = task;
      await api("/api/admin/runs", { method: "POST", body: JSON.stringify({ minDay, maxDay, task }) });
      state.busy = true;
      await refreshRuns();
      startPoll();
    } catch (error) {
      state.error = error.message;
    }
    render();
  });

  document.getElementById("goDrafts")?.addEventListener("click", async (event) => {
    event.preventDefault();
    state.view = "events";
    state.filter = "draft";
    state.eventPage = 0;
    await refreshEvents();
    render();
  });

  app.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.filter = button.dataset.filter;
      state.eventPage = 0;
      state.selected = null;
      await refreshEvents();
      render();
    });
  });

  document.getElementById("publishDrafts")?.addEventListener("click", async () => {
    const result = await api("/api/admin/events/publish-drafts", { method: "POST", body: "{}" });
    state.message = `${result.count} événement(s) publié(s).`;
    state.filter = "published";
    state.eventPage = 0;
    await refreshEvents();
    render();
  });

  app.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      state.eventPage = (state.eventPage || 0) + Number(button.dataset.page || 0);
      render();
    });
  });

  app.querySelectorAll("[data-event]").forEach((card) => {
    card.addEventListener("click", () => {
      state.selected = state.events.find((event) => event.id === card.dataset.event) || null;
      state.pendingImage = null;
      state.pendingFor = "";
      render();
    });
  });

  const imageShot = document.getElementById("imageShot");
  const markSmallShot = () => {
    if (!imageShot?.naturalWidth) return;
    if (imageShot.naturalWidth >= 640 && imageShot.naturalHeight >= 360) return;
    const meta = document.querySelector(".image-box .meta");
    if (!meta || meta.dataset.sized) return;
    meta.dataset.sized = "1";
    meta.insertAdjacentText("beforeend", " · petite, le recadrage sera flou");
  };
  if (imageShot?.complete) markSmallShot();
  else imageShot?.addEventListener("load", markSmallShot);

  const decideFlag = async (decision) => {
    if (!state.selected) return;
    state.error = "";
    try {
      await api(`/api/admin/events/${state.selected.id}/flag`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      state.message = decision === "cancel"
        ? "Événement noté annulé."
        : decision === "delete"
          ? "Événement supprimé."
          : "Événement conservé.";
      if (decision === "delete") state.selected = null;
      await refreshEvents();
      if (state.selected?.id) {
        state.selected = state.events.find((event) => event.id === state.selected.id) || null;
      }
    } catch (error) {
      state.error = error.message;
    }
    render();
  };
  document.getElementById("flagCancel")?.addEventListener("click", () => decideFlag("cancel"));
  document.getElementById("flagDelete")?.addEventListener("click", () => {
    if (!confirm("Supprimer cet événement ?")) return;
    decideFlag("delete");
  });
  document.getElementById("flagKeep")?.addEventListener("click", () => decideFlag("keep"));

  document.getElementById("findImage")?.addEventListener("click", async () => {
    if (!state.selected) return;
    state.error = "";
    state.message = "Recherche de l’affiche…";
    render();
    try {
      const found = await api(`/api/admin/events/${state.selected.id}/find-image`, { method: "POST", body: "{}" });
      state.pendingFor = state.selected.id;
      state.pendingImage = found.image || "";
      state.message = "Affiche trouvée. Valide pour la retenir, ou change l’adresse.";
    } catch (error) {
      state.error = error.message;
      state.message = "";
    }
    render();
  });

  document.getElementById("refuseDraft")?.addEventListener("click", () => refuseDraft());

  document.getElementById("eventForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const draft = state.selected && state.selected.status !== "published" && state.selected.status !== "cancelled";
    if (draft) await commitEvent(event.currentTarget, { status: "published", next: true, message: "Validé." });
    else await commitEvent(event.currentTarget, { message: "Enregistré." });
  });
}

function neighborId(id) {
  const index = state.events.findIndex((event) => event.id === id);
  if (index < 0) return "";
  return state.events[index + 1]?.id || state.events[index - 1]?.id || "";
}

function revealEvent(id) {
  if (!id) {
    state.selected = null;
    return;
  }
  const index = state.events.findIndex((event) => event.id === id);
  if (index < 0) {
    state.selected = state.events[0] || null;
    state.eventPage = 0;
    return;
  }
  state.eventPage = Math.floor(index / EVENT_PAGE_SIZE);
  state.selected = state.events[index];
}

async function commitEvent(form, { status, next = false, message } = {}) {
  if (!state.selected) return;
  state.error = "";
  const id = state.selected.id;
  const nextId = next ? neighborId(id) : id;
  const body = formBody(form);
  if (status) body.status = status;
  const imageUrl = document.getElementById("imageUrl")?.value.trim() || "";
  try {
    await api(`/api/admin/events/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    if (imageUrl) {
      await api(`/api/admin/events/${id}/image`, {
        method: "POST",
        body: JSON.stringify({ decision: "use", url: imageUrl }),
      });
    }
    state.message = message || "Enregistré.";
    await refreshEvents();
    revealEvent(nextId);
  } catch (error) {
    state.error = error.message;
  }
  render();
}

async function refuseDraft() {
  if (!state.selected) return;
  state.error = "";
  const nextId = neighborId(state.selected.id);
  try {
    await api(`/api/admin/events/${state.selected.id}/flag`, {
      method: "POST",
      body: JSON.stringify({ decision: "cancel" }),
    });
    state.message = "Refusé.";
    await refreshEvents();
    revealEvent(nextId);
  } catch (error) {
    state.error = error.message;
  }
  render();
}

async function boot() {
  state.error = "";
  await refreshSession();
  if (state.session.authenticated) {
    await refreshSettings();
    if (state.view === "sources") await refreshSources();
    if (state.view === "events") await refreshEvents();
    if (state.view === "agent") await refreshRuns();
  }
  render();
}

boot().catch((error) => {
  app.textContent = error.message;
});
