/* National Transport PLC — shared UI helpers */
"use strict";

var __justSeeded = ensureSeeded();
if (__justSeeded) {
  document.addEventListener("DOMContentLoaded", function () {
    toast("Company data refreshed — 114 vehicles loaded", "success");
  });
}

/* ---------------- Nav toggle ---------------- */
document.addEventListener("DOMContentLoaded", function () {
  var toggle = document.getElementById("navToggle");
  var links = document.getElementById("navLinks");
  if (toggle && links) {
    toggle.addEventListener("click", function () {
      links.classList.toggle("open");
    });
    links.addEventListener("click", function (e) {
      if (e.target.tagName === "A") links.classList.remove("open");
    });
  }
  var page = document.body.dataset.page;
  if (page) {
    document.querySelectorAll("#navLinks a").forEach(function (a) {
      if (a.dataset.page === page) a.classList.add("active");
    });
  }
});

/* ---------------- Toast ---------------- */
function toast(msg, type) {
  var wrap = document.getElementById("toastWrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "toastWrap";
    wrap.className = "toast-wrap";
    document.body.appendChild(wrap);
  }
  var el = document.createElement("div");
  el.className = "toast " + (type || "");
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(function () {
    el.style.opacity = "0";
    el.style.transition = "opacity .3s";
    setTimeout(function () { el.remove(); }, 320);
  }, 3200);
}

/* ---------------- Modal ---------------- */
function openModal(id) {
  var m = document.getElementById(id);
  if (m) m.classList.add("open");
}
function closeModal(id) {
  if (window.onBeforeCloseModal && window.onBeforeCloseModal(id) === false) return;
  var m = document.getElementById(id);
  if (m) m.classList.remove("open");
}
document.addEventListener("click", function (e) {
  var modal = null;
  if (e.target.classList && e.target.classList.contains("modal-backdrop")) modal = e.target;
  else if (e.target.classList && e.target.classList.contains("modal-close")) modal = e.target.closest(".modal-backdrop");
  if (modal) {
    if (window.onBeforeCloseModal && window.onBeforeCloseModal(modal.id) === false) return;
    modal.classList.remove("open");
  }
});

/* ---------------- Escape HTML ---------------- */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------------- Simple bar chart (pure CSS) ---------------- */
function renderBars(el, data) {
  var max = Math.max.apply(null, data.map(function (d) { return d.value; })) || 1;
  el.innerHTML = data.map(function (d) {
    var h = Math.max(4, Math.round((d.value / max) * 100));
    return (
      '<div class="bar-col" title="' + esc(d.label) + ": " + esc(d.value) + '">' +
      '<span class="bar-val">' + fmtNum(d.value) + "</span>" +
      '<div class="bar" style="height:' + h + '%"></div>' +
      '<span class="bar-label">' + esc(d.label) + "</span>" +
      "</div>"
    );
  }).join("");
}

/* ---------------- Donut chart (SVG) ---------------- */
function renderDonut(el, data) {
  var total = data.reduce(function (a, d) { return a + d.value; }, 0) || 1;
  var r = 70, cx = 90, cy = 90, c = 2 * Math.PI * r;
  var offset = 0;
  var segs = data.map(function (d) {
    var frac = d.value / total;
    var dash = frac * c;
    var seg = '<circle r="' + r + '" cx="' + cx + '" cy="' + cy + '" ' +
      'fill="none" stroke="' + d.color + '" stroke-width="26" ' +
      'stroke-dasharray="' + dash + " " + c + '" stroke-dashoffset="' + (-offset) + '" ' +
      'stroke-linecap="butt"></circle>';
    offset += dash;
    return seg;
  }).join("");
  el.innerHTML =
    '<svg viewBox="0 0 180 180" class="pie-svg">' +
    '<circle r="70" cx="90" cy="90" fill="none" stroke="#e8edf3" stroke-width="26"></circle>' +
    segs +
    '<text x="90" y="86" text-anchor="middle" font-size="22" font-weight="800" fill="#0b1f3a">' + total + '</text>' +
    '<text x="90" y="106" text-anchor="middle" font-size="9" fill="#5f6f80">TOTAL</text>' +
    "</svg>";
  var legend = data.map(function (d) {
    return '<div><span class="sw" style="background:' + d.color + '"></span>' +
      esc(d.label) + " <b>" + fmtNum(d.value) + "</b></div>";
  }).join("");
  el.insertAdjacentHTML("beforeend", '<div class="pie-legend">' + legend + "</div>");
}

