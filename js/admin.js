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
    : state.filter === "all"
      ? ""
      : `?status=${state.filter}`;
  state.events = (await api(`/api/admin/events${query}`)).events;
}

async function refreshRuns() {
  const data = await api("/api/admin/runs");
  state.runs = data.runs;
  state.busy = data.busy;
  state.schedule = await api("/api/admin/schedule");
  if (!data.busy) stopPoll();
  if (state.view === "agent") render();
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
      <div class="row">
        <button class="primary" type="button" id="startRun" ${state.busy ? "disabled" : ""}>${state.busy ? "Collecte en cours…" : "Lancer maintenant"}</button>
      </div>
      <p class="hint">${run ? `${esc(kind)} · ${esc(run.status)} · ${run.created_count || 0} nouveau(x) · ${run.updated_count || 0} mis à jour` : "Aucune collecte."}</p>
      <pre class="log">${esc(run?.log || "")}</pre>
    </section>`;
}

function eventForm() {
  const event = state.selected || {
    title: "",
    days: [],
    time: "",
    category: "festival",
    city: "",
    venue: "",
    address: "",
    lat: "",
    lng: "",
    price: "",
    free: false,
    description: "",
    url: "",
    source: "",
    status: "draft",
  };
  const options = CATEGORIES.map(
    ([key, label]) => `<option value="${key}" ${event.category === key ? "selected" : ""}>${label}</option>`
  ).join("");
  return `
    <form id="eventForm" class="stack">
      <h2>${state.selected ? "Modifier" : "Nouvel événement"}</h2>
      ${field("title", "Titre", event.title, "required")}
      <div class="grid">
        ${field("days", "Dates", (event.days || []).join(", "), 'placeholder="2026-10-12, 2026-10-13"')}
        ${field("time", "Horaire", event.time)}
        <label>Catégorie<select name="category">${options}</select></label>
        <label>Statut
          <select name="status">
            <option value="draft" ${event.status !== "published" ? "selected" : ""}>Brouillon</option>
            <option value="published" ${event.status === "published" ? "selected" : ""}>Publié</option>
          </select>
        </label>
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
      <div class="row">
        <button class="primary" type="submit">${state.selected ? "Enregistrer" : "Créer"}</button>
        ${state.selected ? '<button class="danger" type="button" id="deleteEvent">Supprimer</button>' : ""}
        <button class="ghost" type="button" id="newEvent">Nouveau</button>
      </div>
    </form>`;
}

function eventsView() {
  const cards = state.events
    .map(
      (event) => `
      <article class="event ${state.selected?.id === event.id ? "active" : ""}" data-event="${esc(event.id)}">
        <div class="event-main">
          ${event.image ? `<img class="thumb" src="${esc(event.image)}" alt="" referrerpolicy="no-referrer">` : ""}
          <div>
            <strong>${esc(event.title)}</strong>
            <div class="meta">${esc(event.city)} · ${esc((event.days || []).join(", "))} · ${esc(event.status === "published" ? "publié" : "brouillon")}${event.imageStatus === "proposed" ? " · image à valider" : ""}</div>
          </div>
        </div>
        <span class="pill ${event.status === "published" ? "" : "warn"}">${event.status === "published" ? "publié" : "brouillon"}</span>
      </article>`
    )
    .join("");
  return `
    <section class="panel stack" style="padding:18px">
      <h2>Événements</h2>
      <div class="row">
        <button class="ghost" type="button" data-filter="draft">Brouillons</button>
        <button class="ghost" type="button" data-filter="published">Publiés</button>
        <button class="ghost" type="button" data-filter="all">Tous</button>
        <button class="ghost" type="button" data-filter="images">Images à valider</button>
        <button class="primary" type="button" id="publishDrafts">Publier tous les brouillons</button>
      </div>
      <p class="error">${esc(state.error)}</p>
      <p class="hint">${esc(state.message)}</p>
      <div class="list">${cards || '<p class="hint">Rien dans ce filtre.</p>'}</div>
      ${eventForm()}
      ${imageBox()}
    </section>`;
}

function imageBox() {
  const event = state.selected;
  if (!event?.id) return "";
  const labels = { proposed: "À valider", approved: "Retenue", rejected: "Refusée" };
  const label = labels[event.imageStatus] || "Aucune";
  const frame = event.image
    ? `<img class="shot" id="imageShot" src="${esc(event.image)}" alt="" referrerpolicy="no-referrer">`
    : `<div class="shot shot-empty">Aucune affiche</div>`;
  const page = /^https?:\/\//i.test(event.imagePage || "")
    ? `<a href="${esc(event.imagePage)}" target="_blank" rel="noopener">page source</a>`
    : "";
  return `
    <div class="image-box">
      <h3>Illustration</h3>
      <p class="hint">Même cadre 16:9 pour toutes les sorties, recadré au centre. L’image n’apparaît sur la carte qu’une fois retenue.</p>
      ${frame}
      <p class="meta">${esc(label)}${page ? ` · ${page}` : ""}</p>
      <div class="row">
        <button class="primary" type="button" id="keepImage" ${event.image ? "" : "disabled"}>Retenir</button>
        <button class="ghost" type="button" id="dropImage" ${event.image ? "" : "disabled"}>Refuser</button>
      </div>
      <label>Autre adresse d’image<input id="imageUrl" type="url" placeholder="https://"></label>
      <button class="ghost" type="button" id="useImage">Utiliser cette adresse</button>
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

  document.getElementById("startRun")?.addEventListener("click", async () => {
    state.error = "";
    try {
      const provider = document.getElementById("providerPick")?.value === "cursor" ? "cursor" : "gemini";
      state.settings = await api("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ provider }),
      });
      await api("/api/admin/runs", { method: "POST", body: "{}" });
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
    await refreshEvents();
    render();
  });

  app.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.filter = button.dataset.filter;
      state.selected = null;
      await refreshEvents();
      render();
    });
  });

  document.getElementById("publishDrafts")?.addEventListener("click", async () => {
    const result = await api("/api/admin/events/publish-drafts", { method: "POST", body: "{}" });
    state.message = `${result.count} événement(s) publié(s).`;
    state.filter = "published";
    await refreshEvents();
    render();
  });

  app.querySelectorAll("[data-event]").forEach((card) => {
    card.addEventListener("click", () => {
      state.selected = state.events.find((event) => event.id === card.dataset.event) || null;
      render();
    });
  });

  document.getElementById("newEvent")?.addEventListener("click", () => {
    state.selected = null;
    render();
  });

  document.getElementById("deleteEvent")?.addEventListener("click", async () => {
    if (!state.selected || !confirm("Supprimer cet événement ?")) return;
    await api(`/api/admin/events/${state.selected.id}`, { method: "DELETE" });
    state.selected = null;
    await refreshEvents();
    render();
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

  document.getElementById("keepImage")?.addEventListener("click", () => decideImage("approve"));
  document.getElementById("dropImage")?.addEventListener("click", () => decideImage("reject"));
  document.getElementById("useImage")?.addEventListener("click", () => {
    decideImage("use", document.getElementById("imageUrl")?.value || "");
  });

  document.getElementById("eventForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.error = "";
    const body = formBody(event.currentTarget);
    try {
      if (state.selected) {
        await api(`/api/admin/events/${state.selected.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        const created = await api("/api/admin/events", { method: "POST", body: JSON.stringify(body) });
        state.selected = { id: created.id };
      }
      state.message = "Événement enregistré.";
      await refreshEvents();
      if (state.selected?.id) {
        state.selected = state.events.find((item) => item.id === state.selected.id) || state.selected;
      }
    } catch (error) {
      state.error = error.message;
    }
    render();
  });
}

async function decideImage(decision, url) {
  if (!state.selected) return;
  state.error = "";
  state.message = "";
  try {
    const saved = await api(`/api/admin/events/${state.selected.id}/image`, {
      method: "POST",
      body: JSON.stringify({ decision, url }),
    });
    state.message = decision === "reject" ? "Image refusée." : "Image retenue.";
    await refreshEvents();
    state.selected = state.events.find((item) => item.id === saved.event.id) || saved.event;
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
