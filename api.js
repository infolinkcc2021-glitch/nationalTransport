/* National Transport PLC — backend API adapter.
 * Bridges the localStorage data layer to the FastAPI backend.
 * Works fully offline if the API is unreachable.
 */
(function () {
  "use strict";

  var SESSION_KEY = "ntp_session";

  var LOCAL_BASE = location.origin + "/api";
  var REMOTE_BASE = "https://nt.ztrackinsight.com/api";
  var activeBase = null;

  function baseURL() {
    if (activeBase) return activeBase;
    var explicit = localStorage.getItem("ntp_api_base");
    if (explicit) return explicit;
    return REMOTE_BASE;
  }

  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { return null; }
  }
  function saveSession(s) {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  }
  function authHeaders() {
    var s = getSession();
    return s && s.token ? { Authorization: "Bearer " + s.token } : {};
  }

  function req(method, path, body, headers) {
    var opts = {
      method: method,
      headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(baseURL() + path, opts).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.detail) || ("HTTP " + res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  var RESTRICTED_PAGES = ["fleet.html", "tracking.html", "performance.html", "vehperf.html", "kpi.html", "reports.html", "daily.html", "admin.html"];

  function guardCustomer() {
    var s = getSession();
    if (s && s.user.role === "customer") {
      var path = location.pathname.split("/").pop() || "index.html";
      if (RESTRICTED_PAGES.indexOf(path) !== -1) {
        location.replace("portal.html");
      }
    }
  }
  guardCustomer();

  var online = false;
  var syncing = false;
  var readyResolve;
  var ready = new Promise(function (res) { readyResolve = res; });

  function isOnline() { return online; }
  function isSyncing() { return syncing; }
  function user() { var s = getSession(); return s ? s.user : null; }
  function isAdmin() { var u = user(); return !!(u && u.role === "admin"); }
  function isAuthed() { return !!getSession(); }

  function emitSynced() {
    if (typeof window.afterApiSync === "function") {
      try { window.afterApiSync(); } catch (e) {}
    }
    try { window.dispatchEvent(new CustomEvent("ntp:synced")); } catch (e) {}
  }

  function onChange() {
    if (!online || syncing) return;
    var s = getSession();
    if (!s || s.user.role !== "admin") return;
    var kinds = ["vehicles", "drivers", "trips", "orders"];
    kinds.forEach(function (kind) {
      req("PUT", "/" + kind, DB.get(kind, []), authHeaders()).catch(function (e) {
        if (window.console) console.warn("API sync failed for " + kind, e);
      });
    });
  }

  function onLocalChange(kind) {
    if (!online || syncing) return;
    var s = getSession();
    if (!s || s.user.role !== "admin") return;
    req("PUT", "/" + kind, DB.get(kind, []), authHeaders()).catch(function (e) {
      if (window.console) console.warn("API sync failed for " + kind, e);
    });
  }

  function refreshAuthUI() {
    var area = document.getElementById("authArea");
    if (!area) return;
    var u = user();
    var status = '<span class="api-badge ' + (online ? "api-on" : "api-off") + '" title="Backend server">' +
      (online ? "Server online" : "Server offline") + "</span>";
    if (u) {
      area.innerHTML = status +
        '<span class="nav-user" title="' + esc(u.email || "") + '">&#128100; ' + esc(u.full_name || u.username) +
        (u.role === "admin" ? ' <span class="badge badge-admin">Admin</span>' : "") + "</span>" +
        '<button class="btn btn-outline btn-sm" id="logoutBtn">Sign out</button>';
      var lo = document.getElementById("logoutBtn");
      if (lo) lo.addEventListener("click", function () {
        saveSession(null);
        toast("Signed out", "success");
        location.reload();
      });
    } else {
      area.innerHTML = status +
        '<button class="btn btn-outline btn-sm" id="loginBtn">&#128100; Sign in</button>';
      var lb = document.getElementById("loginBtn");
      if (lb) lb.addEventListener("click", openAuthModal);
    }
  }

  function renderAuth() {
    var area = document.getElementById("authArea");
    if (!area) return;
    refreshAuthUI();
  }

  function loginModalHTML() {
    return '<div class="modal-backdrop" id="authModal"><div class="modal">' +
      '<div class="modal-header"><h3 id="authTitle">Sign in</h3><button class="modal-close" onclick="API.closeAuthModal()">&times;</button></div>' +
      '<div class="modal-body">' +
      '<div class="fleet-toolbar mb-2">' +
      '<button class="chip on" id="tabLogin">Sign in</button>' +
      '<button class="chip" id="tabRegister">Create account</button>' +
      "</div>" +
      '<form id="authForm">' +
      '<div class="form-group"><label id="lblCred">Username or email</label>' +
      '<input id="aCred" class="input" autocomplete="username" required></div>' +
      '<div id="regFields" style="display:none">' +
      '<div class="form-row">' +
      '<div class="form-group"><label>Full name</label><input id="aName" class="input" autocomplete="name"></div>' +
      '<div class="form-group"><label>Phone</label><input id="aPhone" class="input" autocomplete="tel"></div>' +
      "</div></div>" +
      '<div class="form-group"><label>Password</label>' +
      '<input type="password" id="aPass" class="input" autocomplete="current-password" required></div>' +
      '<button class="btn btn-primary btn-block" id="authSubmit" type="submit">Sign in</button>' +
      "</form>" +
      '<div class="form-hint mt-2">Demo admin: <b>admin / admin123</b> &nbsp;&middot;&nbsp; Demo customer: <b>customer / customer123</b></div>' +
      "</div></div></div>";
  }

  function openAuthModal() {
    if (!document.getElementById("authModal")) {
      var div = document.createElement("div");
      div.innerHTML = loginModalHTML();
      document.body.appendChild(div.firstChild);
      bindAuthModal();
    }
    document.getElementById("authModal").classList.add("show");
  }

  function closeAuthModal() {
    var m = document.getElementById("authModal");
    if (m) m.classList.remove("show");
  }

  function bindAuthModal() {
    var mode = "login";
    var title = document.getElementById("authTitle");
    var btn = document.getElementById("authSubmit");
    function setMode(m) {
      mode = m;
      document.getElementById("tabLogin").classList.toggle("on", m === "login");
      document.getElementById("tabRegister").classList.toggle("on", m === "register");
      document.getElementById("regFields").style.display = m === "register" ? "" : "none";
      document.getElementById("lblCred").textContent = m === "register" ? "Username" : "Username or email";
      title.textContent = m === "register" ? "Create customer account" : "Sign in";
      btn.textContent = m === "register" ? "Create account" : "Sign in";
    }
    document.getElementById("tabLogin").addEventListener("click", function () { setMode("login"); });
    document.getElementById("tabRegister").addEventListener("click", function () { setMode("register"); });
    document.getElementById("authForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var cred = document.getElementById("aCred").value.trim();
      var pass = document.getElementById("aPass").value;
      if (!cred || !pass) { toast("Enter your credentials", "error"); return; }
      btn.disabled = true;
      btn.textContent = "Please wait…";
      var call = mode === "register"
        ? req("POST", "/auth/register", {
            username: cred,
            email: document.getElementById("aCred").value.trim() || cred,
            full_name: document.getElementById("aName").value.trim(),
            phone: document.getElementById("aPhone").value.trim(),
            password: pass,
          }).then(function () { return req("POST", "/auth/login", { username_or_email: cred, password: pass }); })
        : req("POST", "/auth/login", { username_or_email: cred, password: pass });
      call.then(function (r) {
        saveSession(r);
        btn.disabled = false;
        closeAuthModal();
        toast("Welcome, " + (r.user.full_name || r.user.username), "success");
        if (r.user.role === "customer") {
          location.href = "portal.html";
          return;
        }
        if (location.pathname.indexOf("admin.html") !== -1 || location.pathname.indexOf("portal.html") !== -1) {
          location.reload();
        } else {
          renderAuth();
          if (typeof window.layout === "object" && window.layout.render) window.layout.render();
        }
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = mode === "register" ? "Create account" : "Sign in";
        toast(err.message || "Login failed", "error");
      });
    });
    var closes = document.querySelectorAll("#authModal .modal-close");
    for (var i = 0; i < closes.length; i++) closes[i].addEventListener("click", closeAuthModal);
    document.getElementById("authModal").addEventListener("click", function (e) {
      if (e.target === document.getElementById("authModal")) closeAuthModal();
    });
  }

  function pushAll() {
    var kinds = ["vehicles", "drivers", "trips"];
    return Promise.all(kinds.map(function (kind) {
      return req("PUT", "/" + kind, DB.get(kind, []), authHeaders()).catch(function (e) { return null; });
    })).then(function () {
      var s = getSession();
      if (s && s.user.role === "admin") {
        return req("PUT", "/orders", DB.get("orders", []), authHeaders()).catch(function () { return null; });
      }
      return null;
    });
  }

  /* Union two arrays by keyFn; earlier list wins on conflict. */
  function unionBy(listA, listB, keyFn) {
    var map = {};
    (listA || []).forEach(function (x) { map[keyFn(x)] = x; });
    (listB || []).forEach(function (x) { map[keyFn(x)] = x; });
    return Object.values(map);
  }

  /* Pull the backend dataset into localStorage. Merge seed ∪ local ∪ server so
   * the full seed fleet is never lost when the backend has fewer rows. */
  function sync() {
    if (syncing) return Promise.resolve();
    syncing = true;
    return req("GET", "/vehicles").then(function (v) {
      if (Array.isArray(v) && v.length) {
        DB.set("vehicles", unionBy(unionBy(seedVehicles(), DB.get("vehicles", []), function (x) { return x.plate; }), v, function (x) { return x.plate; }));
        var pulls = [
          req("GET", "/drivers").then(function (d) {
            if (!Array.isArray(d) || !d.length) return;
            DB.set("drivers", unionBy(unionBy(seedDrivers(), DB.get("drivers", []), function (x) { return x.id; }), d, function (x) { return x.id; }));
          }),
          req("GET", "/trips").then(function (t) {
            if (!Array.isArray(t) || !t.length) return;
            DB.set("trips", unionBy(unionBy(seedTrips(), DB.get("trips", []), function (x) { return x.id; }), t, function (x) { return x.id; }));
          }),
        ];
        var s = getSession();
        if (s && s.user.role === "admin") {
          pulls.push(req("GET", "/orders").then(function (o) {
            if (!Array.isArray(o) || !o.length) return;
            DB.set("orders", unionBy(DB.get("orders", []), o, function (x) { return x.id; }));
          }));
        }
        return Promise.all(pulls);
      }
      return pushAll();
    }).catch(function () { return null; }).then(function () {
      syncing = false;
      renderAuth();
    });
  }

  function init() {
    function start() {
      req("GET", "/health").then(function () {
        online = true;
        refreshAuthUI();
        return sync();
      }).catch(function () {
        online = false;
        refreshAuthUI();
      }).then(function () {
        emitSynced();
        readyResolve();
      });
    }
    if (localStorage.getItem("ntp_api_base")) {
      activeBase = localStorage.getItem("ntp_api_base");
      start();
    } else {
      fetch(LOCAL_BASE + "/health").then(function (res) {
        if (!res.ok) throw new Error("not local");
        activeBase = LOCAL_BASE;
        return res.json();
      }).then(function () {
        start();
      }).catch(function () {
        activeBase = REMOTE_BASE;
        start();
      });
    }
  }

  window.API = {
    base: baseURL,
    isOnline: isOnline,
    isAuthed: isAuthed,
    isAdmin: isAdmin,
    user: user,
    authHeaders: authHeaders,
    req: req,
    onChange: onChange,
    onLocalChange: onLocalChange,
    sync: sync,
    renderAuth: renderAuth,
    openAuthModal: openAuthModal,
    closeAuthModal: closeAuthModal,
    ready: ready,
    init: init,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