/* ---------------- CSV export ---------------- */
function exportCSV(filename, headers, rows) {
  var csv = [headers.map(esc).join(",")];
  rows.forEach(function (r) {
    csv.push(r.map(function (cell) { return '"' + String(cell == null ? "" : cell).replace(/"/g, '""') + '"'; }).join(","));
  });
  var blob = new Blob(["\uFEFF" + csv.join("\n")], { type: "text/csv;charset=utf-8;" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 200);
}

function downloadBlob(blob, filename) {
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 200);
}

/* ---------------- XLSX export (offline, no libraries) ---------------- */
function exportXLSX(filename, sheetName, headers, rows, meta) {
  var xml = function (s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };
  var cell = function (c, bold) {
    var st = bold ? ' s="1"' : "";
    if (typeof c === "number" && isFinite(c)) return "<c" + st + "><v>" + c + "</v></c>";
    return '<c' + st + ' t="inlineStr"><is><t>' + xml(c) + "</t></is></c>";
  };
  var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
  /* Optional summary block at the top of the sheet (status counts, etc.) */
  (meta || []).forEach(function (mr) {
    if (mr === null || mr === undefined) return;
    var cells = Array.isArray(mr) ? mr.map(function (c) { return cell(c, true); }).join("") : cell(mr, true);
    sheet += "<row>" + cells + "</row>";
  });
  var head = headers.map(function (h) {
    return '<c t="inlineStr" s="1"><is><t>' + xml(h) + "</t></is></c>";
  }).join("");
  sheet += "<row>" + head + "</row>";
  rows.forEach(function (r) {
    var cells = r.map(function (c) { return cell(c); }).join("");
    sheet += "<row>" + cells + "</row>";
  });
  sheet += "</sheetData></worksheet>";

  var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    "</Types>";
  var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";
  var workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    "</Relationships>";
  var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="' + xml(sheetName || "Report") + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
  var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
    "</styleSheet>";

  var zip = buildZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rels },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/styles.xml", data: styles },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
  downloadBlob(new Blob([zip], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
}

/* Minimal ZIP writer (STORED entries, no compression) — used for .xlsx */
function crc32(bytes) {
  var t = crc32.table;
  if (!t) {
    t = crc32.table = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
  }
  var crc = 0xFFFFFFFF;
  for (var j = 0; j < bytes.length; j++) crc = t[(crc ^ bytes[j]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(entries) {
  var enc = new TextEncoder();
  var chunks = [];
  var central = [];
  var offset = 0;
  entries.forEach(function (e) {
    var data = enc.encode(e.data);
    var name = enc.encode(e.name);
    var crc = crc32(data);
    var lh = new Uint8Array(30);
    var lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    chunks.push(lh, name, data);

    var ch = new Uint8Array(46 + name.length);
    var cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    central.push(ch);

    offset += lh.length + name.length + data.length;
  });

  var centralSize = central.reduce(function (a, b) { return a + b.length; }, 0);
  var eocd = new Uint8Array(22);
  var ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  var all = chunks.concat(central);
  all.push(eocd);
  var total = all.reduce(function (a, b) { return a + b.length; }, 0);
  var out = new Uint8Array(total);
  var pos = 0;
  all.forEach(function (p) { out.set(p, pos); pos += p.length; });
  return out;
}

/* ---------------- PDF export (offline, no libraries) ---------------- */
function exportPDF(filename, title, subtitle, headers, rows) {
  var PW = 595, PH = 842, ML = 36, MR = 36, MT = 46, MB = 34;
  var SIZE = 8.5, LH = 11;
  var usable = PW - ML - MR;
  var encP = function (s) {
    return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  };
  var wrap = function (s, w) {
    var str = String(s == null ? "" : s);
    var per = Math.max(4, Math.floor((w - 6) / 4.2));
    if (str.length <= per) return [str];
    var out = [];
    for (var i = 0; i < str.length; i += per) out.push(str.slice(i, i + per));
    return out;
  };

  var cols = headers.map(function (h, i) {
    var w = h.length * 4.2 + 6;
    rows.forEach(function (r) { w = Math.max(w, String(r[i] == null ? "" : r[i]).length * 4.2 + 6); });
    return w;
  });
  var total = cols.reduce(function (a, b) { return a + b; }, 0) || 1;
  var scale = Math.min(1, usable / total);
  cols = cols.map(function (c) { return Math.max(26, Math.round(c * scale)); });

  var pages = [];
  var cur = "";
  var y = PH - MT;

  function put(text, x, size, bold) {
    cur += "BT /F" + (bold ? 2 : 1) + " " + size + " Tf 1 0 0 1 " + x.toFixed(1) + " " + y.toFixed(1) + " Tm (" + encP(text) + ") Tj ET\n";
  }
  function ensure(h) {
    if (y - h < MB) { pages.push(cur); cur = ""; y = PH - MT; }
  }

  put(title, ML, 14, true);
  y -= 17;
  if (subtitle) { put(subtitle, ML, 9, false); y -= 13; }
  y -= 4;

  ensure(LH + 4);
  var hx = ML;
  cols.forEach(function (w, i) {
    put(headers[i], hx + 3, SIZE, true);
    hx += w;
  });
  y -= LH + 4;

  rows.forEach(function (r) {
    var cellLines = r.map(function (cell, i) { return wrap(cell, cols[i]); });
    var n = cellLines.reduce(function (a, l) { return Math.max(a, l.length); }, 1);
    var rowH = n * LH;
    ensure(rowH);
    var base = y;
    for (var j = 0; j < n; j++) {
      var cx = ML;
      cols.forEach(function (w, i) {
        if (cellLines[i][j]) put(cellLines[i][j], cx + 3, SIZE, false);
        cx += w;
      });
      y = base - (j + 1) * LH;
    }
  });
  pages.push(cur);

  var pageStart = 5, contentStart = 5 + pages.length;
  var HEAD = "%PDF-1.4\n";
  var body = "";
  var offsets = [0];
  function emit(num, str) {
    offsets[num] = HEAD.length + body.length;
    body += num + " 0 obj\n" + str + "\nendobj\n";
  }
  var kids = [];
  for (var i = 0; i < pages.length; i++) kids.push((pageStart + i) + " 0 R");
  emit(1, "<< /Type /Catalog /Pages 2 0 R >>");
  emit(2, "<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + pages.length + " >>");
  emit(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  emit(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  for (var i = 0; i < pages.length; i++) {
    emit(pageStart + i, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents " + (contentStart + i) + " 0 R >>");
  }
  for (var i = 0; i < pages.length; i++) {
    emit(contentStart + i, "<< /Length " + pages[i].length + " >>\nstream\n" + pages[i] + "endstream");
  }
  var count = contentStart + pages.length;
  var xref = "xref\n0 " + count + "\n0000000000 65535 f \n";
  for (var i = 1; i < count; i++) {
    xref += ("0000000000" + offsets[i]).slice(-10) + " 00000 n \n";
  }
  var pdf = HEAD + body + xref +
    "trailer\n<< /Size " + count + " /Root 1 0 R >>\nstartxref\n" + (HEAD.length + body.length) + "\n%%EOF";
  downloadBlob(new Blob([pdf], { type: "application/pdf" }), filename);
}

/* ---------------- Print ---------------- */
function printPage() { window.print(); }

/* ---------------- Date helper ---------------- */
function todayStr() { return new Date().toISOString().slice(0, 10); }

/* ---------------- ZTS GPS API connector ---------------- */
function ztsLogin(cfg) {
  return fetch(cfg.apiBase.replace(/\/+$/, "") + "/user/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.auth || !d.sid) throw new Error(d.msg || "Login failed");
      return d.sid;
    });
}

function ztsGetVehicles(cfg, sid) {
  return fetch(cfg.apiBase.replace(/\/+$/, "") + "/newmobile/get_all_vehicles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid: sid, page: 1, per_page: 500 }),
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.auth || !d.success) throw new Error(d.msg || "Failed to load vehicles");
      var list = d.current_statues || d.vehicles || d.list || d.data || d.rows || d.result || [];
      if (!Array.isArray(list)) list = [];
      window.ztsRaw = d;
      var first = list[0] || {};
      window.ztsKeys = Object.keys(first);
      var pick = function (o, keys) {
        /* Build a lowercase→value map once per object for case-insensitive lookup */
        var map = {};
        Object.keys(o).forEach(function (k) { map[k.toLowerCase()] = o[k]; });
        for (var i = 0; i < keys.length; i++) {
          var val = map[keys[i].toLowerCase()];
          if (val === undefined || val === null || val === "") continue;
          if (typeof val === "string" && /^(na|n\/a|none|-)$/i.test(val.trim())) continue;
          return val;
        }
        return "";
      };
      var relAgeSec = function (str) {
        if (!str) return null;
        str = String(str).toLowerCase();
        if (!/\d/.test(str)) return 0;
        var total = 0, m = str.match(/(\d+(?:\.\d+)?)\s*(sec|min|hour|day|week|month)s?/g) || [];
        var mult = { sec: 1, min: 60, hour: 3600, day: 86400, week: 604800, month: 2592000 };
        m.forEach(function (t) {
          var p = t.match(/(\d+(?:\.\d+)?)\s*(sec|min|hour|day|week|month)/);
          if (p) total += Number(p[1]) * (mult[p[2]] || 0);
        });
        return total;
      };
      return list.map(function (v) {
        if (!v || typeof v !== "object") return null;
        var lat = Number(pick(v, ["latitude", "lat", "gps_lat", "latd"])), lng = Number(pick(v, ["longitude", "lng", "lon", "gps_lng", "lngtd"]));
        var plate = String(pick(v, ["plate_no", "plate_number", "plate", "plateNo", "number_plate", "veh_plate", "vehicle_no"])).trim().toUpperCase();
        if (!plate || !isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return null;
        var speed = Math.max(0, Number(pick(v, ["speed", "spd", "speedkmh", "speedkm", "speedkmh", "speed_kmh", "speed_km", "speed_km_h", "vehiclespeed", "gpsspeed", "speedvalue", "currentspeed", "devicespeed"])) || 0);
        var maxTodayRaw = pick(v, ["max_speed_today", "today_max_speed", "day_max_speed", "daily_max_speed", "max_speed_day", "maxspeed_today", "today_max", "max_today", "max_speed", "maxspeed", "max_speed_of_day", "maxspeedtoday", "todaymaxspeed", "maxspeedofday", "daily_max", "daymaxspeed", "maxspeed_of_day"]);
        var maxToday = Number(maxTodayRaw);
        if (!isFinite(maxToday) || maxToday <= 0) maxToday = null;
        var ignition = pick(v, ["ignition", "acc", "acc_state", "power", "power_status", "engine", "engine_state", "motor", "ignition_status", "accstatus"]);
        var movement = pick(v, ["movement", "moving", "is_moving", "move", "moving_state", "run_state", "movingstatus", "vehicle_movement"]);
        var rawStatus = pick(v, ["status", "state", "device_status", "device_state", "event", "vehicle_status", "alarm", "alarm_type", "current_status", "device_state_name"]);
        var movingFlag = movement === 1 || movement === true || movement === "1" || movement === "true";
        return {
          plate: plate,
          lat: lat,
          lng: lng,
          speed: speed,
          maxSpeedToday: maxToday,
          ignition: ignition,
          moving: movement,
          online: pick(v, ["online", "is_online", "online_status", "on_line", "device_online", "connected", "network_status"]),
          stopped: pick(v, ["stop", "stopped", "is_stop", "park", "parking", "park_state", "is_parked", "parking_status"]),
          rawStatus: rawStatus,
          age: relAgeSec(pick(v, ["relative_timestamp", "relative_time", "last_update", "data_age"])),
          ageText: pick(v, ["relative_timestamp", "relative_time", "last_update", "data_age"]),
          status: speed > 0 || movingFlag
            ? "transit"
            : (ignition === false || ignition === 0 || ignition === "0" || String(ignition).toLowerCase() === "off" ? "stop" : "idle"),
          driver: pick(v, ["driver_name", "driverName", "driver", "driver_name1", "dname", "drivername", "assigned_driver"]),
          driverPhone: pick(v, ["driver_phone", "driver_mobile", "driver_tel", "driverPhone", "driverphone", "drivermobile"]),
          time: pick(v, ["timestamp", "gps_time", "time", "device_time", "upload_time", "gps_timestamp", "fix_time", "date_time"]),
          fuel: pick(v, ["fuel_1", "fuel", "fuel_level", "fuel_left", "fuel_remaining"]),
          location: pick(v, ["location_text", "address", "location", "position_text", "place", "route", "area"]),
          angle: pick(v, ["angle", "direction", "course", "heading", "deg"]),
          altitude: pick(v, ["altitude", "alt", "alt_value"]),
          model: pick(v, ["vehicle_type_name", "vehicle_type", "type_name", "vehicle_name", "model", "vtype"]),
        };
      }).filter(Boolean);
    });
}

function ztsFetchLive(cfg) {
  return ztsLogin(cfg).then(function (sid) { return ztsGetVehicles(cfg, sid); });
}

function ztsFetchAlerts(cfg) {
  var base = cfg.apiBase.replace(/\/+$/, "");
  return ztsLogin(cfg).then(function (sid) {
    return fetch(base + "/notification/getNotifications?sid=" + encodeURIComponent(sid) + "&channel=web", {
      method: "GET",
      headers: { "Accept": "application/json" },
    }).then(function (r) { return r.json(); }).then(function (d) {
      window.ztsAlertDebug = { endpoint: "/api/notification/getNotifications", response: d, account: cfg.label };
      var list = d.list || d.data || d.notifications || d.alerts || d.rows || d.result || [];
      if (!Array.isArray(list)) list = [];
      return list.map(function (a) {
        if (!a || typeof a !== "object") return null;
        var map = {};
        Object.keys(a).forEach(function (k) { map[k.toLowerCase()] = a[k]; });
        var pick2 = function (keys) {
          for (var j = 0; j < keys.length; j++) {
            var val = map[keys[j].toLowerCase()];
            if (val === undefined || val === null || val === "") continue;
            return val;
          }
          return "";
        };
        var plate = String(pick2(["plate_no", "plate_number", "plate", "plateNo", "number_plate", "vehicle_no", "veh_plate", "vehicleno", "vehicle_plate"])).trim().toUpperCase();
        var alertType = String(pick2(["alert_type", "alerttype", "type", "alarm_type", "alarmtype", "alarm", "event", "event_type", "alert_name", "notification_type", "name", "title", "message"])).trim();
        var company = pick2(["company", "company_name", "fleet", "fleet_name", "owner", "group_name"]);
        var rawSpeed = Number(pick2(["speed", "speed_kmh", "speedkmh", "max_speed", "maxspeed", "currentspeed", "high_speed", "highest_speed"]));
        var rawTime = pick2(["timestamp", "alert_time", "time", "event_time", "gps_time", "datetime", "date_time", "created_at", "start_time", "occurred_at"]);
        var rawLoc = pick2(["location", "location_text", "address", "position", "place", "route", "area", "nearestplace"]);
        var rawLat = Number(pick2(["lat", "latitude", "gps_lat"]));
        var rawLng = Number(pick2(["lng", "lon", "longitude", "gps_lng"]));
        var catLower = alertType.toLowerCase();
        var category = "other";
        if (/speed|overspeed|overspeeding|over_speed|fast/.test(catLower)) category = "speeding";
        else if (/driv|continuous|fatigue|tired|long/.test(catLower)) category = "continuous_driving";
        else if (/plug|unplug|power|discon|vib/.test(catLower)) category = "device";
        else if (/zone|geofence|area|in|out/.test(catLower)) category = "zone";
        else if (/idling|idle/.test(catLower)) category = "other";
        else if (/ SOS |sos|panic|emergency/.test(catLower)) category = "other";
        return {
          plate: plate,
          company: company || "",
          alertType: alertType || "Unknown",
          category: category,
          speed: rawSpeed || 0,
          location: rawLoc || "",
          lat: isFinite(rawLat) ? rawLat : null,
          lng: isFinite(rawLng) ? rawLng : null,
          time: rawTime || "",
          raw: a,
        };
      }).filter(Boolean);
    }, function (err) {
      window.ztsAlertDebug = { error: (err && err.message) || String(err), account: cfg.label };
      return [];
    });
  });
}

function ztsTestConnection(cfg) {
  var t0 = Date.now();
  return ztsFetchLive(cfg).then(function (list) {
    return { ok: true, count: list.length, ms: Date.now() - t0, sample: list[0] || null };
  }, function (err) {
    return { ok: false, error: (err && err.message) || String(err), ms: Date.now() - t0 };
  });
}
