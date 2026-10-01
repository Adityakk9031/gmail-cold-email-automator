// Cold Email Automator - Content Script v1.4
// Injected into Gmail (mail.google.com) and Zoho Mail (mail.zoho.*)

(() => {
  // ── De-register any OLD message listener from previous script version ──
  // We do this by storing the handler on window so we can remove it.
  if (window.__COLD_MAILER_LISTENER__) {
    chrome.runtime.onMessage.removeListener(window.__COLD_MAILER_LISTENER__);
  }

  const isZoho = /zoho\.(com|in|eu|com\.au|jp|ca|sa|com\.cn)/i.test(window.location.hostname);
  const serviceLabel = isZoho ? "Zoho Mail" : "Gmail";

  // ─────────────────────────────────────────
  //  Native Sleep Timer
  // ─────────────────────────────────────────
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Poll until fn() returns truthy, up to `timeout` ms
  function waitFor(fn, timeout = 10000) {
    return new Promise(resolve => {
      const start = Date.now();
      const tick = setInterval(() => {
        const v = fn();
        if (v) { clearInterval(tick); resolve(v); return; }
        if (Date.now() - start > timeout) { clearInterval(tick); resolve(null); }
      }, 150);
    });
  }

  // ─────────────────────────────────────────
  //  Campaign State
  // ─────────────────────────────────────────
  let queue        = [];
  let currentIndex = 0;
  let isRunning    = false;
  let isPaused     = false;
  let isStopped    = false;
  let config       = null;

  // ─────────────────────────────────────────
  //  Name extractor from email address
  // ─────────────────────────────────────────
  function extractName(email) {
    if (!email || typeof email !== "string") return "Hiring Manager";
    const user = email.split("@")[0].toLowerCase().trim();
    const generic = [
      "hr","careers","jobs","recruiting","recruitment","talent","info",
      "contact","support","hiring","admin","hello","team","people","apply",
      "noreply","no-reply","mail","enquiries","office"
    ];
    if (generic.includes(user)) return "Hiring Team";
    const parts = user.split(/[._\-\d]+/).filter(p => p.length >= 2);
    if (parts.length > 0) {
      const first = parts[0];
      return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
    }
    return "Hiring Manager";
  }

  // ─────────────────────────────────────────
  //  Check Pause / Stop Helper
  // ─────────────────────────────────────────
  async function checkPauseAndStop() {
    if (isStopped) throw new Error("Stopped by user");
    while (isPaused && !isStopped) {
      setStatus("⏸ Campaign Paused — click ▶ Resume to continue.");
      await sleep(350);
    }
    if (isStopped) throw new Error("Stopped by user");
  }

  // ─────────────────────────────────────────
  //  Subject Template Engine
  //  ONLY replaces explicit {name}, [name],
  //  {company}, {role}. NEVER prepends greeting!
  // ─────────────────────────────────────────
  function renderSubject(tpl, recipient) {
    if (!tpl || typeof tpl !== "string") return "";

    const email = (recipient && recipient.email) ? recipient.email : "";
    let name = (recipient && recipient.name && recipient.name !== "Hiring Manager" && recipient.name !== "Hiring Team")
      ? recipient.name
      : extractName(email);

    if (!name || name.trim() === "") name = extractName(email);
    const company = (recipient && recipient.company && recipient.company !== "your company")
      ? recipient.company : "your company";
    const role = (recipient && recipient.role && recipient.role !== "Software Engineer")
      ? recipient.role : "Software Engineer";

    return tpl
      .replace(/\{name\}/gi, name)
      .replace(/\[name\]/gi, name)
      .replace(/\<name\>/gi, name)
      .replace(/\{first_name\}/gi, name)
      .replace(/\[first_name\]/gi, name)
      .replace(/\{company\}/gi, company)
      .replace(/\[company\]/gi, company)
      .replace(/\{role\}/gi, role)
      .replace(/\[role\]/gi, role);
  }

  // ─────────────────────────────────────────
  //  Body Template Engine
  //  Replaces {name}, [name], Hi Name, Hi name,
  //  and prepends greeting ONLY to the body!
  // ─────────────────────────────────────────
  function renderBody(tpl, recipient) {
    if (!tpl || typeof tpl !== "string") return "";

    const email = (recipient && recipient.email) ? recipient.email : "";
    let name = (recipient && recipient.name && recipient.name !== "Hiring Manager" && recipient.name !== "Hiring Team")
      ? recipient.name
      : extractName(email);

    if (!name || name.trim() === "") name = extractName(email);
    const company = (recipient && recipient.company && recipient.company !== "your company")
      ? recipient.company : "your company";
    const role = (recipient && recipient.role && recipient.role !== "Software Engineer")
      ? recipient.role : "Software Engineer";

    let text = tpl;

    // 1. Replace bracketed tags {name}, [name], <name>, {company}, {role}
    text = text
      .replace(/\{name\}/gi, name)
      .replace(/\[name\]/gi, name)
      .replace(/\<name\>/gi, name)
      .replace(/\{first_name\}/gi, name)
      .replace(/\[first_name\]/gi, name)
      .replace(/\{company\}/gi, company)
      .replace(/\[company\]/gi, company)
      .replace(/\{role\}/gi, role)
      .replace(/\[role\]/gi, role);

    // 2. Replace opening greetings:
    // e.g. "Hi Name,", "Hi name,", "hi name,", "Dear Name,", "Hello Name,", "Hey Name,"
    const openingGreetingRegex = /^(\s*(?:Hi|Hello|Hey|Dear)\s+)([A-Za-z0-9_\-\{\}\[\]<>]+)(\s*[,!:]?)/i;
    if (openingGreetingRegex.test(text)) {
      text = text.replace(openingGreetingRegex, (match, greetingWord, oldPlaceholder, punctuation) => {
        return `${greetingWord}${name}${punctuation || ","}`;
      });
    } else if (/^\s*(Hi|Hello|Hey|Dear)\s*[,!:]/i.test(text)) {
      text = text.replace(/^(\s*(?:Hi|Hello|Hey|Dear))\s*([,!:]?)/i, `$1 ${name}$2`);
    } else {
      // If text does not start with a greeting and does not mention the name:
      if (!text.toLowerCase().includes(name.toLowerCase())) {
        text = `Hi ${name},\n\n${text.trimStart()}`;
      }
    }

    // 3. Replace any stray "Hi Name" or "Dear Name" anywhere inside the text
    text = text.replace(/\b(Hi|Hello|Hey|Dear)\s+Name\b/gi, `$1 ${name}`);
    text = text.replace(/\b(Hi|Hello|Hey|Dear)\s+name\b/gi, `$1 ${name}`);

    return text;
  }

  // ─────────────────────────────────────────
  //  Message listener
  // ─────────────────────────────────────────
  const messageHandler = (request, sender, sendResponse) => {
    if (request.action === "PING") {
      sendResponse({ status: "PONG" });
      return true;
    }

    if (request.action !== "START_CAMPAIGN") return;

    if (isRunning) {
      sendResponse({ status: "ERROR", message: "Campaign already running." });
      return true;
    }

    config       = request;
    queue        = request.recipients || [];
    currentIndex = 0;
    isRunning    = true;
    isPaused     = false;
    isStopped    = false;

    buildHud();
    refreshProgress();
    runLoop();

    sendResponse({ status: "STARTED", count: queue.length });
    return true;
  };

  // Store on window so we can remove it on next injection
  window.__COLD_MAILER_LISTENER__ = messageHandler;
  chrome.runtime.onMessage.addListener(messageHandler);

  // ─────────────────────────────────────────
  //  Main Campaign Loop
  // ─────────────────────────────────────────
  async function runLoop() {
    while (currentIndex < queue.length && !isStopped) {
      if (isPaused) {
        setStatus("⏸ Paused — click Resume.");
        await sleep(800);
        continue;
      }

      const item = queue[currentIndex];
      setTarget(item.email);

      try {
        setStatus(`📨 Sending #${currentIndex + 1} of ${queue.length}…`);
        await sendEmail(item);
        currentIndex++;
        refreshProgress();

        if (currentIndex < queue.length && !isStopped) {
          let delay = config.delaySeconds || 30;
          if (config.addJitter) delay = Math.max(15, delay + Math.floor(Math.random() * 9) - 4);
          setStatus(`✓ Sent to ${item.email}! Waiting ${delay}s…`);
          await countdown(delay);
        } else {
          setStatus(`🎉 Done! All ${queue.length} emails sent.`);
          isRunning = false;
          showDoneBtn();
        }
      } catch (err) {
        console.error("[ColdMailer] Error:", err);
        setStatus(`⚠ Failed: ${err.message} — skipping in 8s…`);
        await sleep(8000);
        currentIndex++;
        refreshProgress();
      }
    }
    if (isStopped) { setStatus("⏹ Stopped."); isRunning = false; }
  }

  // ─────────────────────────────────────────
  //  Core: Compose + Fill + Send
  // ─────────────────────────────────────────
  async function sendEmail(recipient) {

    // ── 0. Close any stale compose windows ──
    await checkPauseAndStop();
    if (!isZoho) {
      document.querySelectorAll('div[role="dialog"]').forEach(d => {
        if (d.querySelector('input[name="subjectbox"]')) {
          const btn = d.querySelector('[aria-label*="Discard" i],[data-tooltip*="Discard" i]');
          if (btn) btn.click();
        }
      });
    } else {
      // In Zoho Mail, close existing compose tabs if discard button is available
      document.querySelectorAll('.zmMailComposeTab .zmCloseIcon, [data-action="close-compose"]').forEach(b => {
        try { b.click(); } catch (_) {}
      });
    }
    await sleep(300);
    await checkPauseAndStop();

    // ── 1. Click Compose / New Mail ──
    setStatus("Opening compose…");
    const composeBtn = await waitFor(findComposeBtn, 6000);
    if (composeBtn) {
      composeBtn.click();
    } else if (isZoho) {
      // Shortcut fallback for Zoho Mail: 'c'
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", keyCode: 67, which: 67, bubbles: true }));
    } else {
      throw new Error(`Compose button not found — is ${serviceLabel} fully loaded?`);
    }
    await checkPauseAndStop();

    // ── 2. Wait for To field (proves compose form is ready) ──
    setStatus("Waiting for compose form…");
    const toInput = await waitFor(findToInput, 12000);
    if (!toInput) throw new Error(`'To' field never appeared — refresh ${serviceLabel} and try again.`);
    await sleep(250);
    await checkPauseAndStop();

    // ── 3. Type recipient email char-by-char and commit chip ──
    setStatus(`Adding: ${recipient.email}…`);
    toInput.focus();
    toInput.click();
    await sleep(100);
    toInput.value = "";
    toInput.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(60);

    for (const ch of recipient.email) {
      await checkPauseAndStop();
      toInput.value += ch;
      toInput.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
      await sleep(22);
    }
    await sleep(280);
    await checkPauseAndStop();

    // Commit chip in Gmail & Zoho Mail: Enter, comma, Tab
    toInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, which: 13, bubbles: true }));
    toInput.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", keyCode: 13, which: 13, bubbles: true }));
    await sleep(120);
    toInput.dispatchEvent(new KeyboardEvent("keydown", { key: ",", keyCode: 188, which: 188, bubbles: true }));
    toInput.dispatchEvent(new KeyboardEvent("keyup",   { key: ",", keyCode: 188, which: 188, bubbles: true }));
    await sleep(120);
    toInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", keyCode: 9, which: 9, bubbles: true }));
    toInput.dispatchEvent(new KeyboardEvent("keyup",   { key: "Tab", keyCode: 9, which: 9, bubbles: true }));
    await sleep(450);
    await checkPauseAndStop();

    // ── 4. Subject (Never prepends greeting!) ──
    setStatus("Filling subject…");
    const subjectEl = await waitFor(findSubjectInput, 5000);

    if (subjectEl) {
      const subjectText = renderSubject(config.subjectTemplate, recipient);
      subjectEl.focus();
      subjectEl.click();
      subjectEl.value = subjectText;
      subjectEl.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: subjectText }));
      subjectEl.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(220);
    }
    await checkPauseAndStop();

    // ── 5. Body (Personalized with greeting) ──
    setStatus("Writing personalized body…");
    const bodyTarget = await waitFor(findBodyTarget, 8000);
    if (!bodyTarget) throw new Error("Email body area not found.");

    const { el: bodyEl, doc: targetDoc, isTextarea } = bodyTarget;
    const bodyText = renderBody(config.bodyTemplate, recipient);
    const resolvedName = (recipient && recipient.name && recipient.name !== "Hiring Manager" && recipient.name !== "Hiring Team")
      ? recipient.name
      : extractName(recipient.email);

    setStatus(`Writing body for ${recipient.email}…`);
    bodyEl.focus();
    if (typeof bodyEl.click === "function") bodyEl.click();
    await sleep(180);

    if (isTextarea) {
      bodyEl.value = bodyText;
      bodyEl.dispatchEvent(new Event("input", { bubbles: true }));
      bodyEl.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // Clear existing content (pre-filled signature or drafts)
      try {
        targetDoc.execCommand("selectAll", false, null);
        targetDoc.execCommand("delete", false, null);
      } catch (_) {}
      await sleep(80);

      const formattedHtml = bodyText
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");

      let writtenViaExec = false;
      try {
        writtenViaExec = targetDoc.execCommand("insertHTML", false, formattedHtml);
      } catch (_) {}

      if (!writtenViaExec || !bodyEl.innerHTML || bodyEl.innerHTML.trim() === "") {
        bodyEl.innerHTML = formattedHtml;
      }

      bodyEl.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      bodyEl.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(250);

      // Post-write safety check: ensure no stray placeholders remain
      if (bodyEl.innerHTML.toLowerCase().includes("{name}") || 
          bodyEl.innerHTML.toLowerCase().includes("[name]") || 
          /\b(Hi|Hello|Hey|Dear)\s+Name\b/i.test(bodyEl.innerHTML)) {
        console.warn("[ColdMailer] Stray placeholder still found after write — forcing replacement");
        bodyEl.innerHTML = bodyEl.innerHTML
          .replace(/\{name\}/gi,    resolvedName)
          .replace(/\[name\]/gi,    resolvedName)
          .replace(/\b(Hi|Hello|Hey|Dear)\s+Name\b/gi, `$1 ${resolvedName}`)
          .replace(/\b(Hi|Hello|Hey|Dear)\s+name\b/gi, `$1 ${resolvedName}`)
          .replace(/\{company\}/gi, recipient.company || "your company")
          .replace(/\{role\}/gi,    recipient.role    || "Software Engineer");
      }
    }
    await sleep(100);
    await checkPauseAndStop();

    // ── 6. Attach Resume ──
    if (config.resume && config.resume.base64) {
      setStatus(`Attaching ${config.resume.name}…`);
      await sleep(400);
      await attachFile(config.resume, bodyTarget);
      await sleep(3500);
    }
    await checkPauseAndStop();

    // ── 7. Send ──
    setStatus(`Sending to ${recipient.email}…`);
    await hitSend(bodyTarget);
    await sleep(1500);
  }

  // ─────────────────────────────────────────
  //  Helpers: Compose Button
  // ─────────────────────────────────────────
  function findComposeBtn() {
    // 1. Gmail selectors
    for (const sel of [
      'div[role="button"][gh="cm"]',
      'div[gh="cm"]',
      '[data-tooltip*="Compose" i]',
      '[aria-label*="Compose" i]',
      '.T-I.T-I-KE.L3',
    ]) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    }

    // 2. Zoho Mail selectors
    for (const sel of [
      'button.zmNewMail',
      '.zmNewMail',
      '[data-action="new-mail"]',
      '[data-action="compose"]',
      '[data-action*="compose" i]',
      '[aria-label*="New Mail" i]',
      '[title*="New Mail" i]',
      '[data-test-id*="new-mail" i]',
      '.zm-new-mail',
      '.new-mail'
    ]) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    }

    // 3. Text search for "New Mail" / "Compose" buttons
    for (const el of Array.from(document.querySelectorAll('button, a, div[role="button"]'))) {
      const txt = el.textContent?.trim().toLowerCase();
      if ((txt === "new mail" || txt === "+ new mail" || txt === "compose") && el.offsetParent !== null) {
        return el;
      }
    }

    return null;
  }

  // ─────────────────────────────────────────
  //  Helpers: To Input
  // ─────────────────────────────────────────
  function findToInput() {
    // Gmail selectors
    for (const sel of [
      'input[aria-label="To"]',
      'input[aria-label="To recipients"]',
      'div[aria-label="To"] input',
      'input[peoplekit-id]',
      'textarea[aria-label="To"]',
    ]) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    }

    // Zoho Mail selectors
    for (const sel of [
      'input[placeholder*="To" i]',
      'input[aria-label*="To" i]',
      'input[data-placeholder*="To" i]',
      'textarea[placeholder*="To" i]',
      'input[name="to"]',
      'input[name*="to" i]',
      '.zmContactSuggest',
      '.zmContactInput',
      '.zm-compose-to input',
      '.zmc-input input',
      'div[class*="to" i] input',
      'div[class*="recipient" i] input',
      'div[class*="address" i] input'
    ]) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    }

    // Contextual search within active compose container
    const composeContainers = document.querySelectorAll(
      'div[id*="compose" i], div[class*="compose" i], div[data-view*="compose" i], .zmComposeView, div[role="dialog"]'
    );
    for (const container of composeContainers) {
      if (container.offsetParent === null) continue;
      const inputs = Array.from(container.querySelectorAll('input[type="text"], input:not([type]), textarea'));
      for (const inp of inputs) {
        const p = (inp.placeholder || inp.getAttribute("aria-label") || inp.getAttribute("data-placeholder") || "").toLowerCase();
        if (p.includes("to") || p.includes("recipient") || p.includes("contact")) {
          return inp;
        }
      }
    }

    return null;
  }

  // ─────────────────────────────────────────
  //  Helpers: Subject Input
  // ─────────────────────────────────────────
  function findSubjectInput() {
    for (const sel of [
      'input[name="subjectbox"]',
      'input[name="subject"]',
      'input[name*="subject" i]',
      'input[placeholder*="Subject" i]',
      'input[aria-label*="Subject" i]',
      'input[data-placeholder*="Subject" i]',
      '.zmSubject input',
      '.zm_subject input',
      'input.zmSubject',
      '.zm-compose-subject input'
    ]) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    }

    // Contextual fallback within compose container
    const composeContainers = document.querySelectorAll(
      'div[id*="compose" i], div[class*="compose" i], div[data-view*="compose" i], .zmComposeView, div[role="dialog"]'
    );
    for (const container of composeContainers) {
      if (container.offsetParent === null) continue;
      const inputs = Array.from(container.querySelectorAll('input[type="text"], input:not([type])'));
      for (const inp of inputs) {
        const p = (inp.placeholder || inp.getAttribute("aria-label") || inp.getAttribute("data-placeholder") || inp.name || "").toLowerCase();
        if (p.includes("subject")) return inp;
      }
    }
    return null;
  }

  // ─────────────────────────────────────────
  //  Helpers: Body Target (Gmail + Zoho Mail iframe/div/textarea)
  // ─────────────────────────────────────────
  function findBodyTarget() {
    // 1. Gmail body selectors
    const gmailBody = document.querySelector('div[aria-label="Message Body"]') ||
                      document.querySelector('div[g_editable="true"][role="textbox"]') ||
                      document.querySelector('div[contenteditable="true"][aria-multiline="true"]');
    if (gmailBody && gmailBody.offsetParent !== null) {
      return { el: gmailBody, doc: document, isIframe: false, isTextarea: false };
    }

    // 2. Zoho Mail rich text iframe
    const iframes = Array.from(document.querySelectorAll("iframe"));
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc) continue;
        const editable = doc.querySelector('div[contenteditable="true"]') ||
                         (doc.body && (doc.body.isContentEditable || doc.body.getAttribute("contenteditable") === "true" || doc.designMode === "on") ? doc.body : null) ||
                         doc.querySelector('[contenteditable="true"]') ||
                         (iframe.classList.contains("zmComposeEditor") || iframe.id.includes("compose") ? doc.body : null);
        if (editable) {
          return { el: editable, doc, isIframe: true, isTextarea: false };
        }
      } catch (e) {
        // Cross-origin iframe
      }
    }

    // 3. Direct contenteditable (Zoho Mail / Generic)
    const directSelectors = [
      '.zme-editor-content',
      'div[contenteditable="true"].zmComposeEditor',
      'div[contenteditable="true"][id*="editor" i]',
      'div[contenteditable="true"][class*="editor" i]',
      'div[contenteditable="true"][data-placeholder*="Message" i]',
      'div[contenteditable="true"][aria-label*="Message" i]'
    ];
    for (const sel of directSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        return { el, doc: document, isIframe: false, isTextarea: false };
      }
    }

    // Any visible contenteditable element that is not inside our HUD
    const allContentEditable = Array.from(document.querySelectorAll('div[contenteditable="true"]'));
    const candidate = allContentEditable.find(d => d.offsetParent !== null && !d.closest('#cold-mailer-hud'));
    if (candidate) {
      return { el: candidate, doc: document, isIframe: false, isTextarea: false };
    }

    // 4. Plain-text textarea
    const textareas = [
      'textarea.zm-plain-editor',
      'textarea[name*="content" i]',
      'textarea[placeholder*="Message" i]',
      'textarea[aria-label*="Message" i]'
    ];
    for (const sel of textareas) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        return { el, doc: document, isIframe: false, isTextarea: true };
      }
    }

    return null;
  }

  // ─────────────────────────────────────────
  //  Helpers: Attach File
  // ─────────────────────────────────────────
  async function attachFile(resumeData, bodyTarget) {
    const file = b64ToFile(resumeData.base64, resumeData.name, resumeData.type);
    const dt = new DataTransfer();
    dt.items.add(file);

    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "files"
    )?.set;

    // Search file inputs in document and target iframe document (if any)
    const docs = [document];
    if (bodyTarget?.doc && bodyTarget.doc !== document) docs.push(bodyTarget.doc);

    let allInputs = [];
    for (const d of docs) {
      allInputs = allInputs.concat(Array.from(d.querySelectorAll('input[type="file"]')));
    }

    const primary = allInputs.find(el => el.name === "Filedata") ||
                    allInputs.find(el => !el.accept || el.accept === "*/*") ||
                    allInputs[0];

    // Method A: native setter
    if (primary && nativeSetter) {
      try {
        nativeSetter.call(primary, dt.files);
        primary.dispatchEvent(new Event("change", { bubbles: true }));
        primary.dispatchEvent(new Event("input",  { bubbles: true }));
        console.log("[ColdMailer] Attached via native setter ✓");
        return;
      } catch (e) { console.warn("[ColdMailer] Method A failed:", e); }
    }

    // Method B: click paperclip button
    const clipBtn = document.querySelector(
      '[data-tooltip*="Attach" i],[aria-label*="Attach files" i],[aria-label*="attach" i],[title*="Attach" i],.a1.aaA.aMZ,.zmAttach,.zm-attach-icon,button[data-action="attach"]'
    );
    if (clipBtn) {
      try {
        const intercepted = await new Promise(resolve => {
          const before = new Set(document.querySelectorAll('input[type="file"]'));
          const obs = new MutationObserver(() => {
            const cur = Array.from(document.querySelectorAll('input[type="file"]'));
            const newInp = cur.find(el => !before.has(el));
            if (newInp) { obs.disconnect(); resolve(newInp); }
          });
          obs.observe(document.body, { childList: true, subtree: true });
          clipBtn.click();
          setTimeout(() => { obs.disconnect(); resolve(null); }, 2000);
        });
        if (intercepted && nativeSetter) {
          nativeSetter.call(intercepted, dt.files);
          intercepted.dispatchEvent(new Event("change", { bubbles: true }));
          console.log("[ColdMailer] Attached via button intercept ✓");
          return;
        }
      } catch (e) { console.warn("[ColdMailer] Method B failed:", e); }
    }

    // Method C: drag-and-drop fallback
    try {
      const zone = bodyTarget?.el ||
                   document.querySelector('div[aria-label="Message Body"]') ||
                   document.querySelector('div[role="dialog"]') ||
                   document.querySelector('.zmComposeView') ||
                   document.body;
      zone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
      await sleep(80);
      zone.dispatchEvent(new DragEvent("dragover",  { bubbles: true, cancelable: true, dataTransfer: dt }));
      await sleep(80);
      zone.dispatchEvent(new DragEvent("drop",      { bubbles: true, cancelable: true, dataTransfer: dt }));
      console.log("[ColdMailer] Attached via drag-drop ✓");
    } catch (e) { console.warn("[ColdMailer] All attach methods failed:", e); }
  }

  // ─────────────────────────────────────────
  //  Helpers: Hit Send
  // ─────────────────────────────────────────
  async function hitSend(bodyTarget) {
    for (const sel of [
      // Gmail
      'div[role="button"][data-tooltip*="Send" i]',
      'div[role="button"][aria-label*="Send" i]',
      'button[aria-label*="Send" i]',
      '.T-I.J-J5-Ji.aoO',
      // Zoho Mail
      'button[data-action="send"]',
      'button[data-action="mail-send"]',
      'button.zmSend',
      '.zm-send-btn',
      '.btnSend',
      '[title*="Send" i][class*="btn" i]',
      '[aria-label*="Send" i][class*="btn" i]'
    ]) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { el.click(); return; }
    }

    // Also look for buttons with text "Send"
    for (const btn of Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]'))) {
      const txt = btn.textContent?.trim().toLowerCase();
      if ((txt === "send" || txt === "send mail" || txt === "send now") && btn.offsetParent !== null) {
        if (!btn.closest('#cold-mailer-hud')) {
          btn.click();
          return;
        }
      }
    }

    // Universal Fallback: Ctrl+Enter (Works in Gmail and Zoho Mail!)
    const target = bodyTarget?.el || document.querySelector('div[aria-label="Message Body"]') || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown",  { key: "Enter", keyCode: 13, which: 13, ctrlKey: true, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", keyCode: 13, which: 13, ctrlKey: true, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup",    { key: "Enter", keyCode: 13, which: 13, ctrlKey: true, bubbles: true }));
  }

  function b64ToFile(dataUrl, name, type) {
    const [, data] = dataUrl.split(",");
    const bytes = atob(data);
    const buf = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    return new File([buf], name, { type });
  }

  // ─────────────────────────────────────────
  //  HUD
  // ─────────────────────────────────────────
  function buildHud() {
    document.getElementById("cold-mailer-hud")?.remove();
    const hud = document.createElement("div");
    hud.id = "cold-mailer-hud";
    hud.innerHTML = `
      <div class="cm-hud-header">
        <div class="cm-hud-title">🚀 Cold Mailer (${serviceLabel})</div>
        <div class="cm-hud-controls">
          <button id="cm-min"   class="cm-hud-btn-icon" title="Minimise">─</button>
          <button id="cm-close" class="cm-hud-btn-icon" title="Close">✕</button>
        </div>
      </div>
      <div class="cm-hud-body">
        <div class="cm-hud-row">
          <span class="cm-hud-label">Progress</span>
          <span id="cm-count" class="cm-hud-value">0 / 0</span>
        </div>
        <div class="cm-hud-progress-bar"><div id="cm-fill" class="cm-hud-progress-fill"></div></div>
        <div class="cm-hud-row" style="margin-top:4px">
          <span class="cm-hud-label">Current</span>
          <span id="cm-target" class="cm-hud-value" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</span>
        </div>
        <div id="cm-name-badge" class="cm-hud-status-line" style="color:#38bdf8;font-weight:700;display:none"></div>
        <div id="cm-countdown" class="cm-hud-countdown hidden"></div>
        <div id="cm-status" class="cm-hud-status-line">Starting…</div>
        <div class="cm-hud-actions">
          <button id="cm-pause" class="cm-hud-btn cm-hud-btn-pause">⏸ Pause</button>
          <button id="cm-stop"  class="cm-hud-btn cm-hud-btn-stop">⏹ Stop</button>
        </div>
      </div>`;
    document.body.appendChild(hud);

    // Drag to move HUD
    let ox = 0, oy = 0, dragging = false;
    hud.querySelector(".cm-hud-header").addEventListener("mousedown", e => {
      dragging = true;
      ox = e.clientX - hud.offsetLeft;
      oy = e.clientY - hud.offsetTop;
    });
    document.addEventListener("mousemove", e => {
      if (!dragging) return;
      hud.style.left = `${e.clientX - ox}px`;
      hud.style.top  = `${e.clientY - oy}px`;
      hud.style.right = "auto";
      hud.style.bottom = "auto";
    });
    document.addEventListener("mouseup", () => { dragging = false; });

    document.getElementById("cm-min").onclick   = () => hud.classList.toggle("minimized");
    document.getElementById("cm-close").onclick = () => {
      if (!isRunning || confirm("Stop campaign and close?")) {
        isStopped = true; isRunning = false; hud.remove();
      }
    };

    const pauseBtn = document.getElementById("cm-pause");
    pauseBtn.onclick = () => {
      isPaused = !isPaused;
      pauseBtn.textContent = isPaused ? "▶ Resume" : "⏸ Pause";
      pauseBtn.className   = isPaused ? "cm-hud-btn cm-hud-btn-resume" : "cm-hud-btn cm-hud-btn-pause";
      if (isPaused) {
        setStatus("⏸ Campaign Paused — click ▶ Resume to continue.");
        const cd = document.getElementById("cm-countdown");
        if (cd && !cd.classList.contains("hidden")) cd.textContent = "⏸ Paused";
      } else {
        setStatus("▶ Resuming campaign…");
      }
    };
    document.getElementById("cm-stop").onclick = () => {
      isStopped = true;
      isPaused = false;
      setStatus("⏹ Stopping campaign…");
    };
  }

  function refreshProgress() {
    const total = queue.length;
    const el = document.getElementById("cm-count");
    if (el) el.textContent = `${currentIndex} / ${total}`;
    const fill = document.getElementById("cm-fill");
    if (fill && total) fill.style.width = `${Math.round(currentIndex / total * 100)}%`;
  }

  function setTarget(email) {
    const el = document.getElementById("cm-target");
    if (el) el.textContent = email;

    // Show extracted name in HUD so user can verify
    const name = extractName(email);
    const badge = document.getElementById("cm-name-badge");
    if (badge) {
      badge.textContent = `{name} → "${name}"`;
      badge.style.display = "block";
    }
  }

  function setStatus(msg) {
    const el = document.getElementById("cm-status");
    if (el) el.textContent = msg;
  }

  async function countdown(secs) {
    const el = document.getElementById("cm-countdown");
    if (el) el.classList.remove("hidden");
    for (let s = secs; s > 0; s--) {
      if (isStopped) break;
      while (isPaused && !isStopped) {
        setStatus("⏸ Campaign Paused — click ▶ Resume to continue.");
        if (el) el.textContent = `⏸ Paused (${s}s remaining)`;
        await sleep(400);
      }
      if (isStopped) break;
      if (el) el.textContent = `⏱ Next send in ${s}s`;
      await sleep(1000);
    }
    if (el) el.classList.add("hidden");
  }

  function showDoneBtn() {
    const el = document.querySelector(".cm-hud-actions");
    if (el) el.innerHTML = `<button class="cm-hud-btn cm-hud-btn-resume" style="width:100%;margin:0"
      onclick="document.getElementById('cold-mailer-hud').remove()">✓ Done — Close HUD</button>`;
  }

  console.log("[ColdMailer] v1.3 loaded — listener registered.");
})();
