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
  const QUICK_INTENTS = ["theatre", "concert", "cinema", "famille", "expo"];
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

  function parseClock(text) {
    const match = /(\d{1,2})\s*h\s*(\d{2})?/i.exec(text || "");
    if (!match) return null;
    const h = Number(match[1]);
    const min = Number(match[2] || 0);
    if (h > 23 || min > 59) return null;
    return { h, min };
  }

  function icsEscape(value) {
    return String(value || "")
      .replace(/\\/g, "\\\\")
      .replace(/\r?\n/g, "\\n")
      .replace(/,/g, "\\,")
      .replace(/;/g, "\\;");
  }

  function fold(line) {
    const chunks = [];
    let rest = line;
    while (rest.length > 73) {
      chunks.push(rest.slice(0, 73));
      rest = ` ${rest.slice(73)}`;
    }
    chunks.push(rest);
    return chunks.join("\r\n");
  }

  function formatWall(date) {
    const p = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}T${p(date.getHours())}${p(date.getMinutes())}00`;
  }

  function vevent(event, day) {
    const range = String(event.time || "").split(/\s*[–—-]\s*/);
    const startClock = parseClock(range[0]);
    const endClock = range[1] ? parseClock(range[1]) : null;
    const uid = `${event.id}-${day}@cote-azur-vivante`;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const lines = ["BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${stamp}`];
    if (!startClock) {
      const [y, m, d] = day.split("-");
      const next = new Date(Number(y), Number(m) - 1, Number(d) + 1);
      const p = (n) => String(n).padStart(2, "0");
      lines.push(`DTSTART;VALUE=DATE:${day.replace(/-/g, "")}`);
      lines.push(`DTEND;VALUE=DATE:${next.getFullYear()}${p(next.getMonth() + 1)}${p(next.getDate())}`);
    } else {
      const [y, m, d] = day.split("-").map(Number);
      const start = new Date(y, m - 1, d, startClock.h, startClock.min, 0);
      const end = endClock
        ? new Date(y, m - 1, d, endClock.h, endClock.min, 0)
        : new Date(start.getTime() + 2 * 60 * 60 * 1000);
      if (end <= start) end.setDate(end.getDate() + 1);
      lines.push(`DTSTART:${formatWall(start)}`);
      lines.push(`DTEND:${formatWall(end)}`);
    }
    lines.push(
      `SUMMARY:${icsEscape(event.title)}`,
      `LOCATION:${icsEscape([event.venue, event.address, event.city].filter(Boolean).join(", "))}`,
      `DESCRIPTION:${icsEscape([event.description, event.time, event.price, event.url].filter(Boolean).join("\n"))}`,
      "END:VEVENT"
    );
    return lines.map(fold).join("\r\n");
  }

  function downloadIcs(events, filename) {
    const occurrences = events.flatMap((event) => {
      const days = state.view === "cal"
        ? event.days.filter((day) => sameMonth(day, state.cal))
        : event.days.filter((day) => activeDays().includes(day));
      return days.map((day) => vevent(event, day));
    });
    if (!occurrences.length) {
      toast("Rien à exporter avec ces filtres.");
      return;
    }
    const body = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Cote d Azur Vivante//FR",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      ...occurrences,
      "END:VCALENDAR",
    ].join("\r\n");
    const blob = new Blob([body], { type: "text/calendar;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
    toast(occurrences.length > 1 ? `${occurrences.length} sorties prêtes pour ton agenda.` : "Sortie prête pour ton agenda.");
  }

  function exportCurrent() {
    if (state.view === "cal") {
      const monthEvents = data.events.filter((event) => passes(event, null) && event.days.some((day) => sameMonth(day, state.cal)));
      const stamp = `${state.cal.getFullYear()}-${String(state.cal.getMonth() + 1).padStart(2, "0")}`;
      downloadIcs(monthEvents, `cote-azur-${stamp}.ics`);
      return;
    }
    downloadIcs(filtered(), `cote-azur-${state.span}.ics`);
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
        <span class="price${event.free ? " free" : ""}">${escapeHtml(event.price)}</span>
        <button type="button" class="mini" data-export="${escapeHtml(event.id)}">Agenda</button>
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
      <h3>${escapeHtml(event.title)}</h3>
      <p class="where">${escapeHtml(event.venue)}${event.city ? ` · ${escapeHtml(event.city)}` : ""}</p>
      <p class="desc">${escapeHtml(event.description)}</p>
      <span class="price-tag${event.free ? " free" : ""}">${escapeHtml(event.price)}</span>
      <div class="ride-actions">
        <a class="go" href="${directionsUrl(event)}" target="_blank" rel="noopener">Y aller</a>
        <button type="button" data-export="${escapeHtml(event.id)}">Dans mon agenda</button>
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

  function pinSvg(color, selected) {
    const r = selected ? 16 : 13;
    return `<svg width="36" height="46" viewBox="0 0 36 46" xmlns="http://www.w3.org/2000/svg">
      <path fill="${color}" stroke="${selected ? "#fff" : "rgba(255,255,255,.85)"}" stroke-width="2" d="M18 2C10 2 4 8.2 4 16.2 4 27 18 44 18 44s14-17 14-27.8C32 8.2 26 2 18 2z"/>
      <circle cx="18" cy="16" r="${r * 0.42}" fill="#07161c"/>
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
      const meta = catMeta(event.category);
      const selected = event.id === state.selectedId;
      const marker = new google.maps.Marker({
        position: spreadPosition(event, pinned),
        map: state.map,
        title: event.title,
        zIndex: selected ? 1000 : 1,
        icon: {
          url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(pinSvg(meta.color, selected))}`,
          scaledSize: new google.maps.Size(selected ? 42 : 32, selected ? 54 : 42),
          anchor: new google.maps.Point(selected ? 21 : 16, selected ? 52 : 40),
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

  function fitToEvents(events) {
    const pinned = events.filter(hasPoint);
    if (!state.map || !pinned.length) return;
    const bounds = new google.maps.LatLngBounds();
    pinned.forEach((event) => bounds.extend({ lat: Number(event.lat), lng: Number(event.lng) }));
    const narrow = window.matchMedia("(max-width: 979px)").matches;
    const bar = document.querySelector(".datebar");
    const top = bar ? Math.ceil(bar.getBoundingClientRect().bottom) + 16 : 210;
    state.map.fitBounds(bounds, narrow
      ? { top, right: 28, bottom: 96, left: 28 }
      : { top: 90, right: 80, bottom: 80, left: 80 });
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

  function exportOne(event) {
    const day = nextDayInView(event) || event.days[0];
    downloadIcs([{ ...event, days: day ? [day] : event.days }], `sortie-${event.id}.ics`);
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
      } else fitToEvents(filtered());
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
    const exp = event.target.closest("[data-export]");
    if (exp) {
      const item = data.events.find((entry) => entry.id === exp.dataset.export);
      if (item) exportOne(item);
      return;
    }
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
    ["exportList", "exportCal", "exportSheet"].forEach((id) => {
      document.getElementById(id).addEventListener("click", exportCurrent);
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
        fitToEvents(filtered());
      }
    });
    document.getElementById("recenterBtn").addEventListener("click", () => fitToEvents(filtered()));
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
    els.ride.addEventListener("click", (event) => {
      const exp = event.target.closest("[data-export]");
      if (exp) {
        const item = data.events.find((entry) => entry.id === exp.dataset.export);
        if (item) exportOne(item);
      }
    });
    els.enterBtn.addEventListener("click", () => {
      els.splash.classList.add("hide");
      try { sessionStorage.setItem("cav-in", "1"); } catch (error) { /* ignore */ }
      setTimeout(() => {
        if (!state.map) return;
        google.maps.event.trigger(state.map, "resize");
        fitToEvents(filtered());
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
        center: { lat: 43.7, lng: 7.25 },
        zoom: 11,
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
      fitToEvents(filtered());
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
  try {
    if (sessionStorage.getItem("cav-in")) els.splash.classList.add("hide");
  } catch (error) { /* ignore */ }
  render();
  initMap();
})();
