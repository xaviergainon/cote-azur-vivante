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

  function dayLabel(iso) {
    const d = new Date(iso + "T12:00:00");
    const dow = d.toLocaleDateString("fr-FR", { weekday: "short" }).replace(".", "");
    const dom = d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
    return { dow, dom };
  }

  function todayIso() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

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

  const state = {
    day: data.meta.days.includes(todayIso()) ? todayIso() : data.meta.days[0] || todayIso(),
    categories: new Set(Object.keys(data.categories)),
    city: "all",
    freeOnly: false,
    query: "",
    selectedId: null,
    map: null,
    markers: new Map(),
    infoWindow: null,
    ready: false,
  };

  const els = {
    dayRail: document.getElementById("dayRail"),
    cityRail: document.getElementById("cityRail"),
    filters: document.getElementById("filters"),
    recenterBtn: document.getElementById("recenterBtn"),
    list: document.getElementById("list"),
    stats: document.getElementById("stats"),
    search: document.getElementById("search"),
    freeToggle: document.getElementById("freeToggle"),
    sources: document.getElementById("sources"),
    splash: document.getElementById("splash"),
    enterBtn: document.getElementById("enterBtn"),
    mapError: document.getElementById("mapError"),
  };

  function catMeta(cat) {
    return data.categories[cat] || { label: cat, color: "#3ecfc2", icon: "✦" };
  }

  function matches(event) {
    if (!event.days.includes(state.day)) return false;
    if (state.city !== "all" && event.city !== state.city) return false;
    if (!state.categories.has(event.category)) return false;
    if (state.freeOnly && !event.free) return false;
    if (state.query) {
      const q = state.query.toLowerCase();
      const blob = [event.title, event.city, event.venue, event.description, event.category]
        .join(" ")
        .toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  }

  function filtered() {
    return data.events.filter(matches).sort((a, b) => {
      const ta = a.time || "";
      const tb = b.time || "";
      return ta.localeCompare(tb, "fr");
    });
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function popupHtml(event) {
    const meta = catMeta(event.category);
    return `
      <div class="gmap-popup">
        <p class="popup-title">${escapeHtml(event.title)}</p>
        <p class="popup-meta">${escapeHtml(meta.label)} · ${escapeHtml(event.time)} · ${escapeHtml(event.city)}<br>${escapeHtml(event.venue)}</p>
        <p class="popup-desc">${escapeHtml(event.description)}</p>
        <p class="popup-meta">${escapeHtml(event.price)} · ${escapeHtml(event.source)}</p>
        ${/^https?:\/\//i.test(event.url || "") ? `<a class="popup-link" href="${escapeHtml(event.url)}" target="_blank" rel="noopener">Voir la source →</a>` : ""}
      </div>
    `;
  }

  function citiesForDay() {
    const set = new Set(
      data.events.filter((e) => e.days.includes(state.day)).map((e) => e.city)
    );
    return [...set].sort((a, b) => a.localeCompare(b, "fr"));
  }

  function spreadPosition(event, events) {
    const same = events.filter(
      (e) => Math.abs(e.lat - event.lat) < 0.0002 && Math.abs(e.lng - event.lng) < 0.0002
    );
    if (same.length < 2) return { lat: event.lat, lng: event.lng };
    const i = same.findIndex((e) => e.id === event.id);
    const angle = (2 * Math.PI * i) / same.length;
    const d = 0.00042;
    return { lat: event.lat + Math.cos(angle) * d, lng: event.lng + Math.sin(angle) * d };
  }

  function pinSvg(color, selected) {
    const stroke = selected ? "#fff" : "rgba(255,255,255,0.9)";
    const r = selected ? 14 : 12;
    return `
      <svg width="36" height="44" viewBox="0 0 36 44" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id="s" x="-30%" y="-20%" width="160%" height="160%">
            <feDropShadow dx="0" dy="3" stdDeviation="2.5" flood-opacity="0.45"/>
          </filter>
        </defs>
        <path filter="url(#s)" fill="${color}" stroke="${stroke}" stroke-width="2"
          d="M18 2C10.3 2 4 8.3 4 16c0 10.5 14 24 14 24s14-13.5 14-24C32 8.3 25.7 2 18 2z"/>
        <circle cx="18" cy="16" r="${r * 0.45}" fill="#0b1f28" opacity="0.35"/>
      </svg>`;
  }

  function renderDays() {
    els.dayRail.innerHTML = data.meta.days
      .map((day) => {
        const label = dayLabel(day);
        const active = day === state.day ? " active" : "";
        const isToday = day === todayIso() ? " today" : "";
        return `<button type="button" class="day-btn${active}${isToday}" data-day="${day}" role="tab" aria-selected="${day === state.day}">
          <span class="dow">${label.dow}</span>
          <span class="dom">${label.dom}</span>
        </button>`;
      })
      .join("");
  }

  function renderCities() {
    if (!els.cityRail) return;
    const cities = citiesForDay();
    if (state.city !== "all" && !cities.includes(state.city)) state.city = "all";
    const allActive = state.city === "all" ? " active" : "";
    els.cityRail.innerHTML =
      `<button type="button" class="city-chip${allActive}" data-city="all">Tout le 06</button>` +
      cities
        .map((city) => {
          const active = state.city === city ? " active" : "";
          return `<button type="button" class="city-chip${active}" data-city="${escapeHtml(city)}">${escapeHtml(city)}</button>`;
        })
        .join("");
  }

  function renderFilters() {
    els.filters.innerHTML = Object.entries(data.categories)
      .map(([key, meta]) => {
        const active = state.categories.has(key);
        return `<button type="button" class="chip${active ? " active" : " dim"}" data-cat="${key}" style="--cat:${meta.color}">
          <span style="color:${meta.color}">●</span> ${meta.label}
        </button>`;
      })
      .join("");
  }

  function renderList(events) {
    if (!events.length) {
      els.list.innerHTML = `<div class="empty">Rien pour ce filtre.<br>Change de jour ou élargis les catégories.</div>`;
      return;
    }

    els.list.innerHTML = events
      .map((event, i) => {
        const meta = catMeta(event.category);
        const active = event.id === state.selectedId ? " active" : "";
        return `<button type="button" class="card${active}" data-id="${event.id}" style="--cat:${meta.color}; animation-delay:${Math.min(i, 12) * 0.03}s">
          <div class="card-top">
            <span class="badge">${meta.label}</span>
            <span class="time">${escapeHtml(event.time)}</span>
          </div>
          <h3>${escapeHtml(event.title)}</h3>
          <p class="meta">${escapeHtml(event.venue)} · ${escapeHtml(event.city)}</p>
          <span class="price${event.free ? " free" : ""}">${escapeHtml(event.price)}</span>
        </button>`;
      })
      .join("");
  }

  function clearMarkers() {
    state.markers.forEach((marker) => marker.setMap(null));
    state.markers.clear();
  }

  function renderMarkers(events) {
    if (!state.map || !window.google?.maps) return;
    clearMarkers();

    const pinned = events.filter(
      (event) => Number.isFinite(Number(event.lat)) && Number.isFinite(Number(event.lng))
    );
    pinned.forEach((event) => {
      const meta = catMeta(event.category);
      const selected = event.id === state.selectedId;
      const marker = new google.maps.Marker({
        position: spreadPosition(event, pinned),
        map: state.map,
        title: event.title,
        zIndex: selected ? 1000 : 1,
        icon: {
          url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(pinSvg(meta.color, selected)),
          scaledSize: new google.maps.Size(selected ? 40 : 34, selected ? 48 : 42),
          anchor: new google.maps.Point(selected ? 20 : 17, selected ? 46 : 40),
        },
        animation: selected ? google.maps.Animation.BOUNCE : null,
      });

      if (selected) {
        setTimeout(() => marker.setAnimation(null), 700);
      }

      marker.addListener("click", () => selectEvent(event.id, false));
      state.markers.set(event.id, marker);
    });
  }

  function fitToEvents(events) {
    const pinned = events.filter(
      (event) => Number.isFinite(Number(event.lat)) && Number.isFinite(Number(event.lng))
    );
    if (!state.map || !pinned.length) return;
    const bounds = new google.maps.LatLngBounds();
    pinned.forEach((event) => bounds.extend({ lat: Number(event.lat), lng: Number(event.lng) }));
    state.map.fitBounds(bounds, { top: 80, right: 440, bottom: 80, left: 40 });
    const listener = google.maps.event.addListenerOnce(state.map, "bounds_changed", () => {
      if (state.map.getZoom() > 12) state.map.setZoom(12);
    });
    setTimeout(() => google.maps.event.removeListener(listener), 500);
  }

  function selectEvent(id, fly = true) {
    state.selectedId = id;
    const event = data.events.find((e) => e.id === id);
    if (!event || !state.map) return;

    document.querySelectorAll(".card").forEach((card) => {
      card.classList.toggle("active", card.dataset.id === id);
    });

    renderMarkers(filtered());

    const marker = state.markers.get(id);
    if (state.infoWindow) {
      state.infoWindow.setContent(popupHtml(event));
      state.infoWindow.open({ map: state.map, anchor: marker });
    }

    if (fly) {
      const pos = marker ? marker.getPosition() : { lat: event.lat, lng: event.lng };
      state.map.panTo(pos);
      if (state.map.getZoom() < 13) state.map.setZoom(13);
    }

    const card = els.list.querySelector(`[data-id="${id}"]`);
    if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function render() {
    const events = filtered();
    els.stats.innerHTML = `<strong>${events.length}</strong> manifestation${events.length > 1 ? "s" : ""} · ${dayLabel(state.day).dom}`;
    renderList(events);
    renderMarkers(events);
  }

  function renderSources() {
    els.sources.innerHTML = data.meta.sources
      .map((s) => `<a href="${s.url}" target="_blank" rel="noopener">${s.name}</a>`)
      .join(" · ");
  }

  function bindUi() {
    els.dayRail.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-day]");
      if (!btn) return;
      state.day = btn.dataset.day;
      state.selectedId = null;
      if (state.infoWindow) state.infoWindow.close();
      renderDays();
      renderCities();
      render();
      fitToEvents(filtered());
    });

    if (els.cityRail) {
      els.cityRail.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-city]");
        if (!btn) return;
        state.city = btn.dataset.city;
        state.selectedId = null;
        if (state.infoWindow) state.infoWindow.close();
        renderCities();
        render();
        fitToEvents(filtered());
      });
    }

    if (els.recenterBtn) {
      els.recenterBtn.addEventListener("click", () => fitToEvents(filtered()));
    }

    const sheetToggle = document.getElementById("sheetToggle");
    if (sheetToggle) {
      sheetToggle.addEventListener("click", () => {
        const mapFocus = document.body.classList.toggle("map-focus");
        sheetToggle.textContent = mapFocus ? "Liste" : "Carte";
        sheetToggle.setAttribute("aria-pressed", String(mapFocus));
        requestAnimationFrame(() => {
          if (!state.map) return;
          google.maps.event.trigger(state.map, "resize");
          fitToEvents(filtered());
        });
      });
    }

    els.filters.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-cat]");
      if (!btn) return;
      const cat = btn.dataset.cat;
      if (state.categories.has(cat)) {
        if (state.categories.size === 1) return;
        state.categories.delete(cat);
      } else {
        state.categories.add(cat);
      }
      renderFilters();
      render();
    });

    els.list.addEventListener("click", (e) => {
      const card = e.target.closest("[data-id]");
      if (!card) return;
      selectEvent(card.dataset.id, true);
    });

    els.search.addEventListener("input", (e) => {
      state.query = e.target.value.trim();
      render();
    });

    els.freeToggle.addEventListener("click", () => {
      state.freeOnly = !state.freeOnly;
      els.freeToggle.classList.toggle("on", state.freeOnly);
      els.freeToggle.setAttribute("aria-pressed", String(state.freeOnly));
      render();
    });

    els.enterBtn.addEventListener("click", () => {
      els.splash.classList.add("hide");
      setTimeout(() => {
        if (state.map) {
          google.maps.event.trigger(state.map, "resize");
          fitToEvents(filtered());
        }
      }, 120);
    });
  }

  function showMapError(message) {
    if (!els.mapError) return;
    els.mapError.hidden = false;
    els.mapError.textContent = message;
  }

  function initMap() {
    const key = window.MAPS_CONFIG?.googleMapsApiKey;
    if (!key || key === "YOUR_GOOGLE_MAPS_API_KEY") {
      showMapError(
        "Clé Google Maps manquante — en local, crée js/config.js ; sur Railway, définis GOOGLE_MAPS_API_KEY."
      );
      return;
    }

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=fr&region=FR&callback=initAgendaMap`;
    script.async = true;
    script.defer = true;
    script.onerror = () =>
      showMapError("Impossible de charger Google Maps — vérifie la clé API et les restrictions HTTP.");
    document.head.appendChild(script);
  }

  window.initAgendaMap = function initAgendaMap() {
    try {
      state.map = new google.maps.Map(document.getElementById("map"), {
        center: { lat: 43.68, lng: 7.15 },
        zoom: 10,
        minZoom: 8,
        maxZoom: 18,
        disableDefaultUI: true,
        zoomControl: true,
        zoomControlOptions: { position: google.maps.ControlPosition.LEFT_BOTTOM },
        fullscreenControl: true,
        fullscreenControlOptions: { position: google.maps.ControlPosition.LEFT_BOTTOM },
        gestureHandling: "greedy",
        styles: NIGHT_STYLE,
        backgroundColor: "#0a242e",
        clickableIcons: false,
      });

      const narrow = window.matchMedia("(max-width: 860px)");
      const placeControls = () => {
        const position = narrow.matches
          ? google.maps.ControlPosition.RIGHT_CENTER
          : google.maps.ControlPosition.LEFT_BOTTOM;
        state.map.setOptions({
          zoomControlOptions: { position },
          fullscreenControlOptions: { position },
        });
      };
      placeControls();
      narrow.addEventListener("change", () => {
        placeControls();
        google.maps.event.trigger(state.map, "resize");
      });
      if (window.ResizeObserver) {
        new ResizeObserver(() => google.maps.event.trigger(state.map, "resize")).observe(
          document.getElementById("map")
        );
      }

      state.infoWindow = new google.maps.InfoWindow({ maxWidth: 280 });
      state.map.addListener("click", () => {
        if (state.infoWindow) state.infoWindow.close();
        state.selectedId = null;
        render();
      });
      state.ready = true;
      render();
    } catch (err) {
      console.error(err);
      showMapError("Erreur d’initialisation Google Maps. Active Maps JavaScript API pour cette clé.");
    }
  };

  renderDays();
  renderCities();
  renderFilters();
  renderSources();
  bindUi();
  els.stats.innerHTML = "Chargement de la carte…";
  renderList(filtered());
  initMap();
})();
