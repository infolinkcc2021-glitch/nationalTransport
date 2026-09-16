/* National Transport PLC — Live GPS tracking.
 * Connects to the ZTS GPS fleet-control API (Admin → GPS Settings).
 * Falls back to a realistic simulation when the feed is off/unavailable.
 */
"use strict";

(function () {
  var CITIES = {
    "Addis Ababa": [9.03, 38.74],
    "Adama": [8.54, 39.27],
    "Dire Dawa": [9.6, 41.87],
    "Hawassa": [7.05, 38.48],
    "Mekelle": [13.49, 39.47],
    "Bahir Dar": [11.59, 37.39],
    "Gondar": [12.61, 37.46],
    "Jimma": [7.67, 36.83],
    "Dessie": [11.13, 39.63],
    "Wolaita Sodo": [6.86, 37.76],
    "Arba Minch": [6.03, 37.55],
    "Bishoftu": [8.75, 38.98],
    "Harar": [9.31, 42.12],
  };
  var STATUS_COLORS = { idle: "#1c9a62", transit: "#d98c1f", loaded: "#6a4fc2", stop: "#8a98a8", maintenance: "#cf3f3f" };
  var GPS_STATUS = {
    idle: { label: "Idle", color: "#1c9a62" },
    moving: { label: "Moving", color: "#d98c1f" },
    stationary: { label: "Stationary", color: "#8a98a8" },
  };

  var map, markers = {}, markerTypes = {}, selMarker = null, selPulseEl = null, selectedPlate = null, sim = {}, liveMap = {}, liveMode = false, feedMsg = "", lastTick = Date.now(), statusFilter = "", ageFilter = "", fleetFilter = "", speedFilter = [];
  /* --- Speed-violation tracker (daily, persisted to localStorage) --- */
  var violationTopN = 10;
  var SPEED_VIOL_KEY = "ntp_speed_violations";
  var SPEED_MAX_KEY = "ntp_daily_max_speeds";  /* plate → { date, maxSpeed } */
  var SPEED_THRESHOLD = 80; /* km/h */
  var DRIVE_START_KEY = "ntp_driving_start"; /* plate → { date, startMs } */
  function loadDriveStart() { try { return JSON.parse(localStorage.getItem(DRIVE_START_KEY) || "{}"); } catch (e) { return {}; } }
  function saveDriveStart(obj) { localStorage.setItem(DRIVE_START_KEY, JSON.stringify(obj)); }
  function todayKey() { var d = new Date(); return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function loadViolations() { try { return JSON.parse(localStorage.getItem(SPEED_VIOL_KEY) || "{}"); } catch (e) { return {}; } }
  function saveViolations(obj) { localStorage.setItem(SPEED_VIOL_KEY, JSON.stringify(obj)); }
  function loadDailyMax() { try { return JSON.parse(localStorage.getItem(SPEED_MAX_KEY) || "{}"); } catch (e) { return {}; } }
  function saveDailyMax(obj) { localStorage.setItem(SPEED_MAX_KEY, JSON.stringify(obj)); }
  /* Track per-vehicle max speed for today — updated on every tick. */
  function trackDailyMax(plate, currentSpeed) {
    var today = todayKey();
    var all = loadDailyMax();
    var rec = all[plate];
    if (!rec || rec.date !== today) { rec = { date: today, maxSpeed: 0 }; all[plate] = rec; }
    if (currentSpeed > rec.maxSpeed) rec.maxSpeed = currentSpeed;
    all[plate] = rec;
    saveDailyMax(all);
    return rec.maxSpeed;
  }
  function getDailyMax(plate) {
    var today = todayKey();
    var all = loadDailyMax();
    var rec = all[plate];
    return (rec && rec.date === today) ? rec.maxSpeed : 0;
  }
  function trackAllDailyMax() {
    var today = todayKey();
    var all = loadDailyMax();
    var changed = false;
    fleetEntries().forEach(function (e) {
      var sp = Math.max(Number(e.speed) || 0, Number(e.maxSpeedToday) || 0);
      if (sp <= 0) return;
      var rec = all[e.plate];
      if (!rec || rec.date !== today) { rec = { date: today, maxSpeed: 0 }; all[e.plate] = rec; changed = true; }
      if (sp > rec.maxSpeed) { rec.maxSpeed = sp; changed = true; }
    });
    if (changed) saveDailyMax(all);
  }
  function trackDrivingStart() {
    var today = todayKey();
    var all = loadDriveStart();
    var now = Date.now();
    var changed = false;
    fleetEntries().forEach(function (e) {
      var moving = e.moving === true || e.moving === "1" || e.moving === 1;
      var rec = all[e.plate];
      if (moving) {
        if (!rec || rec.date !== today) { all[e.plate] = { date: today, startMs: now }; changed = true; }
      } else {
        if (rec && rec.date === today) { delete all[e.plate]; changed = true; }
      }
    });
    if (changed) saveDriveStart(all);
  }
  function getDrivingDurationMs(plate) {
    var today = todayKey();
    var all = loadDriveStart();
    var rec = all[plate];
    if (!rec || rec.date !== today) return 0;
    return Date.now() - rec.startMs;
  }
  function getTodayViolations() { var all = loadViolations(); return all[todayKey()] || []; }
  function getTodaySummary() {
    var records = getTodayViolations();
    var byPlate = {};
    records.forEach(function (r) {
      if (!byPlate[r.plate]) byPlate[r.plate] = { plate: r.plate, fleet: r.fleet || "Lemi", driver: r.driver || "", maxSpeed: r.speed, count: 0, times: [] };
      var p = byPlate[r.plate];
      p.driver = r.driver || p.driver;
      p.fleet = r.fleet || p.fleet;
      if (r.speed > p.maxSpeed) p.maxSpeed = r.speed;
      p.count++;
      p.times.push(r.time);
    });
    return Object.values(byPlate);
  }

  /* ---- Backend violation sync ---- */
  var backendViolations = [];  /* latest summary from backend API */
  function fetchBackendViolations() {
    if (typeof API === "undefined" || !API.isOnline()) return Promise.resolve();
    return API.req("GET", "/speed-violations/summary").then(function (data) {
      backendViolations = Array.isArray(data) ? data : [];
    }).catch(function () {});
  }
  function pushBackendViolations(records) {
    if (typeof API === "undefined" || !API.isOnline() || !records.length) return Promise.resolve();
    var today = todayKey();
    var batch = records.map(function (r) {
      return { plate: r.plate, fleet: r.fleet || "Lemi", driver: r.driver || "", speed: r.speed || 0, eventDate: today, eventTime: r.time || Date.now() };
    });
    return API.req("POST", "/speed-violations", { violations: batch }).catch(function () {});
  }
  function mergedTodaySummary() {
    var local = getTodaySummary();
    var byPlate = {};
    local.forEach(function (r) { byPlate[r.plate] = r; });
    backendViolations.forEach(function (r) {
      var k = r.plate;
      if (!byPlate[k]) {
        byPlate[k] = { plate: k, fleet: r.fleet || "Lemi", driver: r.driver || "", maxSpeed: r.max_speed || 0, count: r.event_count || 0, times: [] };
      } else {
        if ((r.max_speed || 0) > byPlate[k].maxSpeed) byPlate[k].maxSpeed = r.max_speed;
        byPlate[k].count = Math.max(byPlate[k].count, r.event_count || 0);
        byPlate[k].fleet = r.fleet || byPlate[k].fleet;
        byPlate[k].driver = r.driver || byPlate[k].driver;
      }
    });
    return Object.values(byPlate);
  }

  var listEl = document.getElementById("trackItems");
  var searchEl = document.getElementById("trackSearch");
  var detailEl = document.getElementById("trackDetail");
  var fleetBtn = document.getElementById("fleetBtn");
  var fleetDd = document.getElementById("fleetDd");
  var fleetMenu = document.getElementById("fleetMenu");
  var statusBtn = document.getElementById("statusBtn");
  var statusDd = document.getElementById("statusDd");
  var statusMenu = document.getElementById("statusMenu");
  var ageBtn = document.getElementById("ageBtn");
  var ageDd = document.getElementById("ageDd");
  var ageMenu = document.getElementById("ageMenu");
  var speedBtn = document.getElementById("speedBtn");
  var speedDd = document.getElementById("speedDd");
  var speedMenu = document.getElementById("speedMenu");
  var locBtn = document.getElementById("locBtn");
  var locDd = document.getElementById("locDd");
  var locMenu = document.getElementById("locMenu");
  var locFilter = "";
  var destBtn = document.getElementById("destBtn");
  var destDd = document.getElementById("destDd");
  var destMenu = document.getElementById("destMenu");
  var destFilter = "";

  var DAY = 86400;
  var AGE_OPTS = { 1: "1+ day", 2: "2+ days", 3: "3+ days", 4: "4+ days", 5: "5+ days", 7: "1 week", 30: "1 month" };
  /* Seconds → DD:HH:MM:SS (e.g. 134 days → "134D:19H:44M:47S"). */
  function fmtDuration(sec) {
    if (sec === null || sec === undefined || isNaN(sec)) return "";
    var s = Math.max(0, Math.floor(sec));
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); var r = s - m * 60;
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d + "D:" + p(h) + "H:" + p(m) + "M:" + p(r) + "S";
  }
  function ageDays(e) { return (e.age !== null && e.age !== undefined) ? e.age / DAY : null; }
  function fleetOf(plate) {
    var v = getVehicles().find(function (x) { return normPlate(x.plate) === normPlate(plate); });
    return v ? (v.fleet || "Lemi") : "";
  }
  function fleetOk(e) { return !fleetFilter || (e.fleet || "") === fleetFilter; }
  /* Overspeed filter: vehicles of the ticked fleet(s) with today's max speed above 80 km/h. */
  function todaySpeed(e) {
    /* Check ZTS-provided maxSpeedToday first, then our self-tracked daily max, then current speed. */
    var t = Number(e.maxSpeedToday);
    if (isFinite(t) && t > 0) return t;
    var dm = getDailyMax(e.plate);
    if (dm > 0) return dm;
    return Number(e.speed) || 0;
  }
  function speedOk(e) {
    return !speedFilter.length || (speedFilter.indexOf((e.fleet || "")) !== -1 && todaySpeed(e) > SPEED_THRESHOLD);
  }
  function locOk(e) {
    if (!locFilter) return true;
    var hay = ((e.locationText || "") + " " + (e.trip ? e.trip.startPoint + " " + e.trip.destination : "")).toLowerCase();
    return hay.indexOf(locFilter.toLowerCase()) !== -1;
  }
  /* ---- Destination / heading filter ---- */
  function destOf(e) {
    return (e.trip && e.trip.destination) ? String(e.trip.destination) : "";
  }
  function bearingFrom(lat1, lng1, lat2, lng2) {
    var toRad = Math.PI / 180, phi1 = lat1 * toRad, phi2 = lat2 * toRad;
    var dLng = (lng2 - lng1) * toRad;
    var y = Math.sin(dLng) * Math.cos(phi2);
    var x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function haversineKm(lat1, lng1, lat2, lng2) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function destCoords(name) {
    var n = String(name || "").toLowerCase().replace(/[^a-z]/g, "");
    var keys = Object.keys(CITIES);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase().replace(/[^a-z]/g, "") === n) return CITIES[keys[i]];
    }
    return null;
  }
  /* Heading state of a vehicle toward the given destination:
   * "At destination" (< 15 km), "En route" (trip-planned OR heading within 60°),
   * "Off route", or "" when unknown. */
  function headState(e, dest) {
    if (!dest || !e.pos) return "";
    var dc = destCoords(dest);
    if (!dc) return "";
    var distKm = haversineKm(e.pos.lat, e.pos.lng, dc[0], dc[1]);
    if (distKm <= 15) return "At destination";
    if (destOf(e) && destOf(e).toLowerCase().replace(/[^a-z]/g, "") === String(dest).toLowerCase().replace(/[^a-z]/g, "")) return "En route";
    var heading = Number(e.angle);
    if (!isFinite(heading)) return "Off route";
    var brng = bearingFrom(e.pos.lat, e.pos.lng, dc[0], dc[1]);
    var diff = Math.abs(((heading - brng + 540) % 360) - 180);
    return diff <= 60 ? "En route" : "Off route";
  }
  function destOk(e) {
    if (!destFilter) return true;
    var st = headState(e, destFilter);
    return st === "At destination" || st === "En route";
  }
  function originCoords(e) {
    if (!e.trip || !e.trip.startPoint) return null;
    return destCoords(e.trip.startPoint);
  }
  /* Road km left to the filtered destination:
   * prefers the trip's known road km (or the DISTANCES table), scaled by how much of the
   * straight-line origin→dest leg is already covered; falls back to straight-line × 1.25. */
  function kmLeft(e) {
    if (!e.pos || !destFilter) return null;
    var dc = destCoords(destFilter);
    if (!dc) return null;
    var oc = originCoords(e);
    var total = null;
    if (e.trip && e.trip.km) total = Number(e.trip.km);
    else if (e.trip && e.trip.startPoint) total = lookupDistance(e.trip.startPoint, destFilter);
    if (total && oc && dc) {
      var routeLen = haversineKm(oc[0], oc[1], dc[0], dc[1]);
      if (routeLen > 0) {
        var done = haversineKm(oc[0], oc[1], e.pos.lat, e.pos.lng);
        var frac = Math.min(1, Math.max(0, done / routeLen));
        return Math.max(0, Math.round(total * (1 - frac)));
      }
    }
    if (total) return Math.round(total);
    var straight = haversineKm(e.pos.lat, e.pos.lng, dc[0], dc[1]);
    return Math.round(straight * 1.25);
  }
  function filteredEntries() {
    return fleetEntries().filter(function (e) {
      if (!fleetOk(e)) return false;
      if (!locOk(e)) return false;
      if (!destOk(e)) return false;
      var ok = !statusFilter || e.gpsStatus === statusFilter;
      if (ok && statusFilter === "stationary" && ageFilter) {
        var d = ageDays(e);
        ok = d !== null && d >= Number(ageFilter);
      }
      if (ok && !speedOk(e)) ok = false;
      return ok;
    });
  }

  /* ---- Speed-violation tracking ---- */
  function updateSpeedViolations() {
    var now = Date.now();
    var all = fleetEntries();
    var violators = all.filter(function (e) { return todaySpeed(e) > SPEED_THRESHOLD; });
    if (!violators.length) return;
    var allViolations = loadViolations();
    var today = todayKey();
    if (!allViolations[today]) allViolations[today] = [];
    var todayRecs = allViolations[today];
    var lastByPlate = {};
    todayRecs.forEach(function (r) { lastByPlate[r.plate] = r.time; });
    violators.forEach(function (e) {
      var sp = todaySpeed(e);
      /* avoid duplicate for same plate within 60-second window */
      if (lastByPlate[e.plate] && (now - lastByPlate[e.plate]) < 60000) return;
      todayRecs.push({ plate: e.plate, fleet: e.fleet || "Lemi", driver: e.driver || "", speed: Math.round(sp), time: now });
      lastByPlate[e.plate] = now;
    });
    /* keep only today's records, cap at 5000 */
    if (todayRecs.length > 5000) allViolations[today] = todayRecs.slice(-5000);
    /* prune records older than 30 days */
    var cutoff = now - 30 * 86400000;
    Object.keys(allViolations).forEach(function (k) {
      var arr = allViolations[k];
      if (arr.length && arr[arr.length - 1].time < cutoff) delete allViolations[k];
    });
    saveViolations(allViolations);
    /* push new records to backend */
    var newRecs = todayRecs.filter(function (r) { return (now - r.time) < 120000; });
    if (newRecs.length) pushBackendViolations(newRecs);
  }

  function violationFleetCounts() {
    var lemi = 0, nt = 0;
    var all = fleetEntries();
    all.forEach(function (e) { if (todaySpeed(e) > SPEED_THRESHOLD) { if ((e.fleet || "") === "NT") nt++; else lemi++; } });
    return { lemi: lemi, nt: nt, total: lemi + nt };
  }

  function renderSpeedAlertBadge() {
    var plates = {};
    alertData.forEach(function (a) { if (a.plate) plates[normPlate(a.plate)] = 1; });
    var merged = mergedTodaySummary();
    merged.forEach(function (r) { if (r.plate) plates[normPlate(r.plate)] = 1; });
    var count = Object.keys(plates).length;
    var badge = document.getElementById("speedAlertBadge");
    if (badge) {
      badge.textContent = count;
      badge.style.display = count ? "" : "none";
    }
  }

  function renderViolationCounts() {
    var c = violationFleetCounts();
    var el = document.getElementById("feedViolationCounts");
    if (!el) return;
    if (c.total === 0) { el.innerHTML = ""; return; }
    el.innerHTML =
      '<span class="sc sc-violation" title="Lemi vehicles > ' + SPEED_THRESHOLD + ' km/h">Lemi > ' + SPEED_THRESHOLD + ': <b>' + c.lemi + '</b></span>' +
      '<span class="sc sc-violation" title="NT vehicles > ' + SPEED_THRESHOLD + ' km/h">NT > ' + SPEED_THRESHOLD + ': <b>' + c.nt + '</b></span>' +
      '<span class="sc sc-violation" style="border-color:var(--red,#d0342c);font-weight:700" title="Total speed violations">Total > ' + SPEED_THRESHOLD + ': <b>' + c.total + '</b></span>';
  }

  var alertCategoryFilter = "all";
  var alertSearchText = "";
  var alertData = []; /* merged alerts from ZTS + local violations */

  function fleetOfPlate(plate) {
    var v = getVehicles().find(function (x) { return normPlate(x.plate) === normPlate(plate); });
    return v ? (v.fleet || "Lemi") : "Lemi";
  }
  function ownerLabel(plate) {
    var f = fleetOfPlate(plate);
    return f === "NT" ? "National Transport PLC" : "Lemi National Transport";
  }
  function alertCatCount(cat) {
    if (cat === "all") return alertData.length;
    return alertData.filter(function (a) { return a.category === cat; }).length;
  }
  function alertCatLabel(cat) {
    var m = { speeding: "Speeding Alert", continuous_driving: "Continuous Driving", device: "Device Plug/Unplug Alert", zone: "Zone Control" };
    return m[cat] || cat;
  }
  function alertCatIcon(cat) {
    var m = { speeding: "&#9889;", continuous_driving: "&#128663;", device: "&#128268;", zone: "&#128205;" };
    return m[cat] || "&#128276;";
  }

  function generateAlerts() {
    var alerts = [];
    var seen = {};
    var all = fleetEntries();
    all.forEach(function (e) {
      var sp = todaySpeed(e);
      if (sp > SPEED_THRESHOLD) {
        seen[e.plate] = 1;
        alerts.push({ plate: e.plate, company: ownerLabel(e.plate), alertType: "Speeding", category: "speeding", speed: Math.round(sp), location: e.locationText || "", time: e.time || "" });
      }
      if (e.moving === true || e.moving === "1" || e.moving === 1) {
        var driveMs = getDrivingDurationMs(e.plate);
        if (driveMs > 25200000) {
          var hours = Math.round(driveMs / 3600000 * 10) / 10;
          seen[e.plate] = 1;
          alerts.push({ plate: e.plate, company: ownerLabel(e.plate), alertType: "Continuous Driving (" + hours + "h)", category: "continuous_driving", speed: Math.round(Number(e.speed) || 0), location: e.locationText || "", time: e.time || "" });
        }
      }
    });
    var today = mergedTodaySummary();
    today.forEach(function (r) {
      if (seen[r.plate]) { if (r.maxSpeed > (seen[r.plate] || 0)) { var idx = alerts.findIndex(function (a) { return a.plate === r.plate; }); if (idx >= 0) alerts[idx].speed = r.maxSpeed; } return; }
      seen[r.plate] = r.maxSpeed || 1;
      alerts.push({ plate: r.plate, company: r.fleet === "NT" ? "National Transport PLC" : "Lemi National Transport", alertType: "Speeding", category: "speeding", speed: r.maxSpeed || 0, location: "", time: "" });
    });
    return alerts;
  }

  function showSpeedAlert() {
    var body = document.getElementById("speedAlertBody");
    if (!body) return;
    body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)"><b>Loading alerts...</b></div>';
    document.getElementById("speedAlertModal").classList.add("open");

    updateSpeedViolations();
    alertCategoryFilter = "all";
    alertSearchText = "";

    var cfg = getGpsConfig();
    var accounts = gpsAccounts();
    var promises = accounts.map(function (a) {
      if (typeof ztsFetchAlerts !== "function") return Promise.resolve([]);
      return ztsFetchAlerts(a).catch(function () { return []; });
    });
    var localAlerts = generateAlerts();

    Promise.all(promises).then(function (results) {
      var seen = {};
      alertData = [];
      results.forEach(function (list) {
        if (!Array.isArray(list)) return;
        list.forEach(function (a) {
          if (!a || a.category === "other") return;
          var key = normPlate(a.plate) + "|" + a.category;
          if (seen[key]) return;
          seen[key] = 1;
          alertData.push(a);
        });
      });
      localAlerts.forEach(function (a) {
        var key = normPlate(a.plate) + "|" + a.category;
        if (seen[key]) return;
        seen[key] = 1;
        alertData.push(a);
      });
      renderAlertModal();
    });
  }

  function renderAlertModal() {
    var body = document.getElementById("speedAlertBody");
    if (!body) return;
    var cats = ["speeding", "continuous_driving", "device", "zone"];
    var total = alertData.length;

    /* summary counts */
    var summaryHtml = '<div style="font-size:.95rem;font-weight:700;margin-bottom:6px">' + total + ' open alerts</div>';
    summaryHtml += '<div class="alert-cat-tabs">';
    summaryHtml += '<button class="alert-cat-tab' + (alertCategoryFilter === "all" ? " on" : "") + '" data-cat="all"><b>' + total + '</b><span>All</span></button>';
    cats.forEach(function (c) {
      var cnt = alertCatCount(c);
      summaryHtml += '<button class="alert-cat-tab' + (alertCategoryFilter === c ? " on" : "") + '" data-cat="' + c + '"><b>' + cnt + '</b><span>' + alertCatLabel(c) + '</span></button>';
    });
    summaryHtml += '</div>';

    /* search */
    summaryHtml += '<div style="margin:10px 0"><input type="text" id="alertSearchInput" class="input" placeholder="Search vehicle, company, alert..." value="' + esc(alertSearchText) + '" autocomplete="off" style="width:100%;padding:8px 12px;font-size:.82rem"></div>';

    /* filtered list */
    var filtered = alertData.filter(function (a) {
      if (alertCategoryFilter !== "all" && a.category !== alertCategoryFilter) return false;
      if (alertSearchText) {
        var q = alertSearchText.toLowerCase();
        var hay = (a.plate + " " + a.company + " " + a.alertType).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    summaryHtml += '<div class="alert-list">';
    if (!filtered.length) {
      summaryHtml += '<div style="padding:30px;text-align:center;color:var(--muted)">No alerts found</div>';
    }
    filtered.forEach(function (a) {
      var f = fleetOfPlate(a.plate);
      var company = a.company || ownerLabel(a.plate);
      summaryHtml += '<div class="alert-item" data-plate="' + esc(a.plate) + '" style="cursor:pointer;padding:10px 14px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:600;font-size:.85rem">' + esc(f) + ' ' + esc(a.plate) + '</div>' +
          '<div style="font-size:.75rem;color:var(--muted)">' + esc(company) + '</div>' +
          (a.speed ? '<div style="font-size:.75rem;color:var(--red,#d0342c);font-weight:600">' + esc(String(a.speed)) + ' km/h</div>' : '') +
          (a.time ? '<div style="font-size:.72rem;color:var(--muted)">' + esc(String(a.time)) + '</div>' : '') +
          (a.location ? '<div style="font-size:.72rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px">' + esc(a.location) + '</div>' : '') +
        '</div>' +
        '<span style="font-size:.75rem;padding:3px 8px;border-radius:6px;background:' + (a.category === "speeding" ? "var(--red,#d0342c)" : a.category === "continuous_driving" ? "var(--amber,#d98c1f)" : a.category === "device" ? "var(--purple,#6a4fc2)" : "var(--muted)") + ';color:#fff;white-space:nowrap">' + esc(a.alertType || a.category) + '</span>' +
        '</div>';
    });
    summaryHtml += '</div>';

    body.innerHTML = summaryHtml;

    /* bind category tabs */
    body.querySelectorAll(".alert-cat-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        alertCategoryFilter = btn.dataset.cat;
        renderAlertModal();
      });
    });

    /* bind search */
    var searchEl = body.querySelector("#alertSearchInput");
    if (searchEl) {
      searchEl.addEventListener("input", function () {
        alertSearchText = searchEl.value;
        /* re-render list only, preserve focus */
        var listEl = body.querySelector(".alert-list");
        if (listEl) {
          var filtered2 = alertData.filter(function (a) {
            if (alertCategoryFilter !== "all" && a.category !== alertCategoryFilter) return false;
            if (alertSearchText) {
              var q = alertSearchText.toLowerCase();
        var hay = (a.plate + " " + a.company + " " + a.alertType + " " + (a.location || "")).toLowerCase();
              if (hay.indexOf(q) === -1) return false;
            }
            return true;
          });
          var h = "";
          if (!filtered2.length) h = '<div style="padding:30px;text-align:center;color:var(--muted)">No alerts found</div>';
          filtered2.forEach(function (a) {
            var f = fleetOfPlate(a.plate);
            h += '<div class="alert-item" data-plate="' + esc(a.plate) + '" style="cursor:pointer;padding:10px 14px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px">' +
              '<div style="flex:1;min-width:0">' +
                '<div style="font-weight:600;font-size:.85rem">' + esc(f) + ' ' + esc(a.plate) + '</div>' +
                '<div style="font-size:.75rem;color:var(--muted)">' + esc(a.company) + '</div>' +
                (a.speed ? '<div style="font-size:.75rem;color:var(--red,#d0342c);font-weight:600">' + esc(String(a.speed)) + ' km/h</div>' : '') +
                (a.time ? '<div style="font-size:.72rem;color:var(--muted)">' + esc(String(a.time)) + '</div>' : '') +
                (a.location ? '<div style="font-size:.72rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px">' + esc(a.location) + '</div>' : '') +
              '</div>' +
              '<span style="font-size:.75rem;padding:3px 8px;border-radius:6px;background:' + (a.category === "speeding" ? "var(--red,#d0342c)" : a.category === "continuous_driving" ? "var(--amber,#d98c1f)" : a.category === "device" ? "var(--purple,#6a4fc2)" : "var(--muted)") + ';color:#fff;white-space:nowrap">' + esc(a.alertType || a.category) + '</span>' +
              '</div>';
          });
          listEl.innerHTML = h;
          bindAlertItems();
        }
      });
      setTimeout(function () { searchEl.focus(); }, 100);
    }

    /* bind click on alert items */
    bindAlertItems();
  }

  function bindAlertItems() {
    var body = document.getElementById("speedAlertBody");
    if (!body) return;
    body.querySelectorAll(".alert-item").forEach(function (item) {
      item.addEventListener("click", function () {
        selectVehicle(item.dataset.plate);
        closeSpeedAlert();
      });
    });
  }

  window.closeSpeedAlert = function () { document.getElementById("speedAlertModal").classList.remove("open"); };
  function lerp(a, b, t) { return a + (b - a) * t; }
  function jitter(v, amp) { return v + (Math.random() - 0.5) * amp; }

  /* Offline place label for a coordinate when the feed sends no location text. */
  function locFor(pos) {
    if (!pos) return "";
    var best = "", bestD = Infinity;
    Object.keys(CITIES).forEach(function (c) {
      var c0 = CITIES[c];
      var d = Math.pow(c0[0] - pos.lat, 2) + Math.pow(c0[1] - pos.lng, 2);
      if (d < bestD) { bestD = d; best = c; }
    });
    if (!best) return "";
    return bestD < 0.05 ? best : "Near " + best;
  }

  /* Driver name from the local driver list (assigned via plate/trailer). */
  function localDriverName(id) {
    if (!id) return "";
    var d = getDrivers().find(function (x) { return x.id === id; });
    return d ? d.name : "";
  }

  /* GPS-derived status from real feed data: Moving (speed > 0 or moving flag),
   * Stationary (ignition off / parked / offline), Idle (engine on, not moving).
   * The feed's own flags (moving / online / ignition / raw status) are trusted first. */
  function toBool(v) {
    return v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true" ||
      String(v).toLowerCase() === "yes" || String(v).toLowerCase() === "on";
  }
  function isOff(v) {
    return v === false || v === 0 || v === "0" || String(v).toLowerCase() === "off" ||
      String(v).toLowerCase() === "false" || String(v).toLowerCase() === "no";
  }
  function gpsStatusOf(e) {
    if (e.moving !== undefined && e.moving !== null && e.moving !== "") {
      if (toBool(e.moving)) return "moving";
    }
    if (e.speed > 0) return "moving";
    if (e.online !== undefined && e.online !== null && e.online !== "" && !toBool(e.online)) return "stationary";
    if (e.ignition !== undefined && e.ignition !== null && e.ignition !== "") {
      if (isOff(e.ignition)) return "stationary";
      if (toBool(e.ignition)) return "idle";
    }
    if (e.stopped !== undefined && e.stopped !== null && toBool(e.stopped)) return "stationary";
    var st = String(e.rawStatus || "").toLowerCase();
    if (st) {
      if (/mov|driv|run|travel|en[- ]?route/.test(st)) return "moving";
      if (/stop|park|halt|still|station|offline|not[- ]?mov/.test(st)) return "stationary";
      if (/idle|acc|ignition on|working/.test(st)) return "idle";
    }
    if (e.status === "stop" || e.status === "maintenance") return "stationary";
    if (e.age !== undefined && e.age !== null && e.age > 1800) return "stationary";
    return "idle";
  }

  /* ---------------- Merge live feed + local fleet ---------------- */
  /* Normalize plates so the same truck from GPS is never counted twice
   * even if the plate formatting differs (spaces/dashes vs plain). */
  function normPlate(p) {
    var s = String(p || "").toUpperCase();
    var parts = s.split(/\s+/);
    while (parts.length > 1 && !/\d/.test(parts[0])) parts.shift();
    return parts.join("").replace(/[^A-Z0-9]/g, "");
  }

  function fleetEntries() {
    var liveByNorm = {};
    Object.keys(liveMap).forEach(function (p) { liveByNorm[normPlate(p)] = liveMap[p]; });
    var local = getVehicles().map(function (v) {
      var trip = getTrips().find(function (t) { return t.vehiclePlate === v.plate && t.status === "in_transit"; });
      var live = liveByNorm[normPlate(v.plate)];
      var e = {
        plate: v.plate,
        trailer: v.trailerNo,
        model: v.model,
        capacity: v.capacity,
        status: live ? (live.status || v.status) : (sim[v.plate] && sim[v.plate].speedKmh > 0 ? "transit" : v.status),
        statusSource: live ? "Live GPS" : "Local",
        ignition: live ? live.ignition : null,
        moving: live ? live.moving : null,
        online: live ? live.online : null,
        stopped: live ? live.stopped : null,
        rawStatus: live ? (live.rawStatus || "") : "",
        age: live ? live.age : null,
        ageText: live ? (live.ageText || "") : "",
        odometer: v.currentKm,
        trip: trip,
        driver: live ? (live.driver || localDriverName(v.assignedDriverId)) : (trip ? (localDriverName(trip.driverId) || localDriverName(v.assignedDriverId)) : localDriverName(v.assignedDriverId)),
        driverFayda: live ? "" : (trip ? (getDrivers().find(function (d) { return d.id === trip.driverId; }) || {}).faydaNo || "" : ""),
        locationText: live ? (live.location || locFor({ lat: live.lat, lng: live.lng })) : locFor(sim[v.plate] && sim[v.plate].pos),
        speed: live ? live.speed : (sim[v.plate] ? sim[v.plate].speedKmh || 0 : 0),
        maxSpeedToday: live ? (live.maxSpeedToday != null ? Number(live.maxSpeedToday) : null) : null,
        pos: live ? { lat: live.lat, lng: live.lng } : (sim[v.plate] && sim[v.plate].pos),
        time: live ? live.time : null,
        fuel: live ? live.fuel : null,
        angle: live ? live.angle : null,
      };
      e.fleet = v.fleet || "Lemi";
      e.gpsStatus = gpsStatusOf(e);
      return e;
    });
    Object.keys(liveMap).forEach(function (plate) {
      if (liveByNorm[normPlate(plate)]) return;
      var lv = liveMap[plate];
      var r = {
        plate: plate,
        model: lv.model || "ZTS Vehicle",
        capacity: null,
        status: lv.status || (lv.speed > 0 ? "transit" : "idle"),
        statusSource: "Live GPS",
        ignition: lv.ignition,
        moving: lv.moving,
        online: lv.online,
        stopped: lv.stopped,
        rawStatus: lv.rawStatus || "",
        age: lv.age,
        ageText: lv.ageText || "",
        odometer: null,
        trip: null,
        driver: lv.driver,
        locationText: lv.location || locFor({ lat: lv.lat, lng: lv.lng }),
        speed: lv.speed,
        maxSpeedToday: lv.maxSpeedToday != null ? Number(lv.maxSpeedToday) : null,
        pos: { lat: lv.lat, lng: lv.lng },
        time: lv.time,
        fuel: lv.fuel,
        angle: lv.angle,
      };
      r.fleet = fleetOf(plate);
      r.gpsStatus = gpsStatusOf(r);
      local.push(r);
    });
    return local;
  }

  /* ---------------- Simulation state (fallback) ---------------- */
  var CITY_COORDS = {
    "addis ababa": [9.03, 38.74], "hawassa": [7.05, 38.48], "mekelle": [13.4963, 39.4753],
    "adama": [8.54, 39.27], "gondar": [12.603, 37.454], "dessie": [11.13, 39.63],
    "jimma": [7.67, 36.83], "dire dawa": [9.59, 41.85], "harar": [9.31, 42.12],
    "bahir dar": [11.59, 37.39], "shashamane": [7.2, 38.6], "arba minch": [6.04, 37.55],
    "debre markos": [10.34, 37.73], "debre birhan": [9.68, 39.53], "woldia": [11.92, 39.59],
    "axum": [14.12, 38.72], "lalibela": [12.03, 39.05], "jijiga": [9.35, 42.8],
    "semera": [11.79, 41.0], "gambela": [8.25, 34.59], "assosa": [9.99, 35.26],
    "nekemte": [9.08, 36.56], "fitche": [9.68, 38.73], "debre zeit": [8.75, 38.98],
    "robit": [12.02, 39.55], "mekelle": [13.5, 39.48], "humera": [14.3, 36.6],
    "wendogenet": [7.07, 38.2], "dilla": [6.41, 38.31], "yirgacheffe": [6.16, 38.2],
    "arba minch": [6.04, 37.55], "bale": [7.07, 40.05], "jimma": [7.67, 36.83],
    "wolkite": [8.27, 37.78], "butajira": [8.12, 38.37], "boditi": [6.97, 38.38],
    "hosaina": [7.55, 37.85], "wachemo": [7.16, 38.09], "zeway": [8.02, 38.85],
    "modjo": [8.26, 39.03], "debre sina": [10.17, 39.55], "woreta": [11.99, 38.0],
    "semta": [12.22, 39.52], "maychew": [12.78, 39.54], "shire": [14.17, 36.56],
    "tekeze": [13.59, 37.84], "kemise": [10.72, 39.87], "finote selam": [10.58, 37.61],
    "injibara": [10.88, 37.32], "tullu milo": [7.12, 37.76], "agaro": [8.24, 36.58],
    "nekemte": [9.08, 36.56], "limmu": [9.25, 36.68], "woriedo": [11.92, 39.59],
    "kombo": [8.29, 35.98], "gore": [8.15, 35.54], "turmi": [4.92, 36.48],
    "marsabit": [2.33, 37.98], "isiolo": [0.35, 37.58], "meru": [0.06, 37.65],
    "nairobi": [-1.29, 36.82], "mombasa": [-4.05, 39.67], "dar es salaam": [-6.79, 39.28],
    "djibouti": [11.59, 43.15], "berbera": [10.44, 45.01], "djibouti city": [11.59, 43.15],
  };
  function cityCoords(name) {
    var key = String(name || "").toLowerCase().trim();
    return CITY_COORDS[key] || [9.03, 38.74];
  }
  function initSimulation() {
    getVehicles().forEach(function (v) {
      var trip = getTrips().find(function (t) { return t.vehiclePlate === v.plate && t.status === "in_transit"; });
      var st = sim[v.plate] = sim[v.plate] || {};
      st.from = cityCoords(trip ? trip.startPoint : "Addis Ababa");
      st.to = cityCoords(trip ? trip.destination : (v.status === "idle" ? "Addis Ababa" : "Hawassa"));
      st.progress = trip ? Math.random() * 0.55 : (v.status === "idle" ? 1 : 0.3);
      st.speed = 0.006 + Math.random() * 0.012;
      st.pos = trip ? { lat: lerp(st.from[0], st.to[0], st.progress), lng: lerp(st.from[1], st.to[1], st.progress) } : { lat: st.from[0], lng: st.from[1] };
    });
  }

  function stepSimulation() {
    getVehicles().forEach(function (v) {
      var st = sim[v.plate];
      if (!st || liveMap[v.plate]) return;
      var trip = getTrips().find(function (t) { return t.vehiclePlate === v.plate && t.status === "in_transit"; });
      if (trip) {
        st.from = cityCoords(trip.startPoint);
        st.to = cityCoords(trip.destination);
        st.progress = (st.progress + st.speed) % 1;
        st.pos = {
          lat: jitter(lerp(st.from[0], st.to[0], st.progress), 0.02),
          lng: jitter(lerp(st.from[1], st.to[1], st.progress), 0.02),
        };
        st.speedKmh = Math.round(48 + Math.random() * 28);
      } else {
        st.progress = v.status === "idle" ? 1 : 0.3;
        st.pos = { lat: st.from[0] + (Math.random() - 0.5) * 0.03, lng: st.from[1] + (Math.random() - 0.5) * 0.03 };
        st.speedKmh = 0;
      }
    });
    /* Simulate some vehicles breaking the 80 km/h limit so speed-violation
       features are visible even in demo mode. */
    var allV = getVehicles();
    var movingV = allV.filter(function (v) { return sim[v.plate] && sim[v.plate].speedKmh > 0; });
    var violCount = Math.max(1, Math.floor(movingV.length * 0.12));
    for (var i = 0; i < violCount; i++) {
      var rv = movingV[Math.floor(Math.random() * movingV.length)];
      if (rv) sim[rv.plate].speedKmh = 81 + Math.floor(Math.random() * 50);
    }
  }

  /* ---------------- Render ---------------- */
  /* Spread overlapping vehicles so one marker never hides another.
   * Vehicles closer than ~120 m are fanned out around the anchor point. */
  function spreadEntries(entries) {
    var groups = {};
    entries.forEach(function (e) {
      var key = Math.round(e.pos.lat * 1000) / 1000 + "|" + Math.round(e.pos.lng * 1000) / 1000;
      (groups[key] = groups[key] || []).push(e);
    });
    Object.keys(groups).forEach(function (key) {
      var list = groups[key];
      if (list.length < 2) { list.forEach(function (e) { e.disp = e.pos; }); return; }
      list.sort(function (a, b) {
        if (a.plate === selectedPlate) return -1;
        if (b.plate === selectedPlate) return 1;
        return a.plate < b.plate ? -1 : (a.plate > b.plate ? 1 : 0);
      });
      var anchor = list[0].pos;
      var n = list.length, sp = 0.004 * Math.sqrt(n);
      list.forEach(function (e, i) {
        if (i === 0) { e.disp = { lat: anchor.lat, lng: anchor.lng }; return; }
        var ang = (i / (n - 1)) * Math.PI * 2;
        e.disp = { lat: anchor.lat + Math.cos(ang) * sp, lng: anchor.lng + Math.sin(ang) * sp };
      });
    });
    return entries;
  }

  /* Heading for a moving vehicle: prefer the feed angle, else derive from motion. */
  function headingFor(e, from) {
    if (e.angle !== null && e.angle !== undefined && e.angle !== "") {
      var a = Number(e.angle);
      if (!isNaN(a)) return a;
    }
    if (from) {
      var dLat = e.disp.lat - from.lat;
      var dLng = (e.disp.lng - from.lng) * Math.cos(e.disp.lat * Math.PI / 180);
      if (Math.abs(dLat) > 1e-7 || Math.abs(dLng) > 1e-7) return Math.atan2(dLng, dLat) * 180 / Math.PI;
    }
    return 0;
  }

  /* Rotating top-down car icon with the plate number. */
  function carIcon(e, heading) {
    var color = STATUS_COLORS[e.status] || "#1c9a62";
    var html =
      '<div class="mv-marker">' +
      '<div class="mv-car" style="--c:' + color + ';transform:rotate(' + heading + 'deg)">' +
      '<svg viewBox="0 0 36 60" width="22" height="37">' +
      '<rect x="6" y="6" width="24" height="48" rx="10" fill="var(--c)" stroke="#fff" stroke-width="2"/>' +
      '<rect x="10" y="17" width="16" height="11" rx="4" fill="#cdeaff"/>' +
      '<rect x="10" y="37" width="16" height="8" rx="3" fill="#cdeaff"/>' +
      '<rect x="1" y="13" width="5" height="11" rx="2" fill="#222"/>' +
      '<rect x="30" y="13" width="5" height="11" rx="2" fill="#222"/>' +
      '<rect x="1" y="37" width="5" height="11" rx="2" fill="#222"/>' +
      '<rect x="30" y="37" width="5" height="11" rx="2" fill="#222"/>' +
      '</svg></div>' +
      '<div class="mv-plate">' + esc(e.plate) + "</div>" +
      "</div>";
    return L.divIcon({ className: "", html: html, iconSize: [36, 56], iconAnchor: [18, 19] });
  }

  /* Slide the car smoothly from its old position to the new one. */
  function animateMarker(mk, from, to, duration) {
    if (mk._anim) { clearInterval(mk._anim); mk._anim = null; }
    if (!from) { mk.setLatLng([to.lat, to.lng]); return; }
    var t0 = Date.now();
    mk._anim = setInterval(function () {
      var t = Math.min(1, (Date.now() - t0) / duration);
      mk.setLatLng([from.lat + (to.lat - from.lat) * t, from.lng + (to.lng - from.lng) * t]);
      if (t >= 1) { clearInterval(mk._anim); mk._anim = null; }
    }, 80);
  }

  function renderMarkers() {
    var entries = spreadEntries(fleetEntries().filter(function (e) { return e.pos; }));
    var current = {};
    entries.forEach(function (e) {
      var color = STATUS_COLORS[e.status] || "#1c9a62";
      var tip = e.plate + (e.trailer ? " · Tr. " + e.trailer : "") + " · " + (e.fleet || "") + ((GPS_STATUS[e.gpsStatus] || {}).label || ((STATUS_META[e.status] || {}).label || e.status));
      var moving = e.speed > 0 || e.gpsStatus === "moving";
      var wantType = moving ? "car" : "dot";
      var mk = markers[e.plate];
      if (mk && markerTypes[e.plate] !== wantType) {
        map.removeLayer(mk); delete markers[e.plate]; delete markerTypes[e.plate]; mk = null;
      }
      if (moving) {
        var from = mk ? mk.getLatLng() : null;
        var heading = headingFor(e, from);
        if (!mk) {
          mk = L.marker([e.disp.lat, e.disp.lng], { icon: carIcon(e, heading), zIndexOffset: 200 }).addTo(map);
          mk.bindTooltip(tip, { direction: "top", offset: [0, -20] });
          mk.on("click", function () { selectVehicle(e.plate); });
          markers[e.plate] = mk; markerTypes[e.plate] = "car";
        } else {
          mk.setIcon(carIcon(e, heading));
          mk.setTooltipContent(tip);
          animateMarker(mk, from, e.disp, 5000);
        }
      } else {
        var radius = 7;
        if (!mk) {
          mk = L.circleMarker([e.disp.lat, e.disp.lng], {
            radius: radius, color: "#fff", weight: 2, fillColor: color, fillOpacity: 0.95,
          }).addTo(map);
          mk.bindTooltip(tip, { direction: "top", offset: [0, -6] });
          mk.on("click", function () { selectVehicle(e.plate); });
          markers[e.plate] = mk; markerTypes[e.plate] = "dot";
        } else {
          mk.setLatLng([e.disp.lat, e.disp.lng]);
          mk.setStyle({ fillColor: color, radius: radius });
          mk.setTooltipContent(tip);
        }
      }
      current[e.plate] = true;
    });
    Object.keys(markers).forEach(function (p) {
      if (!current[p]) { if (markers[p]._anim) clearInterval(markers[p]._anim); map.removeLayer(markers[p]); delete markers[p]; delete markerTypes[p]; }
    });
  }

  function parseSearchTerms(raw) {
    return raw.split(/[,;\n]+/).map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  }
  function matchesSearchTerms(terms, hay) {
    if (!terms.length) return true;
    for (var i = 0; i < terms.length; i++) {
      if (hay.indexOf(terms[i]) !== -1) return true;
    }
    return false;
  }
  function vehicleSearchHay(e) {
    return (e.plate + " " + e.model + " " + (e.fleet || "") + " " + (e.locationText || "") + " " + (e.driver || "") + " " + (e.trip ? e.trip.startPoint + " " + e.trip.destination : "")).toLowerCase();
  }
  function renderList() {
    var terms = parseSearchTerms(searchEl.value);
    var list = filteredEntries().filter(function (e) {
      return matchesSearchTerms(terms, vehicleSearchHay(e));
    });
    listEl.innerHTML = list.map(function (e) {
      var route = e.trip ? esc(e.trip.startPoint) + " &rarr; " + esc(e.trip.destination) : (e.locationText ? esc(e.locationText) : "—");
      var pos = e.pos ? e.pos.lat.toFixed(4) + ", " + e.pos.lng.toFixed(4) : "—";
      var gps = GPS_STATUS[e.gpsStatus] || { label: e.gpsStatus || "—", color: STATUS_COLORS[e.status] || "#1c9a62" };
      var stopped = (e.gpsStatus === "stationary" && e.ageText) ? '<small style="color:var(--muted)">Stopped ' + esc(e.ageText) + "</small><br>" : "";
      /* Destination/heading info shown when a Heading filter is active */
      var headInfo = "";
      if (destFilter) {
        var hs = headState(e, destFilter);
        var kl = kmLeft(e);
        headInfo = '<small style="color:var(--muted)">' + esc(destFilter) + " &middot; " +
          esc(hs) + (kl !== null ? " &middot; ~" + kl + " km road left" : "") + "</small><br>";
      }
      return (
        '<div class="track-item ' + (selectedPlate === e.plate ? "active" : "") + '" data-plate="' + esc(e.plate) + '">' +
        '<span class="track-dot" style="background:' + gps.color + '"></span>' +
        '<div style="min-width:0"><b>' + esc(e.plate) + "</b>" +
        '<span class="fleet-tag" style="background:' + (e.fleet === "NT" ? "var(--red,#d0342c)" : "var(--navy,#1e5aad)") + '">' + esc(e.fleet || "?") + "</span>" +
        '<span class="track-status" style="background:' + gps.color + '">' + esc(gps.label) + "</span>" +
        '<small>' + esc(e.model) + "</small><br>" +
        '<small>' + esc(route) + "</small>" + stopped + headInfo + "</div>" +
        '<div class="meta"><small style="font-weight:' + (todaySpeed(e) > 80 ? 700 : 400) + ';color:' + (todaySpeed(e) > 80 ? "var(--red,#d0342c)" : (e.speed > 0 ? "var(--amber)" : "var(--muted)")) + '">' + (e.maxSpeedToday ? Math.round(e.maxSpeedToday) + " km/h today" : (e.speed ? Math.round(e.speed) + " km/h" : "0 km/h")) + "</small><br>" +
        "<small>" + esc(pos) + "</small></div>" +
        "</div>"
      );
    }).join("") || '<div class="empty"><div class="eico">&#128665;</div><p>No vehicles match.</p></div>';

    listEl.querySelectorAll(".track-item").forEach(function (el) {
      el.addEventListener("click", function () { selectVehicle(el.dataset.plate); });
    });
  }

  /* Red arrow marker pointing at the currently selected vehicle. */
  function updateSelectionArrow(e) {
    if (selMarker) { map.removeLayer(selMarker); selMarker = null; }
    if (!e || !e.pos) return;
    var icon = L.divIcon({
      className: "",
      html: '<div class="track-arrow"><div class="track-arrow-head"></div><div class="track-arrow-dot"></div></div>',
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    selMarker = L.marker([e.pos.lat, e.pos.lng], { icon: icon, zIndexOffset: 1000 }).addTo(map);
  }

  function renderDetail() {
    /* clear previous pulse */
    if (selPulseEl) { selPulseEl.classList.remove("sel-pulse"); selPulseEl = null; }
    if (!selectedPlate) { updateSelectionArrow(null); return; }
    var e = fleetEntries().find(function (x) { return x.plate === selectedPlate; });
    if (!e) { updateSelectionArrow(null); return; }
    detailEl.classList.remove("open");
    detailEl.innerHTML = "";
    updateSelectionArrow(e);
    if (e.pos) {
      var moving = e.speed > 0 || e.gpsStatus === "moving";
      var mk = markers[e.plate];
      if (moving && mk) {
        var center = map.getCenter();
        mk.setLatLng([center.lat, center.lng]);
        animateMarker(mk, { lat: center.lat, lng: center.lng }, { lat: e.pos.lat, lng: e.pos.lng }, 900);
      }
      map.flyTo([e.pos.lat, e.pos.lng], Math.max(map.getZoom(), 12), { duration: 1 });
      /* pulse ring on the selected car icon */
      if (mk && mk._icon) {
        var el = mk._icon.querySelector(".mv-marker");
        if (el) { el.classList.add("sel-pulse"); selPulseEl = el; }
      }
    }
  }

  function selectVehicle(plate) {
    selectedPlate = plate;
    renderList();
    renderDetail();
  }

  function updateStatusbar() {
    document.getElementById("modeDot").className = "live-dot" + (liveMode ? "" : " sim");
    document.getElementById("modeText").textContent = liveMode
      ? "Connected to ZTS GPS fleet control — LIVE"
      : feedMsg || "DEMO MODE — simulated feed (connect GPS in Admin)";
    var all = fleetEntries().filter(function (e) { return fleetOk(e) && speedOk(e); });
    var shown = filteredEntries().length;
    var label = [];
    if (fleetFilter) label.push(fleetFilter);
    if (destFilter) label.push("→ " + destFilter);
    if (speedFilter.length) label.push(speedFilter.join(" + ") + " > 80 km/h");
    if (statusFilter) label.push(GPS_STATUS[statusFilter].label);
    if (statusFilter === "stationary" && ageFilter) label.push("stopped " + (AGE_OPTS[ageFilter] || ""));
    var tail = label.length ? " — " + label.join(" · ") : " tracked";
    document.getElementById("feedCount").textContent = shown + " of " + all.length + " vehicles" + tail;
  }

  /* Per-status counts (based on GPS-derived status) + clickable chips */
  function renderAgeCounts() {
    var st = fleetEntries().filter(function (e) { return fleetOk(e) && e.gpsStatus === "stationary"; });
    ageMenu.querySelectorAll("button[data-age]").forEach(function (b) {
      var a = b.dataset.age;
      var n = a
        ? st.filter(function (e) { var d = ageDays(e); return d !== null && d >= Number(a); }).length
        : st.length;
      b.textContent = a ? (AGE_OPTS[a] + " (" + n + ")") : ("All (" + n + ")");
    });
    if (statusFilter === "stationary" && ageFilter) {
      var cur = st.filter(function (e) { var d = ageDays(e); return d !== null && d >= Number(ageFilter); }).length;
      ageBtn.textContent = "Stopped: " + AGE_OPTS[ageFilter] + " (" + cur + ") \u25BE";
    }
  }

  function renderCounts() {
    var el = document.getElementById("statusCounts");
    if (!el) return;
    var all = fleetEntries().filter(function (e) { return fleetOk(e) && speedOk(e); });
    var c = { idle: 0, moving: 0, stationary: 0 };
    all.forEach(function (e) { if (c[e.gpsStatus] !== undefined) c[e.gpsStatus]++; });
    var disp = { idle: c.idle, moving: c.moving, stationary: c.stationary };
    if (statusFilter === "stationary" && ageFilter) {
      disp.stationary = filteredEntries().filter(function (e) { return e.gpsStatus === "stationary"; }).length;
    }
    el.innerHTML = ["idle", "moving", "stationary"].map(function (k) {
      return '<button type="button" class="sc' + (statusFilter === k ? " on" : "") + '" data-gps-status="' + k + '">' +
        '<span class="sc-dot" style="background:' + GPS_STATUS[k].color + '"></span>' +
        GPS_STATUS[k].label + " <b>" + disp[k] + "</b></button>";
    }).join("") + '<span class="sc-total">Total <b>' + all.length + "</b></span>";
    el.querySelectorAll(".sc").forEach(function (b) {
      b.addEventListener("click", function () { setStatusFilter(b.dataset.gpsStatus === statusFilter ? "" : b.dataset.gpsStatus); });
    });
    renderAgeCounts();
  }

  /* Export live tracking data to XLSX, honoring the active fleet + status + age filters.
   * The file contains ONLY the vehicles matching the current filters. */
  window.exportTrackingXlsx = function () {
    /* Read the active status directly from the dropdown so the export always
     * matches what the user sees on screen. */
    var statusLabel = (((statusBtn.textContent.match(/Status:\s*([^▾]+)/) || [])[1] || "All").trim());
    var activeStatus = "";
    ["stationary", "moving", "idle"].forEach(function (k) {
      if ((GPS_STATUS[k].label || "").toLowerCase() === statusLabel.toLowerCase()) activeStatus = k;
    });
    var filtered = filteredEntries();
    if (activeStatus) filtered = filtered.filter(function (e) { return e.gpsStatus === activeStatus; });
    /* Stopped-day (age) filter — read straight from the "Stopped:" button. */
    var ageLabel = ((ageBtn.textContent.match(/Stopped:\s*([^▾]+)/) || [])[1] || "All").trim();
    var activeAge = "";
    Object.keys(AGE_OPTS).forEach(function (k) {
      if (AGE_OPTS[k] === ageLabel) activeAge = k;
    });
    if (activeStatus === "stationary" && activeAge) {
      filtered = filtered.filter(function (e) {
        var d = ageDays(e);
        return d !== null && d >= Number(activeAge);
      });
    }
    var now = new Date();
    var stamp = now.toISOString().slice(0, 10);
    var pad2 = function (n) { return (n < 10 ? "0" : "") + n; };
    var genTime = pad2(now.getHours()) + ":" + pad2(now.getMinutes()) + ":" + pad2(now.getSeconds());
    var key = activeStatus || "all";
    if (fleetFilter) key = (fleetFilter.toLowerCase() + "-") + key;
    if (speedFilter.length) key = (speedFilter.join("-").toLowerCase() + "-speed80-") + key;
    var label = (fleetFilter ? fleetFilter + " — " : "") + (speedFilter.length ? speedFilter.join(" + ") + " > 80 km/h — " : "") + (activeStatus ? GPS_STATUS[activeStatus].label : "All Vehicles");
    var statusName = function (e) { return (GPS_STATUS[e.gpsStatus] || { label: e.gpsStatus || "—" }).label; };
    var routeText = function (e) { return e.trip ? e.trip.startPoint + " → " + e.trip.destination : (e.locationText || ""); };
    var destHeaders = destFilter ? ["Destination", "Heading State", "Road Km Left"] : [];
    var destCols = function (e) {
      if (!destFilter) return [];
      return [destOf(e) || "", headState(e, destFilter), kmLeft(e) !== null ? "~" + kmLeft(e) + " km" : ""];
    };
    var header, rows = [];
    if (activeStatus === "stationary") {
      filtered = filtered.sort(function (a, b) { return (b.age || 0) - (a.age || 0); });
      header = ["Plate", "Trailer No.", "Driver", "GPS Status", "Stopped Since (feed)", "Location / Route", "GPS Fix Time"].concat(destHeaders);
      filtered.forEach(function (e) {
        rows.push([e.plate, e.trailer || "", e.driver || "", statusName(e), fmtDuration(e.age), routeText(e), e.time || ""].concat(destCols(e)));
      });
    } else if (activeStatus === "idle") {
      filtered = filtered.sort(function (a, b) { return (b.age || 0) - (a.age || 0); });
      header = ["Plate", "Trailer No.", "Driver", "GPS Status", "Idle Duration (feed)", "Location / Route", "GPS Fix Time"].concat(destHeaders);
      filtered.forEach(function (e) {
        rows.push([e.plate, e.trailer || "", e.driver || "", statusName(e), fmtDuration(e.age), routeText(e), e.time || ""].concat(destCols(e)));
      });
    } else if (activeStatus === "moving") {
      header = ["Plate", "Trailer No.", "Driver", "GPS Status", "Max Speed Today (km/h)", "Current Speed (km/h)", "Last Fix (feed)", "Location", "GPS Fix Time"].concat(destHeaders);
      filtered.forEach(function (e) {
        rows.push([e.plate, e.trailer || "", e.driver || "", statusName(e), Math.round(todaySpeed(e)) || 0, Math.round(e.speed) || 0, fmtDuration(e.age), routeText(e), e.time || ""].concat(destCols(e)));
      });
    } else if (activeStatus) {
      header = ["Plate", "Trailer No.", "Driver", "GPS Status", "Max Speed Today (km/h)", "Current Speed (km/h)", "Stopped Since (feed)", "Location / Route", "GPS Fix Time"].concat(destHeaders);
      filtered.forEach(function (e) {
        rows.push([e.plate, e.trailer || "", e.driver || "", statusName(e), Math.round(todaySpeed(e)) || 0, Math.round(e.speed) || 0, fmtDuration(e.age), routeText(e), e.time || ""].concat(destCols(e)));
      });
    } else {
      header = ["Plate", "Trailer No.", "Driver", "GPS Status", "Max Speed Today (km/h)", "Current Speed (km/h)", "Stopped Since (feed)", "Feed: moving", "Feed: online", "Feed: ignition", "Feed: status", "Position", "Location / Route", "GPS Fix Time"].concat(destHeaders);
      filtered.forEach(function (e) {
        rows.push([
          e.plate,
          e.trailer || "",
          e.driver || "",
          statusName(e),
          Math.round(todaySpeed(e)) || 0,
          Math.round(e.speed) || 0,
          fmtDuration(e.age),
          (e.moving === undefined || e.moving === null) ? "" : String(e.moving),
          (e.online === undefined || e.online === null) ? "" : String(e.online),
          (e.ignition === undefined || e.ignition === null) ? "" : String(e.ignition),
          e.rawStatus || "",
          e.pos ? e.pos.lat.toFixed(4) + ", " + e.pos.lng.toFixed(4) : "",
          routeText(e),
          e.time || "",
        ].concat(destCols(e)));
      });
    }
    exportXLSX("live-tracking-" + stamp + "-" + key + ".xlsx", "Live Tracking — " + label, header, rows, metaSummary(filtered, activeStatus, stamp, genTime, ageLabel));
  };

  /* Export currently searched/filtered vehicles to XLSX. */
  function buildSearchExport() {
    var terms = parseSearchTerms(searchEl.value);
    var filtered = filteredEntries().filter(function (e) {
      return matchesSearchTerms(terms, vehicleSearchHay(e));
    });
    if (!filtered.length) { toast("No vehicles to export", "error"); return; }
    var now = new Date();
    var stamp = now.toISOString().slice(0, 10);
    var pad2 = function (n) { return (n < 10 ? "0" : "") + n; };
    var genTime = pad2(now.getHours()) + ":" + pad2(now.getMinutes()) + ":" + pad2(now.getSeconds());
    var header = ["Plate", "Fleet", "Driver", "GPS Status", "Speed (km/h)", "Max Speed Today (km/h)", "Position (lat, lng)", "Location / Route", "GPS Fix Time", "Data Age (last fix)"];
    var rows = filtered.map(function (e) {
      var routeText = e.trip ? e.trip.startPoint + " → " + e.trip.destination : (e.locationText || "");
      return [
        e.plate,
        e.fleet || "",
        e.driver || "",
        (GPS_STATUS[e.gpsStatus] || { label: e.gpsStatus || "—" }).label,
        Math.round(e.speed) || 0,
        Math.round(todaySpeed(e)) || 0,
        e.pos ? e.pos.lat.toFixed(6) + ", " + e.pos.lng.toFixed(6) : "",
        routeText,
        e.time || "",
        fmtDuration(e.age),
      ];
    });
    var meta = [
      ["Generated", stamp + " " + genTime],
      ["Exported", filtered.length],
      ["Search", searchEl.value || "(all)"],
      ["Fleet Filter", fleetFilter || "All"],
      ["Data Source", liveMode ? "Live ZTS GPS (fetched on demand)" : "Simulation"],
      ["Note", "Location, speed & fix time reflect the last GPS fetch for each vehicle. 'Data Age' shows freshness of each fix."],
    ];
    exportXLSX("searched-locations-" + stamp + ".xlsx", "Searched Locations", header, rows, meta);
    toast("Exported " + filtered.length + " vehicles to XLSX", "success");
  }
  window.exportSearchXlsx = function () {
    /* Fetch the freshest GPS positions first, then export so locations are real-time. */
    var cfg = getGpsConfig();
    var accounts = gpsAccounts();
    var hadLive = liveMode;
    fetchAndMergeLive().then(function () {
      stepSimulation();
      buildSearchExport();
    });
  };
  var exportSearchBtn = document.getElementById("exportSearchBtn");
  if (exportSearchBtn) exportSearchBtn.addEventListener("click", window.exportSearchXlsx);

  /* Summary block shown at the top of the exported sheet — only the selected status. */
  function metaSummary(exported, activeStatus, stamp, genTime, ageLabel) {
    var stopped = activeStatus === "stationary" ? "   Stopped: " + (ageLabel || "All") : "";
    var speed = speedFilter.length ? "   Speed: " + speedFilter.join(" + ") + " > 80 km/h" : "";
    var heading = "";
    if (destFilter) {
      var at = 0, en = 0, off = 0;
      fleetEntries().forEach(function (e) {
        var st = headState(e, destFilter);
        if (st === "At destination") at++;
        else if (st === "En route") en++;
        else if (st === "Off route") off++;
      });
      heading = "   Heading: " + destFilter + " — At destination " + at + ", En route " + en + ", Off route " + off;
    }
    return [
      "National Transport PLC — Live Tracking Report",
      "Generated: " + stamp + " " + genTime + "   Fleet: " + (fleetFilter || "All") + "   Status: " + (activeStatus ? GPS_STATUS[activeStatus].label : "All") + stopped + speed + "   Vehicles in file: " + exported.length + heading,
      "",
    ];
  }

  /* ---------------- Feed loop ---------------- */
  function fetchAndMergeLive() {
    var cfg = getGpsConfig();
    var accounts = gpsAccounts();
    if (!(cfg.enabled && accounts.length)) {
      liveMode = false;
      liveMap = {};
      feedMsg = "DEMO MODE — simulated feed (connect GPS in Admin)";
      return Promise.resolve();
    }
    return Promise.all(accounts.map(function (a) {
      return ztsFetchLive(a).then(function (list) {
        return { ok: true, label: a.label, list: list };
      }, function (err) {
        return { ok: false, label: a.label, error: (err && err.message) || "connection failed" };
      });
    })).then(function (results) {
      var merged = {}, seen = {}, okCount = 0, parts = [];
      window.ztsFeeds = results.map(function (r) { return { label: r.label, ok: r.ok, count: r.ok ? r.list.length : 0, error: r.error || "" }; });
      results.forEach(function (r) {
        if (r.ok) {
          okCount++;
          parts.push(r.label + ": " + r.list.length + " vehicles");
          r.list.forEach(function (v) {
            var k = normPlate(v.plate);
            if (!seen[k]) { seen[k] = true; merged[v.plate] = v; }
          });
        } else {
          parts.push(r.label + ": FAILED (" + r.error + ")");
        }
      });
      if (okCount) {
        liveMap = merged;
        liveMode = true;
        feedMsg = "Connected to ZTS GPS — " + parts.join(" · ");
      } else {
        liveMap = {};
        liveMode = false;
        feedMsg = "GPS feed error: " + parts.join(" · ") + " — showing simulation";
      }
    }, function (err) {
      liveMode = false;
      liveMap = {};
      feedMsg = "GPS feed error: " + ((err && err.message) || "connection failed") + " — showing simulation";
    });
  }
  function tick() {
    fetchAndMergeLive().then(function () {
        lastTick = Date.now();
        document.getElementById("lastUpdate").textContent = new Date(lastTick).toLocaleTimeString();
        stepSimulation();
        trackAllDailyMax();
        trackDrivingStart();
        updateSpeedViolations();
        fetchAlertsForBadge();
        rebuildLocMenu();
        rebuildDestMenu();
        fetchBackendViolations().then(function () { renderSpeedAlertBadge(); });
        renderViolationCounts();
        renderMarkers();
        renderList();
        renderCounts();
        renderDetail();
        updateStatusbar();
      });
  }

  /* ---------------- Init ---------------- */
  map = L.map("map").setView([9.03, 38.74], 6);

  var osmLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  var gRoadLayer = L.tileLayer("https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}", {
    maxZoom: 20,
    attribution: '&copy; <a href="https://maps.google.com">Google Maps</a>',
  });
  var gSatLayer = L.tileLayer("https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", {
    maxZoom: 20,
    attribution: '&copy; <a href="https://maps.google.com">Google Maps Satellite</a>',
  });
  var gHybridLayer = L.tileLayer("https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}", {
    maxZoom: 20,
    attribution: '&copy; <a href="https://maps.google.com">Google Maps Hybrid</a>',
  });
  L.control.layers({
    "OpenStreetMap": osmLayer,
    "Google Map": gRoadLayer,
    "Google Satellite": gSatLayer,
    "Google Hybrid": gHybridLayer,
  }, null, { position: "topright", collapsed: false }).addTo(map);

  setTimeout(function () { map.invalidateSize(); }, 60);
  window.addEventListener("resize", function () { map.invalidateSize(); });

  function handleSearch() {
    renderList();
    var terms = parseSearchTerms(searchEl.value);
    if (!terms.length) return;
    var matches = filteredEntries().filter(function (e) {
      return matchesSearchTerms(terms, vehicleSearchHay(e));
    }).filter(function (e) { return e.pos; });
    if (!matches.length) return;
    if (matches.length === 1) {
      selectVehicle(matches[0].plate);
    } else {
      map.fitBounds(matches.map(function (e) { return [e.pos.lat, e.pos.lng]; }), { padding: [60, 60] });
    }
  }
  searchEl.addEventListener("input", handleSearch);

  function setStatusFilter(s) {
    statusFilter = s;
    if (s !== "stationary") ageFilter = "";
    statusBtn.textContent = "Status: " + (s ? GPS_STATUS[s].label : "All") + " \u25BE";
    statusDd.classList.remove("open");
    statusMenu.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.gpsStatus === s);
    });
    ageDd.style.display = s === "stationary" ? "" : "none";
    ageBtn.textContent = "Stopped: " + (ageFilter ? AGE_OPTS[ageFilter] : "All") + " \u25BE";
    ageMenu.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.age === ageFilter);
    });
    renderList();
    renderCounts();
    renderDetail();
    updateStatusbar();
  }

  function setAgeFilter(s) {
    ageFilter = s;
    ageBtn.textContent = "Stopped: " + (s ? AGE_OPTS[s] : "All") + " \u25BE";
    ageDd.classList.remove("open");
    ageMenu.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.age === s);
    });
    renderList();
    renderCounts();
    renderDetail();
    updateStatusbar();
  }

  statusBtn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    statusDd.classList.toggle("open");
  });
  statusMenu.querySelectorAll("button").forEach(function (b) {
    b.addEventListener("click", function (ev) {
      ev.stopPropagation();
      setStatusFilter(b.dataset.gpsStatus);
    });
  });
  document.addEventListener("click", function () {
    statusDd.classList.remove("open");
    ageDd.classList.remove("open");
    fleetDd.classList.remove("open");
    speedDd.classList.remove("open");
    destDd.classList.remove("open");
  });

  function setFleetFilter(f) {
    fleetFilter = f;
    fleetBtn.textContent = "Fleet: " + (f || "All") + " \u25BE";
    fleetDd.classList.remove("open");
    fleetMenu.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.fleet === f);
    });
    renderList();
    renderCounts();
    renderDetail();
    updateStatusbar();
  }

  fleetBtn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    fleetDd.classList.toggle("open");
  });
  fleetMenu.querySelectorAll("button").forEach(function (b) {
    b.addEventListener("click", function (ev) {
      ev.stopPropagation();
      setFleetFilter(b.dataset.fleet);
    });
  });

  /* Populate location dropdown with cities + any locations seen in live data. */
  function availableLocations() {
    var set = {};
    Object.keys(CITIES).forEach(function (c) { set[c] = 1; });
    fleetEntries().forEach(function (e) {
      var t = (e.locationText || "").trim();
      if (!t) return;
      Object.keys(CITIES).forEach(function (c) {
        if (t.toLowerCase().indexOf(c.toLowerCase()) !== -1) set[c] = 1;
      });
      if (t.length <= 40) set[t] = 1;
    });
    return Object.keys(set).sort();
  }
  function rebuildLocMenu() {
    var html = '<button type="button" class="on" data-loc="">All</button>';
    availableLocations().forEach(function (l) {
      html += '<button type="button" data-loc="' + esc(l) + '">' + esc(l) + '</button>';
    });
    locMenu.innerHTML = html;
    locMenu.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.loc === locFilter);
      b.addEventListener("click", function () { setLocFilter(b.dataset.loc); });
    });
  }
  function setLocFilter(l) {
    locFilter = l;
    locBtn.textContent = "Location: " + (l || "All") + " \u25BE";
    locDd.classList.remove("open");
    locMenu.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.loc === locFilter);
    });
    renderList();
    renderCounts();
    renderDetail();
    updateStatusbar();
    if (locFilter) {
      var m = fleetEntries().filter(locOk).filter(function (e) { return e.pos; });
      if (m.length) map.fitBounds(m.map(function (e) { return [e.pos.lat, e.pos.lng]; }), { padding: [60, 60] });
    }
  }
  locBtn.addEventListener("click", function (ev) { ev.stopPropagation(); rebuildLocMenu(); locDd.classList.toggle("open"); });
  locMenu.querySelectorAll("button").forEach(function (b) {
    b.addEventListener("click", function (ev) { ev.stopPropagation(); setLocFilter(b.dataset.loc); });
  });

  /* ---- Destination / heading filter ---- */
  function availableDestinations() {
    var set = {};
    Object.keys(CITIES).forEach(function (c) { set[c] = 1; });
    getTrips().forEach(function (t) {
      if (t.destination && destCoords(t.destination)) set[t.destination] = 1;
    });
    return Object.keys(set).sort();
  }
  function rebuildDestMenu() {
    var html = '<button type="button" class="on" data-dest="">All</button>';
    availableDestinations().forEach(function (d) {
      html += '<button type="button" data-dest="' + esc(d) + '">' + esc(d) + '</button>';
    });
    destMenu.innerHTML = html;
    destMenu.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.dest === destFilter);
      b.addEventListener("click", function () { setDestFilter(b.dataset.dest); });
    });
  }
  function setDestFilter(d) {
    destFilter = d;
    destBtn.textContent = "Heading: " + (d || "All") + " \u25BE";
    destDd.classList.remove("open");
    destMenu.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.dest === destFilter);
    });
    renderList();
    renderCounts();
    renderDetail();
    updateStatusbar();
    if (destFilter) {
      var m = filteredEntries().filter(function (e) { return e.pos; });
      if (m.length) map.fitBounds(m.map(function (e) { return [e.pos.lat, e.pos.lng]; }), { padding: [60, 60] });
    }
  }
  destBtn.addEventListener("click", function (ev) { ev.stopPropagation(); rebuildDestMenu(); destDd.classList.toggle("open"); });
  destMenu.querySelectorAll("button").forEach(function (b) {
    b.addEventListener("click", function (ev) { ev.stopPropagation(); setDestFilter(b.dataset.dest); });
  });

  function toggleSpeedFilter(fleet, on) {
    var i = speedFilter.indexOf(fleet);
    if (on && i === -1) speedFilter.push(fleet);
    if (!on && i !== -1) speedFilter.splice(i, 1);
    speedBtn.textContent = "Speed: " + (speedFilter.length ? speedFilter.join(" + ") + " > 80" : "All") + " \u25BE";
    speedDd.classList.remove("open");
    speedMenu.querySelectorAll("input[data-speed]").forEach(function (c) {
      c.checked = speedFilter.indexOf(c.dataset.speed) !== -1;
      var lbl = c.closest("label");
      if (lbl) lbl.classList.toggle("on", c.checked);
    });
    renderList();
    renderCounts();
    renderDetail();
    updateStatusbar();
  }

  speedBtn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    speedDd.classList.toggle("open");
  });
  speedMenu.querySelectorAll("input[data-speed]").forEach(function (c) {
    c.addEventListener("change", function (ev) {
      ev.stopPropagation();
      toggleSpeedFilter(c.dataset.speed, c.checked);
    });
  });

  ageBtn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    ageDd.classList.toggle("open");
  });
  ageMenu.querySelectorAll("button").forEach(function (b) {
    b.addEventListener("click", function (ev) {
      ev.stopPropagation();
      setAgeFilter(b.dataset.age);
    });
  });

  /* ---------------- Raw feed debug ---------------- */
  window.showRawFeed = function () {
    var body = document.getElementById("rawModalBody");
    var info = "<b>Feed mode:</b> " + (liveMode ? "LIVE (connected to ZTS)" : "DEMO / simulation — GPS not returning data") + "<br>" +
      "<b>Status message:</b> " + esc(feedMsg) + "<br>" +
      "<b>Vehicles mapped:</b> " + Object.keys(liveMap).length + "<br>";
    var feeds = window.ztsFeeds;
    if (feeds && feeds.length) {
      info += "<b>Accounts:</b> " + feeds.map(function (f) {
        return (f.ok ? "<span style='color:var(--green,#1c9a62)'>" + esc(f.label) + " \u2713 (" + f.count + ")</span>" : "<span style='color:var(--red,#d0342c)'>" + esc(f.label) + " \u2717 " + esc(f.error) + "</span>");
      }).join(" &nbsp; ") + "<br>";
    }
    var raw = window.ztsRaw;
    if (raw) {
      var list = raw.current_statues || raw.vehicles || raw.list || raw.data || raw.rows || raw.result || [];
      var keys = window.ztsKeys || (list[0] ? Object.keys(list[0]) : []);
      var maxKeys = keys.filter(function (k) { return /max/i.test(k); });
      info += "<b>Raw response keys:</b> " + esc(Object.keys(raw).join(", ")) + "<br>" +
        "<b>Vehicles in raw response:</b> " + (Array.isArray(list) ? list.length : "?") + "<br>" +
        "<b>Per-vehicle fields:</b> " + esc(keys.join(", ")) + "<br>" +
        "<b>Max-speed fields found:</b> " + (maxKeys.length ? esc(maxKeys.join(", ")) : "none — today's max not in this feed") + "<br>" +
        "<b>Sample records:</b><br><pre style='white-space:pre-wrap'>" +
        esc(JSON.stringify(list.slice(0, 3), null, 2)) + "</pre>";
    } else {
      info += "<br><b>No raw data captured yet.</b> If you are in demo mode, the GPS API was never reached — check Admin &rarr; GPS Settings &rarr; Test Connection.<br>";
      var cfg = getGpsConfig();
      info += "<b>Settings:</b> enabled=" + (cfg.enabled ? "yes" : "no") + ", apiBase=" + esc(cfg.apiBase || "—") + ", Lemi user set=" + (cfg.username ? "yes" : "no") + ", NT account " + (cfg.ntEnabled ? "enabled" : "disabled");
    }
    body.innerHTML = info;
    document.getElementById("rawModal").classList.add("open");
  };

  /* Also expose alert debug in the debug modal */
  var origShowRaw = window.showRawFeed;
  window.showRawFeed = function () {
    if (origShowRaw) origShowRaw();
    var body = document.getElementById("rawModalBody");
    if (!body) return;
    var ad = window.ztsAlertDebug;
    var extra = '<br><hr style="margin:10px 0;border-color:var(--line)"><b>Alert API Debug:</b><br>';
    if (ad) {
      extra += "<b>Endpoint tried:</b> " + esc(String(ad.endpoint || "—")) + "<br>";
      extra += "<b>Alerts fetched:</b> " + alertData.length + "<br>";
      if (ad.response) {
        extra += "<b>Response keys:</b> " + esc(Object.keys(ad.response).join(", ")) + "<br>";
        extra += "<b>Raw response (first 2000 chars):</b><br><pre style='white-space:pre-wrap'>" +
          esc(JSON.stringify(ad.response, null, 2).substring(0, 2000)) + "</pre>";
      }
      if (ad.error) extra += "<b>Error:</b> " + esc(ad.error) + "<br>";
    } else {
      extra += "<i>No alert API call made yet.</i><br>";
    }
    body.innerHTML += extra;
  };
  window.closeRawFeed = function () { document.getElementById("rawModal").classList.remove("open"); };

  function fetchAlertsForBadge() {
    var localAlerts = generateAlerts();
    var cfg = getGpsConfig();
    var accounts = gpsAccounts();
    var promises = accounts.map(function (a) {
      if (typeof ztsFetchAlerts !== "function") return Promise.resolve([]);
      return ztsFetchAlerts(a).catch(function () { return []; });
    });
    Promise.all(promises).then(function (results) {
      var seen = {};
      alertData = [];
      results.forEach(function (list) {
        if (!Array.isArray(list)) return;
        list.forEach(function (a) {
          if (!a || a.category === "other") return;
          var key = normPlate(a.plate) + "|" + a.category;
          if (seen[key]) return;
          seen[key] = 1;
          alertData.push(a);
        });
      });
      localAlerts.forEach(function (a) {
        var key = normPlate(a.plate) + "|" + a.category;
        if (seen[key]) return;
        seen[key] = 1;
        alertData.push(a);
      });
      renderSpeedAlertBadge();
    }).catch(function () {
      alertData = localAlerts;
      renderSpeedAlertBadge();
    });
  }

  initSimulation();
  rebuildLocMenu();
  rebuildDestMenu();
  updateSpeedViolations();
  fetchBackendViolations().then(function () { renderSpeedAlertBadge(); });
  fetchAlertsForBadge();
  renderViolationCounts();
  renderList();
  renderCounts();
  updateStatusbar();
  tick();
  setInterval(tick, 30000);

  var speedAlertBtn = document.getElementById("speedAlertBtn");
  if (speedAlertBtn) {
    speedAlertBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      showSpeedAlert();
    });
  }

  window.afterApiSync = function () {
    initSimulation();
    renderList();
    renderCounts();
    renderDetail();
    updateStatusbar();
  };
})();
