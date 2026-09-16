/* National Transport PLC — shared header & footer injection */
"use strict";

(function () {
  var NAV = [
    { page: "home", href: "index.html", label: "Home", roles: ["guest", "admin", "customer"] },
    { page: "fleet", href: "fleet.html", label: "Fleet Dashboard", roles: ["guest", "admin"] },
    { page: "tracking", href: "tracking.html", label: "Live Tracking", roles: ["guest", "admin"] },
    { page: "reports", href: "reports.html", label: "Reports", roles: ["guest", "admin"] },
    { page: "daily", href: "daily.html", label: "Daily Summary", roles: ["guest", "admin"] },
    { page: "kpi", href: "kpi.html", label: "KPI Dashboard", roles: ["admin"] },
    { page: "portal", href: "portal.html", label: "Customer Portal", roles: ["guest", "admin", "customer"] },
    { page: "admin", href: "admin.html", label: "Admin", roles: ["admin"] },
    { page: "contact", href: "contact.html", label: "Contact", roles: ["guest", "admin", "customer"] },
  ];

  function currentRole() {
    try {
      var s = JSON.parse(localStorage.getItem("ntp_session") || "null");
      return s && s.user ? s.user.role : "guest";
    } catch (e) {
      return "guest";
    }
  }

  function visibleNav() {
    var role = currentRole();
    return NAV.filter(function (l) { return l.roles.indexOf(role) !== -1; });
  }

  function navHTML(current) {
    var links = visibleNav().map(function (l) {
      var active = l.page === current ? " class=\"active\"" : "";
      return '<a href="' + l.href + '" data-page="' + l.page + '"' + active + ">" + l.label + "</a>";
    }).join("");
    return (
      '<div class="topbar"><div class="container">' +
      '<span>&#128231; ops@nationaltransport.et</span>' +
      '<span>&#9742; +251 111 234 567 &nbsp;|&nbsp; 24/7 Support Line</span>' +
      "</div></div>" +
      '<header class="site-header"><div class="container nav">' +
      '<a href="index.html" class="brand">' +
      '<span class="brand-logo">NT</span>' +
      '<span><span class="brand-name">National Transport</span><br><span class="brand-sub">Logistics &amp; Freight PLC</span></span>' +
      "</a>" +
      '<button class="nav-toggle" id="navToggle" aria-label="Menu"><span class="bar"></span><span class="bar"></span><span class="bar"></span></button>' +
      '<nav class="nav-links" id="navLinks">' +
      links +
      '<a href="portal.html" class="nav-cta">Track Shipment</a>' +
      '<span class="nav-auth" id="authArea"></span>' +
      "</nav>" +
      "</div></header>"
    );
  }

  function footerHTML() {
    var role = currentRole();
    var quick = [
      { href: "index.html", label: "Home", roles: ["guest", "admin", "customer"] },
      { href: "fleet.html", label: "Fleet Dashboard", roles: ["guest", "admin"] },
      { href: "tracking.html", label: "Live Tracking", roles: ["guest", "admin"] },
      { href: "reports.html", label: "Reports", roles: ["guest", "admin"] },
      { href: "daily.html", label: "Daily Summary", roles: ["guest", "admin"] },
      { href: "kpi.html", label: "KPI Dashboard", roles: ["admin"] },
      { href: "portal.html", label: "Customer Portal", roles: ["guest", "admin", "customer"] },
      { href: "contact.html", label: "Contact &amp; Support", roles: ["guest", "admin", "customer"] },
    ].filter(function (l) { return l.roles.indexOf(role) !== -1; });
    return (
      '<footer class="site-footer">' +
      '<div class="container">' +
      '<div class="footer-grid">' +
      '<div class="footer-brand">' +
      '<a href="index.html" class="brand"><span class="brand-logo">NT</span>' +
      '<span><span class="brand-name" style="color:#fff">National Transport</span><br>' +
      '<span class="brand-sub">Logistics &amp; Freight PLC</span></span></a>' +
      "<p>Reliable freight and logistics solutions across the region. Our fleet moves your materials safely, on time, every time.</p>" +
      "</div>" +
      "<div>" +
      "<h4>Quick Links</h4><ul>" +
      quick.map(function (l) { return '<li><a href="' + l.href + '">' + l.label + "</a></li>"; }).join("") +
      "</ul></div>" +
      "<div>" +
      "<h4>Services</h4><ul>" +
      "<li>Heavy Haulage</li><li>Container Transport</li>" +
      "<li>Refrigerated Cargo</li><li>Construction Materials</li>" +
      "<li>Dry Van Freight</li><li>Fleet Leasing</li>" +
      "</ul></div>" +
      "<div>" +
      "<h4>Head Office</h4><ul>" +
      "<li>Bole Road, Addis Ababa, Ethiopia</li>" +
      "<li>+251 111 234 567</li>" +
      "<li>+251 911 234 567 (24/7)</li>" +
      "<li>ops@nationaltransport.et</li>" +
      "</ul></div>" +
      "</div>" +
      '<div class="footer-bottom"><span>&copy; ' + new Date().getFullYear() +
      ' National Transport PLC. All rights reserved.</span>' +
      "<span>Transport &middot; Logistics &middot; Freight</span></div>" +
      "</div></footer>"
    );
  }

  function render() {
    var current = document.body.dataset.page || "home";
    var h = document.getElementById("siteHeader");
    var f = document.getElementById("siteFooter");
    if (h) h.innerHTML = navHTML(current);
    if (f) f.innerHTML = footerHTML();
    if (current === "home") {
      var navActive = document.querySelectorAll("#navLinks a");
      if (navActive.length) navActive[0].classList.add("active");
    }
  }

  window.layout = { render: render, currentRole: currentRole };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
