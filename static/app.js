/* Форма ГАП Документы: счёт, акт, мои счета, новый заказчик. */
(function () {
  "use strict";
  const tg = window.Telegram && window.Telegram.WebApp;
  const inTelegram = !!(tg && tg.initData);
  if (tg) { tg.ready(); tg.expand(); }

  const root = document.getElementById("root");
  const fallbackBtn = document.getElementById("fallback-main");
  const params = new URLSearchParams(location.search);
  const S = { boot: null, invoices: null, draft: {}, customerDraft: {}, actPick: null, annul: null };
  const ANNULLED = "аннулирован";

  // ---------------------------------------------------------------- helpers
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (id) => document.getElementById(id);
  const val = (id) => ($(id) ? $(id).value.trim() : "");

  // API — функция gap в Supabase; сама форма лежит на GitHub Pages
  const API = "https://pijklsxxbtpfulbuiwvs.supabase.co/functions/v1/gap";

  async function api(path, body) {
    const opts = { headers: { "X-Telegram-Init-Data": (tg && tg.initData) || "" } };
    if (body !== undefined) { opts.method = "POST"; opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
    const r = await fetch(API + path, opts);
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = { error: text }; }
    if (!r.ok) throw new Error(data.error || text || "Ошибка " + r.status);
    return data;
  }

  let mainHandler = null;
  function setMain(text, handler) {
    if (inTelegram) {
      if (mainHandler) tg.MainButton.offClick(mainHandler);
      mainHandler = handler;
      if (!handler) { tg.MainButton.hide(); return; }
      tg.MainButton.setText(text); tg.MainButton.enable(); tg.MainButton.show(); tg.MainButton.onClick(handler);
    } else {
      fallbackBtn.hidden = !handler; fallbackBtn.textContent = text || ""; fallbackBtn.onclick = handler; fallbackBtn.disabled = false;
    }
  }
  function busy(on) {
    if (inTelegram) { on ? (tg.MainButton.showProgress(), tg.MainButton.disable()) : (tg.MainButton.hideProgress(), tg.MainButton.enable()); }
    else fallbackBtn.disabled = on;
  }
  function setBack(handler) {
    if (!tg || !tg.BackButton) return;
    tg.BackButton.offClick(setBack._h || (() => {}));
    setBack._h = handler;
    if (handler) { tg.BackButton.show(); tg.BackButton.onClick(handler); } else tg.BackButton.hide();
  }
  function showError(msg) {
    const box = $("err");
    if (box) { box.textContent = msg; box.hidden = false; box.scrollIntoView({ block: "nearest" }); }
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("error");
  }
  function markErr(ids) { ids.forEach((id) => $(id) && $(id).closest(".field").classList.add("err")); }
  document.addEventListener("input", (e) => { const f = e.target.closest(".field.err"); if (f) f.classList.remove("err"); });

  function done(title, text) {
    setMain(null); setBack(null);
    root.innerHTML = `<div class="done"><div class="big">✅</div><h1>${esc(title)}</h1><p class="hint">${esc(text)}</p>
      <button class="btn" id="again">Ещё документ</button></div>`;
    $("again").onclick = () => { S.invoices = null; go("invoice"); };
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
    if (inTelegram) setTimeout(() => tg.close(), 2200);
  }

  function go(page) { if (location.hash !== "#" + page) location.hash = page; else route(); }
  window.addEventListener("hashchange", route);

  // ---------------------------------------------------------------- выбор заказчика
  const norm = (t) => String(t || "").toLowerCase().replace(/ё/g, "е").replace(/["'«»“”]/g, "").replace(/\s+/g, " ").trim();
  const DETAIL_LABELS = { address: "Юр. адрес с индексом", account: "Расчётный счёт (IBAN)", bank: "Банк", bic: "BIC" };
  const DETAIL_HINTS = { address: "230000, г. Гродно, ул. …", account: "BY28 MTBK 3012 0001 0933 0012 2757", bank: 'ЗАО "МТБанк", г. Минск', bic: "MTBKBY22" };

  function findCustomers(q) {
    const list = S.boot.customers;
    const n = norm(q), digits = q.replace(/\D/g, "");
    if (!n) return S.boot.recent.map((id) => list.find((c) => c.id === id)).filter(Boolean);
    const scored = [];
    for (const c of list) {
      const name = norm(c.name);
      let score = -1;
      if (digits.length >= 3 && c.unp.startsWith(digits)) score = 0;
      else if (name.startsWith(n)) score = 1;
      else if (name.split(" ").some((w) => w.startsWith(n))) score = 2;
      else if (name.includes(n)) score = 3;
      if (score >= 0) scored.push([score, c]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name, "ru")).slice(0, 8).map((x) => x[1]);
  }

  function customerList(q) {
    const found = findCustomers(q);
    const items = found.map((c) => `<button class="pick" data-id="${c.id}" ${c.ready ? "" : "disabled"}>
        <span>${esc(c.name)}</span><span class="sub">${c.unp ? "УНП " + esc(c.unp) : "нет УНП — допишите в таблице"}</span></button>`).join("");
    const head = !norm(q) ? (found.length ? `<p class="hint">Недавние</p>` : `<p class="hint">Начните вводить название или УНП</p>`)
      : found.length ? "" : `<p class="hint">Не нашли «${esc(q)}» в справочнике</p>`;
    return head + items + `<button class="pick add" data-id="new">+ Новый заказчик (по УНП)</button>`;
  }

  function fillBank(prefix) {
    // по коду банка в IBAN подставляем банк и BIC, если их ещё не вводили
    const acc = $(prefix + "account"); if (!acc) return;
    acc.addEventListener("input", () => {
      const code = acc.value.replace(/\s/g, "").toUpperCase().slice(4, 8), b = S.boot.banks[code];
      if (!b) return;
      for (const k of ["bank", "bic"]) { const el = $(prefix + k); if (el && (!el.value || el.dataset.auto)) { el.value = b[k]; el.dataset.auto = "1"; } }
    });
    for (const k of ["bank", "bic"]) { const el = $(prefix + k); if (el) el.addEventListener("input", () => delete el.dataset.auto); }
  }

  // ---------------------------------------------------------------- счёт
  function invoicePage() {
    const d = S.draft, b = S.boot;
    d.details = d.details || {};
    const picked = b.customers.find((c) => String(c.id) === String(d.customer));
    const missing = picked ? picked.missing : [];
    const custBlock = picked
      ? `<div class="picked"><div><div>${esc(picked.name)}</div><div class="sub">УНП ${esc(picked.unp)}</div></div>
           <button class="btn small" id="cust-change">Изменить</button></div>`
      : `<input id="cust-q" type="search" placeholder="Название или УНП" value="${esc(d.q)}" autocomplete="off">
         <div id="cust-list" class="pick-list">${customerList(d.q || "")}</div>`;
    const detailFields = missing.length ? `<div class="note warn">У этого заказчика в справочнике нет юридического адреса.
        Заполните один раз — сохранится для следующих счетов.</div>` +
      missing.map((k) => `<div class="field"><label for="det-${k}">${DETAIL_LABELS[k]}</label>
        <input id="det-${k}" placeholder="${esc(DETAIL_HINTS[k])}" value="${esc(d.details[k])}" autocomplete="off" ${k === "account" || k === "bic" ? 'autocapitalize="characters"' : ""}></div>`).join("") : "";
    root.innerHTML = `
      <h1>Новый счёт</h1>
      <div id="err" class="note err" hidden></div>
      <div class="field" id="cust-field"><label for="cust-q">Заказчик</label>${custBlock}</div>
      ${detailFields}
      <div class="field"><label for="car">Автомобиль: марка и госномер</label><input id="car" placeholder="Фиат ВА 7228-7" value="${esc(d.car)}" autocomplete="off"></div>
      <div class="field"><label for="from">Откуда</label><input id="from" placeholder="г.Гродно, ул.Щорса" value="${esc(d.from)}" autocomplete="off"></div>
      <div class="field"><label for="to">Куда</label><input id="to" placeholder="г.Гродно, ул.Суворова" value="${esc(d.to)}" autocomplete="off"></div>
      <div class="field"><label for="price">Сумма, BYN</label><input id="price" inputmode="decimal" placeholder="180" value="${esc(d.price)}" autocomplete="off"></div>
      <p class="hint">Номер и дата проставятся автоматически. PDF придёт в чат с ботом.</p>
      <div class="row"><button class="btn small" id="to-list">📋 Мои счета</button><button class="btn small" id="to-act">✅ Акт по счёту</button></div>`;
    const save = () => {
      Object.assign(d, { car: val("car"), from: val("from"), to: val("to"), price: val("price") });
      if ($("cust-q")) d.q = val("cust-q");
      missing.forEach((k) => (d.details[k] = val("det-" + k)));
    };
    if (picked) {
      $("cust-change").onclick = () => { save(); d.customer = ""; d.details = {}; invoicePage(); $("cust-q").focus(); };
      fillBank("det-");
    } else {
      $("cust-q").oninput = () => { $("cust-list").innerHTML = customerList(val("cust-q")); };
      $("cust-list").onclick = (e) => {
        const btn = e.target.closest(".pick"); if (!btn || btn.disabled) return;
        save();
        if (btn.dataset.id === "new") {
          const digits = (d.q || "").replace(/\D/g, "");
          S.customerDraft = digits.length === 9 ? { unp: digits } : {};
          go("customer");
          return;
        }
        d.customer = btn.dataset.id; d.q = ""; d.details = {};
        invoicePage();
      };
    }
    $("to-list").onclick = () => { save(); go("list"); };
    $("to-act").onclick = () => { save(); go("act"); };
    setBack(null);
    setMain("Создать счёт", async () => {
      save();
      const bad = [];
      if (!d.customer) bad.push("cust-q");
      missing.forEach((k) => { if (!d.details[k]) bad.push("det-" + k); });
      if (d.details.account && !/^BY\d{2}[A-Z0-9]{24}$/i.test(d.details.account.replace(/\s/g, ""))) bad.push("det-account");
      if (!d.car) bad.push("car"); if (!d.from) bad.push("from"); if (!d.to) bad.push("to");
      const price = parseFloat((d.price || "").replace(/\s/g, "").replace(",", "."));
      if (!(price > 0)) bad.push("price");
      if (bad.length) { markErr(bad); showError(d.customer ? "Заполните выделенные поля" : "Выберите заказчика"); return; }
      busy(true);
      try {
        const body = { customer: Number(d.customer), car: d.car, from: d.from, to: d.to, price: d.price };
        if (missing.length) body.details = d.details;
        const r = await api("/api/invoice", body);
        api("/api/bootstrap").then((b) => (S.boot = b)).catch(() => {});   // обновить «недавних» и реквизиты
        S.draft = {}; S.invoices = null;
        done(`Счёт № ${r.number} создан`, "PDF отправлен в чат с ботом и записан в таблицу.");
      } catch (e) { showError(e.message); } finally { busy(false); }
    });
  }

  // ---------------------------------------------------------------- новый заказчик
  function customerPage() {
    const c = S.customerDraft;
    root.innerHTML = `
      <h1>Новый заказчик</h1>
      <div id="err" class="note err" hidden></div>
      <div class="field"><label for="unp">УНП</label>
        <div class="row"><input id="unp" inputmode="numeric" maxlength="9" placeholder="9 цифр" value="${esc(c.unp)}"><button class="btn" id="find" style="flex:0 0 auto">Найти</button></div></div>
      <div id="status" class="note warn" hidden></div>
      <div class="field"><label for="name">Название (как в счёте)</label><input id="name" value="${esc(c.name)}"></div>
      <div class="field"><label for="full_name">Полное название</label><input id="full_name" value="${esc(c.full_name)}"></div>
      <div class="field"><label for="address">Юр. адрес с индексом</label><input id="address" value="${esc(c.address)}"></div>
      <div class="field"><label for="account">Расчётный счёт (IBAN), если известен</label><input id="account" placeholder="BY28 MTBK 3012 0001 0933 0012 2757" value="${esc(c.account)}" autocapitalize="characters"></div>
      <div class="field"><label for="bank">Банк</label><input id="bank" placeholder='ЗАО "МТБанк", г. Минск' value="${esc(c.bank)}"></div>
      <div class="field"><label for="bic">BIC</label><input id="bic" placeholder="MTBKBY22" value="${esc(c.bic)}" autocapitalize="characters"></div>
      <p class="hint">Название и адрес подтянутся из реестра МНС. Проверьте адрес: в реестре нет почтового индекса. Расчётный счёт можно не указывать: в счёте тогда будет только УНП.</p>`;
    const save = () => ["unp", "name", "full_name", "address", "account", "bank", "bic"].forEach((k) => (c[k] = val(k)));
    fillBank("");
    $("find").onclick = async () => {
      save();
      if (!/^\d{9}$/.test(c.unp)) { markErr(["unp"]); showError("УНП — это 9 цифр"); return; }
      $("find").disabled = true;
      try {
        const r = await api("/api/unp/" + c.unp);
        Object.assign(c, { name: r.name, full_name: r.full_name, address: c.address || r.address });
        customerPage();
        if (!r.active) { $("status").textContent = `Статус в реестре: ${r.status}. Проверьте, можно ли выставлять счёт.`; $("status").hidden = false; }
      } catch (e) { showError(e.message); } finally { if ($("find")) $("find").disabled = false; }
    };
    setBack(() => { save(); go("invoice"); });
    setMain("Сохранить заказчика", async () => {
      save();
      const bad = [];
      if (!/^\d{9}$/.test(c.unp)) bad.push("unp"); if (!c.name) bad.push("name"); if (!c.address) bad.push("address");
      if (c.account) { if (!c.bank) bad.push("bank"); if (!c.bic) bad.push("bic"); }   // счёт заказчика необязателен
      if (bad.length) { markErr(bad); showError("Заполните выделенные поля"); return; }
      busy(true);
      try {
        const r = await api("/api/customer", c);
        S.boot = await api("/api/bootstrap");
        S.customerDraft = {}; S.draft.customer = String(r.id);
        go("invoice");
      } catch (e) { showError(e.message); } finally { busy(false); }
    });
  }

  // ---------------------------------------------------------------- акт
  async function actPage() {
    root.innerHTML = `<p class="hint center">Загружаю счета…</p>`;
    setMain(null);
    if (!S.invoices) S.invoices = (await api("/api/invoices")).invoices;
    const open = S.invoices.filter((i) => !i.act && i.status !== ANNULLED);
    const pre = S.actPick || Number(params.get("inv")) || null;
    const preInv = open.find((i) => i.number === pre);
    const byCustomer = {};
    open.forEach((i) => (byCustomer[i.customer] = byCustomer[i.customer] || []).push(i));
    const names = Object.keys(byCustomer).sort();
    let current = preInv ? preInv.customer : names.length === 1 ? names[0] : "";
    const render = () => {
      const list = current ? byCustomer[current] : [];
      root.innerHTML = `
        <h1>Акт по счёту</h1>
        <div id="err" class="note err" hidden></div>
        ${names.length ? "" : `<div class="note">Все счета уже с актами. Сначала создайте счёт.</div>`}
        <div class="field"><label for="cust">Заказчик</label><select id="cust"><option value="">— выберите —</option>
          ${names.map((n) => `<option ${n === current ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></div>
        ${list.length ? `<div class="field"><label>${list.length > 1 ? "Отметьте поездки для акта (можно несколько)" : "Поездка в акте"}</label>
          <div class="checks">${list.map((i) => {
            const on = list.length === 1 || i.number === pre;
            return `<label class="check${on ? " on" : ""}"><input type="checkbox" value="${i.number}" ${on ? "checked" : ""}>
              <span class="box" aria-hidden="true"></span>
              <span class="body"><span class="title">Счёт № ${i.number} от ${esc(i.date)}</span>
              <span class="sub">${esc(i.car)} · ${esc(i.from)} → ${esc(i.to)}</span></span>
              <span class="sum">${esc(i.total)}</span></label>`;
          }).join("")}</div></div>` : ""}
        <div class="field"><label for="adate">Дата акта</label><input id="adate" type="date" value="${S.boot.today}"></div>`;
      $("cust").onchange = () => { current = val("cust"); render(); };
      root.querySelectorAll(".check input").forEach((x) => (x.onchange = () => {
        x.closest(".check").classList.toggle("on", x.checked);
        if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
        countPicked();
      }));
      countPicked();
    };
    const countPicked = () => {
      const n = root.querySelectorAll(".check input:checked").length;
      setMain(n > 1 ? `Создать акт (${n} поездки)` : "Создать акт", createAct);
    };
    async function createAct() {
      const picked = [...root.querySelectorAll(".check input:checked")].map((x) => Number(x.value));
      if (!picked.length) { showError("Отметьте хотя бы одну поездку"); return; }
      busy(true);
      try {
        const r = await api("/api/act", { invoices: picked, date: val("adate") });
        S.invoices = null; S.actPick = null;
        done(`Акт № ${r.number} создан`, "PDF отправлен в чат с ботом и записан в таблицу.");
      } catch (e) { showError(e.message); } finally { busy(false); }
    }
    render();
    setBack(() => go("invoice"));
  }

  // ---------------------------------------------------------------- мои счета
  async function listPage() {
    root.innerHTML = `<p class="hint center">Загружаю счета…</p>`;
    setMain(null);
    S.invoices = (await api("/api/invoices")).invoices;
    let filter = "unpaid";
    const cls = { "не оплачен": "unpaid", "частично": "part", "оплачен": "paid", [ANNULLED]: "off" };
    const canAnnul = (i) => !i.act && !i.paid && (i.status === "не оплачен" || !i.status);
    const actions = (i) => {
      if (i.status === ANNULLED) return "";
      const b = [];
      if (!i.act) b.push(`<button class="btn small" data-act="${i.number}">✅ Сделать акт</button>`);
      if (i.act) b.push(`<button class="btn small danger" data-annul="act" data-n="${i.act}" data-inv="${i.number}">Аннулировать акт № ${i.act}</button>`);
      else if (canAnnul(i)) b.push(`<button class="btn small danger" data-annul="invoice" data-n="${i.number}">Аннулировать</button>`);
      return b.length ? `<div class="actions">${b.join("")}</div>` : "";
    };
    const render = () => {
      const rows = S.invoices.filter((i) => filter === "all" || (i.status !== "оплачен" && i.status !== ANNULLED));
      root.innerHTML = `
        <h1>${S.boot.user.sees_all ? "Все счета" : "Мои счета"}</h1>
        <div class="tabs"><button id="f-unpaid" aria-pressed="${filter === "unpaid"}">Не оплачены</button><button id="f-all" aria-pressed="${filter === "all"}">Все</button></div>
        ${rows.length ? "" : `<div class="note">${filter === "unpaid" ? "Неоплаченных счетов нет." : "Счетов пока нет."}</div>`}
        ${rows.map((i) => `<div class="card ${i.status === ANNULLED ? "off" : ""}">
          <div class="top"><span>Счёт № ${i.number}</span><span>${esc(i.total)}</span></div>
          <div class="sub">${esc(i.date)} · ${esc(i.customer)}</div>
          <div class="sub">${esc(i.car)} · ${esc(i.from)} → ${esc(i.to)}</div>
          <div><span class="chip ${cls[i.status] || "unpaid"}">${esc(i.status)}</span> ${i.act ? `<span class="hint">· акт № ${i.act}</span>` : ""}
            ${S.boot.user.sees_all ? `<span class="hint">· ${esc(i.created_by)}</span>` : ""}</div>
          ${actions(i)}
        </div>`).join("")}
        <p class="hint">Статус оплаты отмечается в Google Таблице. Ошибочный счёт или акт можно аннулировать: номер останется занятым, в долги и выгрузку 1С документ не попадёт.</p>`;
      $("f-unpaid").onclick = () => { filter = "unpaid"; render(); };
      $("f-all").onclick = () => { filter = "all"; render(); };
      root.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => { S.actPick = Number(b.dataset.act); go("act"); }));
      root.querySelectorAll("[data-annul]").forEach((b) => (b.onclick = () => {
        S.annul = { kind: b.dataset.annul, number: Number(b.dataset.n), inv: Number(b.dataset.inv) || null };
        go("annul");
      }));
    };
    render();
    setBack(() => go("invoice"));
  }

  // ---------------------------------------------------------------- аннулирование
  function annulPage() {
    const a = S.annul;
    if (!a) { go("list"); return; }
    const inv = S.invoices && S.invoices.find((i) => (a.kind === "act" ? i.number === a.inv : i.number === a.number));
    const what = a.kind === "act" ? `акт № ${a.number}` : `счёт № ${a.number}`;
    root.innerHTML = `
      <h1>Аннулировать ${esc(what)}</h1>
      <div id="err" class="note err" hidden></div>
      ${inv ? `<div class="card"><div class="top"><span>${a.kind === "act" ? `Акт № ${a.number} по счёту № ${inv.number}` : `Счёт № ${inv.number}`}</span><span>${esc(inv.total)}</span></div>
        <div class="sub">${esc(inv.date)} · ${esc(inv.customer)}</div><div class="sub">${esc(inv.car)} · ${esc(inv.from)} → ${esc(inv.to)}</div></div>` : ""}
      <div class="note warn">Номер останется занятым, в таблице документ будет отмечен «аннулирован». В долги и выгрузку 1С он не попадёт. Отменить это можно только в таблице.
        ${a.kind === "act" ? "<br><br>После этого по счёту можно будет сделать новый акт." : "<br><br>Если нужен правильный счёт, создайте новый."}</div>
      <div class="field"><label for="reason">Причина</label><textarea id="reason" rows="3" maxlength="200" placeholder="Например: ошибка в сумме, заказчик отказался">${esc(a.reason)}</textarea></div>`;
    setBack(() => { a.reason = val("reason"); go("list"); });
    setMain(`Аннулировать ${what}`, async () => {
      a.reason = val("reason");
      if (a.reason.length < 3) { markErr(["reason"]); showError("Напишите причину"); return; }
      busy(true);
      try {
        const r = await api("/api/annul", { kind: a.kind, number: a.number, reason: a.reason });
        S.annul = null; S.invoices = null;
        done(`${a.kind === "act" ? "Акт" : "Счёт"} № ${r.number} аннулирован`,
          a.kind === "act" ? "По счёту можно сделать новый акт." : "В таблице он отмечен как аннулированный.");
      } catch (e) { showError(e.message); } finally { busy(false); }
    });
  }

  // ---------------------------------------------------------------- роутинг
  async function route() {
    const page = (location.hash || "#invoice").slice(1);
    try {
      if (!S.boot) S.boot = await api("/api/bootstrap");
      if (page === "act") await actPage();
      else if (page === "list") await listPage();
      else if (page === "customer") customerPage();
      else if (page === "annul") annulPage();
      else invoicePage();
    } catch (e) {
      setMain(null);
      root.innerHTML = `<div class="note err">${esc(e.message)}</div>
        ${inTelegram ? "" : `<p class="hint">Закройте это окно и откройте форму кнопкой под сообщением бота или кнопкой «Документы» слева от поля ввода. Если кнопок нет, отправьте боту /start.</p>`}`;
    }
  }
  route();
})();
