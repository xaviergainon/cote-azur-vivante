(async function () {
  let data;
  try {
    const response = await fetch("/api/agenda");
    if (!response.ok) throw new Error("agenda");
    data = await response.json();
  } catch (error) {
    const box = document.getElementById("mapError");
    if (box) {
      box.hidden = false;
      box.textContent = "Impossible de charger l’agenda.";
    }
    return;
  }

  const DAY_STYLE = [
    { elementType: "geometry", stylers: [{ color: "#e7f2ef" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#1c3a44" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#f4f8f7" }] },
    { featureType: "administrative", elementType: "geometry", stylers: [{ visibility: "off" }] },
    { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#8a5a12" }] },
    { featureType: "poi", stylers: [{ visibility: "off" }] },
    { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
    { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#d5e4e1" }] },
    { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#f3e6c8" }] },
    { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#b7dfe8" }] },
    { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#0c6e67" }] },
    { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#eef6f4" }] },
  ];

  const NIGHT_STYLE = [
    { elementType: "geometry", stylers: [{ color: "#0b1f28" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#c5ddd8" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#0b1f28" }] },
    { featureType: "administrative", elementType: "geometry", stylers: [{ visibility: "off" }] },
    { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#e6b35a" }] },
    { featureType: "poi", stylers: [{ visibility: "off" }] },
    { featureType: "road", elementType: "geometry", stylers: [{ color: "#16343f" }] },
    { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#0e4a5c" }] },
    { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#1a4d5c" }] },
    { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#06151c" }] },
    { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#3ecfc2" }] },
    { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#0f2a34" }] },
  ];

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

  function dayDate(iso) {
    return new Date(`${iso}T12:00:00`);
  }

  function dayParts(iso) {
    const d = dayDate(iso);
    const clean = (value) => value.replace(".", "");
    return {
      dow: clean(d.toLocaleDateString("fr-FR", { weekday: "short" })),
      n: d.getDate(),
      long: d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }),
    };
  }

  const today = parisToday();
  const QUICK_INTENTS = ["theatre", "concert", "cinema", "famille", "expo", "lecture"];
  const state = {
    day: data.meta.days.includes(today) ? today : data.meta.days[0] || today,
    span: "week",
    intent: "all",
    daysOpen: false,
    city: "all",
    freeOnly: false,
    query: "",
    selectedId: null,
    view: "map",
    cal: dayDate(data.meta.days.includes(today) ? today : data.meta.days[0] || today),
    map: null,
    markers: new Map(),
    ready: false,
  };
  let ignoreMapClick = false;
  let toastTimer = 0;

  const els = {
    dayRail: document.getElementById("dayRail"),
    spanRow: document.getElementById("spanRow"),
    intentRow: document.getElementById("intentRow"),
    cityRail: document.getElementById("cityRail"),
    filters: document.getElementById("filters"),
    list: document.getElementById("list"),
    calEvents: document.getElementById("calEvents"),
    stats: document.getElementById("stats"),
    listStats: document.getElementById("listStats"),
    calStats: document.getElementById("calStats"),
    whenLabel: document.getElementById("whenLabel"),
    search: document.getElementById("search"),
    freeToggle: document.getElementById("freeToggle"),
    sources: document.getElementById("sources"),
    splash: document.getElementById("splash"),
    enterBtn: document.getElementById("enterBtn"),
    mapError: document.getElementById("mapError"),
    ride: document.getElementById("ride"),
    rideBody: document.getElementById("rideBody"),
    filterBadge: document.getElementById("filterBadge"),
    activeFilters: document.getElementById("activeFilters"),
    toast: document.getElementById("toast"),
    calTitle: document.getElementById("calTitle"),
    calGrid: document.getElementById("calGrid"),
    viewList: document.getElementById("viewList"),
    viewCal: document.getElementById("viewCal"),
    sheet: document.getElementById("filterSheet"),
    backdrop: document.getElementById("sheetBackdrop"),
  };

  function catMeta(cat) {
    return data.categories[cat] || { label: cat, color: "#3ecfc2", icon: "•" };
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function hasPoint(event) {
    return Number.isFinite(Number(event.lat)) && Number.isFinite(Number(event.lng));
  }

  function dayRange(start, count) {
    const days = [];
    for (let offset = 0; offset < count; offset += 1) days.push(shiftIsoDay(start, offset));
    return days;
  }

  function weekendDays() {
    const dow = (dayDate(today).getUTCDay() + 6) % 7;
    if (dow <= 3) return dayRange(shiftIsoDay(today, 4 - dow), 3);
    if (dow === 4) return dayRange(today, 3);
    if (dow === 5) return dayRange(today, 2);
    return [today];
  }

  function monthSpan() {
    const start = dayDate(today);
    const lastDate = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    const last = lastDate.toISOString().slice(0, 10);
    const cap = shiftIsoDay(today, 30);
    const end = last < cap ? last : cap;
    const days = [];
    for (let day = today; day <= end; day = shiftIsoDay(day, 1)) days.push(day);
    return days;
  }

  function activeDays() {
    if (state.span === "today") return [today];
    if (state.span === "weekend") return weekendDays();
    if (state.span === "month") return monthSpan();
    if (state.span === "day") return [state.day];
    return dayRange(today, 7);
  }

  function spanTitle() {
    if (state.span === "today") return "Aujourd’hui";
    if (state.span === "weekend") return "Ce week-end";
    if (state.span === "month") {
      const label = dayDate(today).toLocaleDateString("fr-FR", { month: "long" });
      return label.charAt(0).toUpperCase() + label.slice(1);
    }
    if (state.span === "day") return state.day === today ? "Aujourd’hui" : dayParts(state.day).long;
    return "7 prochains jours";
  }

  function passes(event, day) {
    const days = day === null ? null : day ? [day] : activeDays();
    if (days && !days.some((item) => event.days.includes(item))) return false;
    if (state.city !== "all" && event.city !== state.city) return false;
    if (state.intent && state.intent !== "all" && event.category !== state.intent) return false;
    if (state.freeOnly && !event.free) return false;
    if (state.query) {
      const blob = [event.title, event.city, event.venue, event.description, event.category, catMeta(event.category).label]
        .join(" ")
        .toLowerCase();
      if (!blob.includes(state.query.toLowerCase())) return false;
    }
    return true;
  }

  function filtered(day) {
    return data.events.filter((event) => passes(event, day)).sort((a, b) => String(a.time).localeCompare(String(b.time), "fr"));
  }

  function nextDayInView(event) {
    return activeDays().find((day) => event.days.includes(day)) || "";
  }

  function timelineDays() {
    const start = shiftIsoDay(today, -1);
    const days = [];
    for (let offset = 0; offset <= 31; offset += 1) days.push(shiftIsoDay(start, offset));
    return days;
  }

  function citiesInView() {
    const saved = state.city;
    state.city = "all";
    const cities = [...new Set(filtered().map((event) => event.city))].filter(Boolean);
    state.city = saved;
    return cities.sort((a, b) => a.localeCompare(b, "fr"));
  }

  function countForIntent(key) {
    const saved = state.intent;
    state.intent = key;
    const total = filtered().length;
    state.intent = saved;
    return total;
  }

  function filterCount() {
    let n = 0;
    if (state.city !== "all") n += 1;
    if (state.freeOnly) n += 1;
    if (state.query) n += 1;
    if (state.intent && state.intent !== "all") n += 1;
    return n;
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 2600);
  }

  function shiftMonth(delta) {
    state.cal = new Date(state.cal.getFullYear(), state.cal.getMonth() + delta, 1);
    if (!sameMonth(state.day, state.cal)) {
      const prefix = `${state.cal.getFullYear()}-${String(state.cal.getMonth() + 1).padStart(2, "0")}`;
      const candidate = data.meta.days.find((day) => day.startsWith(prefix));
      state.day = candidate || `${prefix}-01`;
    }
    render();
  }

  function sameMonth(iso, date) {
    const d = dayDate(iso);
    return d.getFullYear() === date.getFullYear() && d.getMonth() === date.getMonth();
  }

  function directionsUrl(event) {
    if (hasPoint(event)) {
      return `https://www.google.com/maps/dir/?api=1&destination=${Number(event.lat)},${Number(event.lng)}`;
    }
    const q = encodeURIComponent([event.venue, event.city, "Alpes-Maritimes"].filter(Boolean).join(" "));
    return `https://www.google.com/maps/search/?api=1&query=${q}`;
  }

  function shotHtml(event) {
    if (!event.image) return "";
    const src = escapeHtml(event.image);
    return `<img class="shot" src="${src}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">`;
  }

  function ratingHtml(event) {
    if (!event.rating) return "";
    const score = Number(event.rating.score).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return `<span class="rating">${score}<span>/5</span></span>`;
  }

  function cardHtml(event) {
    const meta = catMeta(event.category);
    const active = event.id === state.selectedId ? " active" : "";
    return `<article class="card${active}" style="--cat:${meta.color}">
      ${shotHtml(event)}
      <button type="button" class="card-open" data-id="${escapeHtml(event.id)}">
        <div class="card-top"><span class="badge">${escapeHtml(meta.label)}</span><span class="time">${escapeHtml(event.time)}</span></div>
        <h3>${escapeHtml(event.title)}</h3>
        <p class="meta">${escapeHtml(event.venue)} · ${escapeHtml(event.city)}</p>
      </button>
        <div class="row">
        ${ratingHtml(event)}
        <span class="price${event.free ? " free" : ""}">${escapeHtml(event.price)}</span>
      </div>
    </article>`;
  }

  function renderSpans() {
    const choices = [
      ["today", "Aujourd’hui"],
      ["weekend", "Week-end"],
      ["week", "7 jours"],
      ["month", "Ce mois"],
      ["day", "Un jour"],
    ];
    els.spanRow.innerHTML = choices
      .map(([key, label]) => `<button type="button" class="span-chip${state.span === key ? " on" : ""}" data-span="${key}" role="tab" aria-selected="${state.span === key}">${label}</button>`)
      .join("");
  }

  function renderIntents() {
    const keys = QUICK_INTENTS.filter((key) => data.categories[key]);
    if (state.intent !== "all" && !keys.includes(state.intent) && data.categories[state.intent]) keys.push(state.intent);
    const chips = [`<button type="button" class="intent-chip${state.intent === "all" ? " on" : ""}" data-intent="all" role="tab" aria-selected="${state.intent === "all"}">Tout <em>${countForIntent("all")}</em></button>`];
    keys.forEach((key) => {
      const meta = catMeta(key);
      const on = state.intent === key;
      chips.push(`<button type="button" class="intent-chip${on ? " on" : ""}" data-intent="${key}" role="tab" aria-selected="${on}"><i style="background:${meta.color}"></i>${escapeHtml(meta.label)} <em>${countForIntent(key)}</em></button>`);
    });
    chips.push(`<button type="button" class="intent-chip more" data-intent="more">Autres</button>`);
    els.intentRow.innerHTML = chips.join("");
  }

  function renderTimeline() {
    const single = state.span === "day";
    els.dayRail.hidden = !single;
    if (!single) {
      const intent = state.intent !== "all" ? catMeta(state.intent).label : "";
      els.whenLabel.textContent = intent ? `${intent} · ${spanTitle()}` : spanTitle();
      return;
    }
    const left = els.dayRail.scrollLeft;
    els.dayRail.innerHTML = timelineDays()
      .map((day) => {
        const label = dayParts(day);
        const count = filtered(day).length;
        const cls = [
          "tick",
          day === state.day ? "active" : "",
          day === today ? "today" : "",
          count ? "has" : "empty",
        ].filter(Boolean).join(" ");
        return `<button type="button" class="${cls}" data-day="${day}" role="tab" aria-selected="${day === state.day}">
          <span class="dow">${label.dow}</span>
          <span class="num">${label.n}</span>
          <span class="mark"></span>
        </button>`;
      })
      .join("");
    els.dayRail.scrollLeft = left;
    const intent = state.intent !== "all" ? `${catMeta(state.intent).label} · ` : "";
    els.whenLabel.textContent = `${intent}${state.day === today ? "Aujourd’hui" : dayParts(state.day).long}`;
  }

  function renderActiveFilters() {
    const chips = [];
    if (state.city !== "all") chips.push(`<button type="button" class="kill" data-clear="city">${escapeHtml(state.city)} ×</button>`);
    if (state.freeOnly) chips.push(`<button type="button" class="kill" data-clear="free">Gratuit ×</button>`);
    if (state.query) chips.push(`<button type="button" class="kill" data-clear="query">« ${escapeHtml(state.query)} » ×</button>`);
    els.activeFilters.innerHTML = chips.join("");
    const n = filterCount();
    els.filterBadge.hidden = n === 0;
    els.filterBadge.textContent = String(n);
  }

  function renderCities() {
    const cities = citiesInView();
    if (state.city !== "all" && !cities.includes(state.city)) state.city = "all";
    els.cityRail.innerHTML =
      `<button type="button" class="city-chip${state.city === "all" ? " active" : ""}" data-city="all">Tout le 06</button>` +
      cities
        .map((city) => `<button type="button" class="city-chip${state.city === city ? " active" : ""}" data-city="${escapeHtml(city)}">${escapeHtml(city)}</button>`)
        .join("");
  }

  function renderFilters() {
    const allOn = state.intent === "all";
    els.filters.innerHTML = `<button type="button" class="chip${allOn ? " active" : " dim"}" data-cat="all">Tout voir</button>` +
      Object.entries(data.categories)
      .map(([key, meta]) => {
        const on = state.intent === key;
        return `<button type="button" class="chip${on ? " active" : " dim"}" data-cat="${key}" style="--cat:${meta.color}"><span style="color:${meta.color}">●</span> ${escapeHtml(meta.label)}</button>`;
      })
      .join("");
    els.freeToggle.classList.toggle("on", state.freeOnly);
    els.freeToggle.setAttribute("aria-pressed", String(state.freeOnly));
  }

  function renderList(target, events) {
    target.innerHTML = events.length
      ? events.map(cardHtml).join("")
      : `<div class="empty">Rien sur cette période.<br>Élargis les jours, ou choisis une autre envie.</div>`;
  }

  function renderGrouped(target, events) {
    const days = activeDays();
    if (days.length < 2) {
      renderList(target, events);
      return;
    }
    const blocks = [];
    days.forEach((day) => {
      const items = events.filter((event) => nextDayInView(event) === day);
      if (!items.length) return;
      const heading = day === today ? `Aujourd’hui · ${dayParts(day).long}` : dayParts(day).long;
      blocks.push(`<h3 class="day-head">${escapeHtml(heading)}</h3>${items.map(cardHtml).join("")}`);
    });
    target.innerHTML = blocks.length
      ? blocks.join("")
      : `<div class="empty">Rien sur cette période.<br>Élargis les jours, ou choisis une autre envie.</div>`;
  }

  function renderRide() {
    const event = data.events.find((item) => item.id === state.selectedId);
    if (!event || !passes(event, state.view === "cal" ? null : undefined)) {
      state.selectedId = null;
      els.ride.hidden = true;
      document.body.classList.remove("riding");
      return;
    }
    const meta = catMeta(event.category);
    const source = /^https?:\/\//i.test(event.url || "")
      ? `<a href="${escapeHtml(event.url)}" target="_blank" rel="noopener">Source</a>`
      : "";
    els.rideBody.innerHTML = `
      ${shotHtml(event)}
      <p class="ride-kicker" style="color:${meta.color}">${escapeHtml(meta.label)} · ${escapeHtml(event.time || "horaire libre")}</p>
      ${event.rating ? `<p class="rating-line">${ratingHtml(event)} · ${escapeHtml(event.rating.source || "")}</p>` : ""}
      <h3>${escapeHtml(event.title)}</h3>
      <p class="where">${escapeHtml(event.venue)}${event.city ? ` · ${escapeHtml(event.city)}` : ""}</p>
      <p class="desc">${escapeHtml(event.description)}</p>
      <span class="price-tag${event.free ? " free" : ""}">${escapeHtml(event.price)}</span>
      <div class="ride-actions">
        <a class="go" href="${directionsUrl(event)}" target="_blank" rel="noopener">Y aller</a>
        ${source}
      </div>`;
    els.ride.hidden = false;
    document.body.classList.add("riding");
  }

  function monthLabel(date) {
    return date.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  }

  function renderCalendar() {
    const year = state.cal.getFullYear();
    const month = state.cal.getMonth();
    els.calTitle.textContent = monthLabel(state.cal);
    const first = new Date(year, month, 1);
    const startPad = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startPad; i += 1) cells.push(`<button type="button" class="cal-cell out" disabled>·</button>`);
    for (let day = 1; day <= daysInMonth; day += 1) {
      const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const events = filtered(iso);
      const colors = [...new Set(events.map((event) => catMeta(event.category).color))].slice(0, 3);
      const dots = colors.map((color) => `<i style="background:${color}"></i>`).join("");
      const cls = ["cal-cell", iso === state.day ? "on" : "", iso === today ? "today" : ""].filter(Boolean).join(" ");
      cells.push(`<button type="button" class="${cls}" data-day="${iso}"><span class="n">${day}</span><span class="dots">${dots}</span></button>`);
    }
    els.calGrid.innerHTML = cells.join("");
    const dayEvents = filtered(state.day);
    els.calStats.textContent = sameMonth(state.day, state.cal)
      ? `${dayEvents.length} sortie${dayEvents.length > 1 ? "s" : ""} · ${dayParts(state.day).long}`
      : "Choisis un jour";
    renderList(els.calEvents, sameMonth(state.day, state.cal) ? dayEvents : []);
  }

  const FAMILIES = {
    theatre: "spectacle",
    humour: "spectacle",
    danse: "spectacle",
    concert: "musique",
    soiree: "musique",
    cinema: "cinema",
    expo: "expo",
    conference: "expo",
    famille: "famille",
    lecture: "lecture",
    gastronomie: "table",
    festival: "air",
    sport: "air",
  };

  const FAMILY_PALETTE = {
    spectacle: { light: "#F29A98", base: "#DF7776", dark: "#C85F64" },
    musique: { light: "#8DB8EC", base: "#6E9FDF", dark: "#5686CC" },
    cinema: { light: "#B397E5", base: "#9677D2", dark: "#7B5FBD" },
    expo: { light: "#F0CF7A", base: "#DDB25B", dark: "#C59642" },
    famille: { light: "#8BCBA6", base: "#68B488", dark: "#4E9A70" },
    lecture: { light: "#9EAAE5", base: "#7F8FD4", dark: "#6878BE" },
    table: { light: "#F1B184", base: "#E39360", dark: "#CC7447" },
    air: { light: "#83D2CD", base: "#5CB8B2", dark: "#409D99" },
  };

  function familyGlyph(kind, color) {
    if (kind === "spectacle") {
      return `<ellipse cx="17.6" cy="23.2" rx="6.2" ry="8.2" fill="#fff"/>
        <path d="M13.4 18.4h8.2" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>
        <ellipse cx="15.5" cy="21.5" rx="1.55" ry="1.9" fill="${color}"/>
        <ellipse cx="19.9" cy="21.5" rx="1.55" ry="1.9" fill="${color}"/>
        <path fill="${color}" d="M14.6 27.4c.55-2 1.7-3 3-3s2.45 1 3 3c-.55-1.15-1.6-1.75-3-1.75s-2.45.6-3 1.75z"/>
        <ellipse cx="30.5" cy="24.2" rx="6.4" ry="8.3" fill="#fff"/>
        <path d="M26.2 19.2h8.4" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>
        <ellipse cx="28.3" cy="22.3" rx="1.6" ry="1.95" fill="${color}"/>
        <ellipse cx="32.7" cy="22.3" rx="1.6" ry="1.95" fill="${color}"/>
        <path fill="${color}" d="M27.2 26.5c.5 2.3 1.85 3.6 3.3 3.6s2.8-1.3 3.3-3.6c-.5 1.25-1.75 1.9-3.3 1.9s-2.8-.65-3.3-1.9z"/>`;
    }
    if (kind === "musique") {
      return `<path fill="#fff" d="M31 14.2v11.6a3.2 3.2 0 1 1-2-2.9V17l-8 2.1v8.6a3.2 3.2 0 1 1-2-2.9V17.4l12-3.2z"/>`;
    }
    if (kind === "cinema") {
      return `<rect x="13.2" y="20.4" width="21.6" height="11.6" rx="1.6" fill="#fff"/>
        <path fill="#fff" d="M13.6 20.4l2.5-5h2.8l-2.5 5h-2.8zm5.4 0l2.5-5h2.8l-2.5 5h-2.8zm5.4 0l2.5-5h2.8l-2.5 5h-2.8zm5.4 0l2.2-4.4h2.4l-1.6 4.4h-3z"/>`;
    }
    if (kind === "expo") {
      return `<rect x="14.2" y="15.4" width="19.6" height="16.2" rx="2" fill="none" stroke="#fff" stroke-width="2.1"/>
        <circle cx="19.2" cy="19.6" r="1.45" fill="#fff"/>
        <path fill="#fff" d="M16.2 29.2l5-5.2 3.1 3.1 2.5-2.7 4.8 4.8H16.2z"/>`;
    }
    if (kind === "famille") {
      return `<circle cx="18" cy="17" r="3.2" fill="#fff"/>
        <circle cx="30" cy="17" r="3.2" fill="#fff"/>
        <path fill="#fff" d="M11.8 29.5v-4.4c0-3.9 2.7-6.2 6.2-6.2s6.2 2.3 6.2 6.2v4.4H11.8z"/>
        <path fill="#fff" d="M23.8 29.5v-4.4c0-3.9 2.7-6.2 6.2-6.2s6.2 2.3 6.2 6.2v4.4H23.8z"/>
        <circle cx="24" cy="26.2" r="5.1" fill="${color}"/>
        <circle cx="24" cy="24.6" r="2.15" fill="#fff"/>
        <path fill="#fff" d="M19.9 31.4v-1.2c0-2.55 1.8-4.1 4.1-4.1s4.1 1.55 4.1 4.1v1.2h-8.2z"/>`;
    }
    if (kind === "lecture") {
      return `<path fill="#fff" d="M13.8 16.4c2.5-1.2 5-1.1 7.6.3v15.2c-2.6-1.3-5.1-1.4-7.6-.2V16.4zm12.8.3c2.6-1.4 5.1-1.5 7.6-.2v15.2c-2.5-1.2-5-.9-7.6.3V16.7z"/>`;
    }
    if (kind === "table") {
      return `<path fill="#fff" d="M18.4 13.8h2.15v7.1h-2.15zm4.55 0h2.15v7.1h-2.15zm4.5 0H29.6v7.1h-2.15zM18.2 20.6h11.6c0 2.1-2.1 3.5-4 3.9V33h-3.6v-8.5c-1.9-.4-4-1.8-4-3.9z"/>`;
    }
    if (kind === "air") {
      return `<circle cx="24" cy="24" r="4.1" fill="#fff"/>
        <g fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round">
          <path d="M24 13.6v3.1M24 31.3v3.1M13.6 24h3.1M31.3 24h3.1M16.6 16.6l2.2 2.2M29.2 29.2l2.2 2.2M31.4 16.6l-2.2 2.2M18.8 29.2l-2.2 2.2"/>
        </g>`;
    }
    return `<circle cx="24" cy="24" r="4" fill="#fff"/>`;
  }

  function pinSvg(category, selected) {
    const kind = FAMILIES[category] || "expo";
    const palette = FAMILY_PALETTE[kind];
    const color = palette.base;
    const bubble = "M24 2C12.4 2 4 10.4 4 22c0 14.2 20 34 20 34s20-19.8 20-34C44 10.4 35.6 2 24 2z";
    const ring = selected
      ? `<path d="${bubble}" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>`
      : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="60" viewBox="0 0 48 60">
      <defs>
        <linearGradient id="marker-fill" x1="8" y1="5" x2="39" y2="52" gradientUnits="userSpaceOnUse">
          <stop stop-color="${palette.light}"/>
          <stop offset=".58" stop-color="${palette.base}"/>
          <stop offset="1" stop-color="${palette.dark}"/>
        </linearGradient>
        <clipPath id="marker-clip"><path d="${bubble}"/></clipPath>
      </defs>
      <path d="${bubble}" transform="translate(0 1.5)" fill="rgba(7,22,28,.24)"/>
      ${ring}
      <path d="${bubble}" fill="url(#marker-fill)" stroke="rgba(7,22,28,.28)" stroke-width="1.15" stroke-linejoin="round"/>
      <path d="M22 18L43 35L24 56L17 29z" fill="rgba(48,43,67,.1)" clip-path="url(#marker-clip)"/>
      ${familyGlyph(kind, color)}
    </svg>`;
  }

  function spreadPosition(event, events) {
    const same = events.filter((item) => Math.abs(item.lat - event.lat) < 0.0002 && Math.abs(item.lng - event.lng) < 0.0002);
    if (same.length < 2) return { lat: Number(event.lat), lng: Number(event.lng) };
    const i = same.findIndex((item) => item.id === event.id);
    const angle = (2 * Math.PI * i) / same.length;
    return { lat: Number(event.lat) + Math.cos(angle) * 0.00045, lng: Number(event.lng) + Math.sin(angle) * 0.00045 };
  }

  function clearMarkers() {
    state.markers.forEach((marker) => marker.setMap(null));
    state.markers.clear();
  }

  function renderMarkers(events) {
    if (!state.map || !window.google?.maps) return;
    clearMarkers();
    const pinned = events.filter(hasPoint);
    pinned.forEach((event) => {
      const selected = event.id === state.selectedId;
      const marker = new google.maps.Marker({
        position: spreadPosition(event, pinned),
        map: state.map,
        title: event.title,
        zIndex: selected ? 1000 : 1,
        icon: {
          url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(pinSvg(event.category, selected))}`,
          scaledSize: new google.maps.Size(selected ? 48 : 40, selected ? 60 : 50),
          anchor: new google.maps.Point(selected ? 24 : 20, selected ? 58 : 49),
        },
      });
      marker.addListener("click", () => {
        ignoreMapClick = true;
        selectEvent(event.id, true);
        setTimeout(() => {
          ignoreMapClick = false;
        }, 350);
      });
      state.markers.set(event.id, marker);
    });
  }

  function mapPadding() {
    const narrow = window.matchMedia("(max-width: 979px)").matches;
    const bar = document.querySelector(".datebar");
    const top = bar ? Math.ceil(bar.getBoundingClientRect().bottom) + 16 : 210;
    return narrow
      ? { top, right: 28, bottom: 96, left: 28 }
      : { top: 90, right: 80, bottom: 80, left: 80 };
  }

  function departmentBounds() {
    return new google.maps.LatLngBounds(
      { lat: 43.48, lng: 6.78 },
      { lat: 44.34, lng: 7.58 }
    );
  }

  function fitDepartment() {
    if (!state.map) return;
    state.map.fitBounds(departmentBounds(), mapPadding());
  }

  function fitToEvents(events) {
    const pinned = events.filter(hasPoint);
    if (!state.map || !pinned.length) return;
    const bounds = new google.maps.LatLngBounds();
    pinned.forEach((event) => bounds.extend({ lat: Number(event.lat), lng: Number(event.lng) }));
    state.map.fitBounds(bounds, mapPadding());
    google.maps.event.addListenerOnce(state.map, "idle", () => {
      if (state.map.getZoom() > 13) state.map.setZoom(13);
    });
  }

  function focusPin(event) {
    if (!state.map || !hasPoint(event)) return;
    const marker = state.markers.get(event.id);
    const pos = marker ? marker.getPosition() : new google.maps.LatLng(Number(event.lat), Number(event.lng));
    state.map.panTo(pos);
    if (state.map.getZoom() < 13) state.map.setZoom(14);
    const narrow = window.matchMedia("(max-width: 979px)").matches;
    setTimeout(() => state.map.panBy(0, narrow ? 120 : 40), 260);
  }

  function selectEvent(id, fly) {
    state.selectedId = id;
    const event = data.events.find((item) => item.id === id);
    render();
    if (fly && event && state.view === "map") focusPin(event);
  }

  function clearSelection() {
    if (!state.selectedId) return;
    state.selectedId = null;
    render();
  }

  function setDay(day, fit = true) {
    state.span = "day";
    state.day = day;
    state.selectedId = null;
    state.cal = dayDate(day);
    render();
    if (fit && state.view === "map") fitToEvents(filtered());
    const active = els.dayRail.querySelector(".active");
    if (active) active.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }

  function setSpan(span) {
    state.span = span;
    state.selectedId = null;
    if (span === "today" || span === "week" || span === "weekend" || span === "month") state.day = today;
    render();
    if (state.view === "map") fitToEvents(filtered());
  }

  function setIntent(intent) {
    state.intent = !intent || intent === "all" || state.intent === intent ? "all" : intent;
    state.selectedId = null;
    render();
    if (state.view === "map") fitToEvents(filtered());
  }

  function setView(view) {
    state.view = view;
    document.body.dataset.view = view;
    els.viewList.hidden = view !== "list";
    els.viewCal.hidden = view !== "cal";
    document.querySelectorAll(".tabbar button").forEach((button) => {
      const on = button.dataset.view === view;
      button.classList.toggle("on", on);
      if (on) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    render();
    if (view === "map" && state.map) {
      google.maps.event.trigger(state.map, "resize");
      if (state.selectedId) {
        const event = data.events.find((item) => item.id === state.selectedId);
        if (event) focusPin(event);
      } else fitDepartment();
    }
  }

  function openSheet() {
    els.sheet.hidden = false;
    els.backdrop.hidden = false;
  }

  function closeSheet() {
    els.sheet.hidden = true;
    els.backdrop.hidden = true;
  }

  function render() {
    const events = filtered();
    const label = `${events.length} sortie${events.length > 1 ? "s" : ""}`;
    els.stats.textContent = label;
    els.listStats.textContent = `${label} · ${spanTitle()}`;
    renderSpans();
    renderIntents();
    renderTimeline();
    renderActiveFilters();
    renderCities();
    renderFilters();
    renderGrouped(els.list, events);
    renderCalendar();
    renderMarkers(events);
    document.body.classList.toggle("days-open", state.daysOpen);
    const daysToggle = document.getElementById("daysToggle");
    if (daysToggle) {
      daysToggle.textContent = state.daysOpen ? "Réduire" : "Jours";
      daysToggle.setAttribute("aria-expanded", String(state.daysOpen));
    }
    renderRide();
    const datebar = document.querySelector(".datebar");
    if (datebar && getComputedStyle(datebar).display !== "none") {
      const bottom = Math.ceil(datebar.getBoundingClientRect().bottom);
      document.documentElement.style.setProperty("--list-top", `${bottom + 16}px`);
      document.documentElement.style.setProperty("--panel-bottom", `${bottom + 12}px`);
    }
  }

  function onCardClick(event) {
    const opener = event.target.closest("[data-id]");
    if (!opener) return;
    selectEvent(opener.dataset.id, false);
  }

  function bindUi() {
    els.spanRow.addEventListener("click", (event) => {
      const button = event.target.closest("[data-span]");
      if (!button) return;
      setSpan(button.dataset.span);
    });
    els.intentRow.addEventListener("click", (event) => {
      const button = event.target.closest("[data-intent]");
      if (!button) return;
      if (button.dataset.intent === "more") {
        openSheet();
        return;
      }
      setIntent(button.dataset.intent);
    });
    els.dayRail.addEventListener("click", (event) => {
      const button = event.target.closest("[data-day]");
      if (!button) return;
      setDay(button.dataset.day, true);
    });
    els.cityRail.addEventListener("click", (event) => {
      const button = event.target.closest("[data-city]");
      if (!button) return;
      state.city = button.dataset.city;
      state.selectedId = null;
      render();
      if (state.view === "map") fitToEvents(filtered());
    });
    els.filters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-cat]");
      if (!button) return;
      setIntent(button.dataset.cat);
      closeSheet();
    });
    els.freeToggle.addEventListener("click", () => {
      state.freeOnly = !state.freeOnly;
      state.selectedId = null;
      render();
    });
    els.search.addEventListener("input", () => {
      state.query = els.search.value.trim();
      render();
    });
    els.activeFilters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-clear]");
      if (!button) return;
      if (button.dataset.clear === "city") state.city = "all";
      if (button.dataset.clear === "free") state.freeOnly = false;
      if (button.dataset.clear === "query") {
        state.query = "";
        els.search.value = "";
      }
      if (button.dataset.clear === "intent") state.intent = "all";
      render();
    });
    document.getElementById("filterBtn").addEventListener("click", openSheet);
    document.getElementById("closeSheet").addEventListener("click", closeSheet);
    els.backdrop.addEventListener("click", closeSheet);
    document.getElementById("resetFilters").addEventListener("click", () => {
      state.city = "all";
      state.freeOnly = false;
      state.query = "";
      els.search.value = "";
      state.intent = "all";
      state.selectedId = null;
      render();
      closeSheet();
    });
    els.list.addEventListener("click", onCardClick);
    els.calEvents.addEventListener("click", onCardClick);
    els.calGrid.addEventListener("click", (event) => {
      const button = event.target.closest("[data-day]");
      if (!button) return;
      setDay(button.dataset.day, false);
    });
    document.getElementById("calPrev").addEventListener("click", () => shiftMonth(-1));
    document.getElementById("calNext").addEventListener("click", () => shiftMonth(1));
    document.querySelector(".tabbar").addEventListener("click", (event) => {
      const button = event.target.closest("[data-view]");
      if (!button) return;
      setView(button.dataset.view);
    });
    document.getElementById("daysToggle").addEventListener("click", () => {
      state.daysOpen = !state.daysOpen;
      render();
      if (state.view === "map" && state.map) {
        google.maps.event.trigger(state.map, "resize");
        fitDepartment();
      }
    });
    document.getElementById("recenterBtn").addEventListener("click", () => fitDepartment());
    document.getElementById("surpriseBtn").addEventListener("click", () => {
      const pool = filtered().filter(hasPoint);
      const events = pool.length ? pool : filtered();
      if (!events.length) {
        toast("Rien à montrer pour ce filtre.");
        return;
      }
      const pick = events[Math.floor(Math.random() * events.length)];
      setView("map");
      selectEvent(pick.id, true);
    });
    document.getElementById("rideClose").addEventListener("click", clearSelection);
    els.enterBtn.addEventListener("click", () => {
      els.splash.classList.add("hide");
      setTimeout(() => {
        if (!state.map) return;
        google.maps.event.trigger(state.map, "resize");
        fitDepartment();
      }, 160);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeSheet();
        clearSelection();
      }
    });
  }

  function showMapError(message) {
    if (!els.mapError) return;
    els.mapError.hidden = false;
    els.mapError.textContent = message;
  }

  const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");

  function mapTheme() {
    const dark = colorScheme.matches;
    return {
      styles: dark ? NIGHT_STYLE : DAY_STYLE,
      backgroundColor: dark ? "#0a242e" : "#d5ebe7",
    };
  }

  function initMap() {
    const key = window.MAPS_CONFIG?.googleMapsApiKey;
    if (!key || key === "YOUR_GOOGLE_MAPS_API_KEY") {
      showMapError("Clé Google Maps manquante — en local, crée js/config.js ; sur Railway, définis GOOGLE_MAPS_API_KEY.");
      return;
    }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=fr&region=FR&callback=initAgendaMap`;
    script.async = true;
    script.defer = true;
    script.onerror = () => showMapError("Impossible de charger Google Maps — vérifie la clé API et les restrictions HTTP.");
    document.head.appendChild(script);
  }

  window.initAgendaMap = function initAgendaMap() {
    try {
      state.map = new google.maps.Map(document.getElementById("map"), {
        center: { lat: 43.91, lng: 7.18 },
        zoom: 9,
        minZoom: 8,
        maxZoom: 18,
        disableDefaultUI: true,
        zoomControl: !window.matchMedia("(max-width: 979px)").matches,
        zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_CENTER },
        gestureHandling: "greedy",
        ...mapTheme(),
        clickableIcons: false,
      });
      colorScheme.addEventListener("change", () => state.map.setOptions(mapTheme()));
      state.map.addListener("click", () => {
        if (ignoreMapClick) return;
        clearSelection();
      });
      if (window.ResizeObserver) {
        new ResizeObserver(() => google.maps.event.trigger(state.map, "resize")).observe(document.getElementById("map"));
      }
      state.ready = true;
      render();
      if (!els.splash.classList.contains("hide")) return;
      fitDepartment();
    } catch (error) {
      console.error(error);
      showMapError("Erreur d’initialisation Google Maps. Active Maps JavaScript API pour cette clé.");
    }
  };

  function paintCover() {
    const season = document.getElementById("splashSeason");
    const bill = document.getElementById("splashBill");
    const list = document.getElementById("splashPicks");
    if (season) {
      const label = dayDate(today).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
      season.textContent = `Alpes-Maritimes · ${label}`;
    }
    if (!bill || !list) return;
    const days = new Set(weekendDays());
    const preferred = new Set(["theatre", "concert", "danse", "cinema", "humour"]);
    const seen = new Set();
    const picks = data.events
      .filter((event) => (event.days || []).some((day) => days.has(day)))
      .filter((event) => {
        const city = String(event.city || "").trim();
        return city && city !== "Alpes-Maritimes";
      })
      .filter((event) => {
        const key = String(event.title || "").trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => {
        const rank = (event) => (preferred.has(event.category) ? 0 : 1);
        return rank(a) - rank(b) || String(a.time || "99:99").localeCompare(String(b.time || "99:99"));
      });
    const chosen = [];
    const usedCities = new Set();
    for (const event of picks) {
      const city = event.city || "";
      if (usedCities.has(city)) continue;
      chosen.push(event);
      usedCities.add(city);
      if (chosen.length === 3) break;
    }
    for (const event of picks) {
      if (chosen.length === 3) break;
      if (!chosen.includes(event)) chosen.push(event);
    }
    picks.length = 0;
    picks.push(...chosen.slice(0, 3));
    if (picks.length < 2) {
      bill.hidden = true;
      return;
    }
    list.innerHTML = picks.map((event) => `
      <li>
        <span>${escapeHtml(event.title)}</span>
        <span class="where">${escapeHtml(event.city || "")}</span>
      </li>`).join("");
    bill.hidden = false;
  }

  if (els.sources) {
    els.sources.innerHTML = data.meta.sources
      .map((source) => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.name)}</a>`)
      .join(" · ");
  }
  paintCover();
  bindUi();
  render();
  initMap();
})();
