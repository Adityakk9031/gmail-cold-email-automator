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
  //  Core Router: Send Email
  // ─────────────────────────────────────────
  async function sendEmail(recipient) {
    if (isZoho) {
      await sendZoho(recipient);
    } else {
      await sendGmail(recipient);
    }
  }

  // =========================================================================
  //  GMAIL ENGINE (Dedicated DOM Driver for Gmail)
  // =========================================================================

  async function sendGmail(recipient) {
    // 0. Close any stale compose windows
    await checkPauseAndStop();
    document.querySelectorAll('div[role="dialog"]').forEach(d => {
      if (d.querySelector('input[name="subjectbox"]')) {
        const btn = d.querySelector('[aria-label*="Discard" i],[data-tooltip*="Discard" i]');
        if (btn) btn.click();
      }
    });
    await sleep(300);
    await checkPauseAndStop();

    // 1. Click Compose button
    setStatus("Opening Gmail compose…");
    const composeBtn = await waitFor(findGmailComposeBtn, 6000);
    if (!composeBtn) throw new Error("Gmail Compose button not found — is Gmail fully loaded?");
    composeBtn.click();
    await checkPauseAndStop();

    // 2. Wait for To field
    setStatus("Waiting for Gmail compose form…");
    const toInput = await waitFor(findGmailToInput, 12000);
    if (!toInput) throw new Error("Gmail 'To' field never appeared — please refresh Gmail and try again.");
    await sleep(250);
    await checkPauseAndStop();

    // 3. Type recipient email char-by-char (Gmail chip engine)
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

    // Tab commits email chip in Gmail
    toInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", keyCode: 9, bubbles: true }));
    toInput.dispatchEvent(new KeyboardEvent("keyup",   { key: "Tab", keyCode: 9, bubbles: true }));
    await sleep(450);
    await checkPauseAndStop();

    // 4. Subject
    setStatus("Filling subject…");
    const subjectEl = await waitFor(findGmailSubjectInput, 5000);
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

    // 5. Body
    setStatus("Writing personalized body…");
    const bodyEl = await waitFor(findGmailBodyTarget, 8000);
    if (!bodyEl) throw new Error("Gmail message body area not found.");

    const bodyText = renderBody(config.bodyTemplate, recipient);
    const resolvedName = (recipient && recipient.name && recipient.name !== "Hiring Manager" && recipient.name !== "Hiring Team")
      ? recipient.name
      : extractName(recipient.email);

    setStatus(`Writing body for ${recipient.email}…`);
    bodyEl.focus();
    bodyEl.click();
    await sleep(180);

    try {
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    } catch (_) {}
    await sleep(80);

    bodyEl.innerHTML = bodyText
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");

    bodyEl.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    bodyEl.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(300);

    // Stray placeholder check
    if (bodyEl.innerHTML.toLowerCase().includes("{name}") || 
        bodyEl.innerHTML.toLowerCase().includes("[name]") || 
        /\b(Hi|Hello|Hey|Dear)\s+Name\b/i.test(bodyEl.innerHTML)) {
      bodyEl.innerHTML = bodyEl.innerHTML
        .replace(/\{name\}/gi,    resolvedName)
        .replace(/\[name\]/gi,    resolvedName)
        .replace(/\b(Hi|Hello|Hey|Dear)\s+Name\b/gi, `$1 ${resolvedName}`)
        .replace(/\b(Hi|Hello|Hey|Dear)\s+name\b/gi, `$1 ${resolvedName}`)
        .replace(/\{company\}/gi, recipient.company || "your company")
        .replace(/\{role\}/gi,    recipient.role    || "Software Engineer");
    }
    await sleep(100);
    await checkPauseAndStop();

    // 6. Attach Resume
    if (config.resume && config.resume.base64) {
      setStatus(`Attaching ${config.resume.name}…`);
      await sleep(400);
      await attachGmailFile(config.resume);
      await sleep(3500);
    }
    await checkPauseAndStop();

    // 7. Send
    setStatus(`Sending to ${recipient.email}…`);
    await hitGmailSend();
    await sleep(1500);
  }

  function findGmailComposeBtn() {
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
    return null;
  }

  function findGmailToInput() {
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
    return null;
  }

  function findGmailSubjectInput() {
    return document.querySelector('input[name="subjectbox"]') ||
           document.querySelector('input[aria-label*="Subject" i]');
  }

  function findGmailBodyTarget() {
    return document.querySelector('div[aria-label="Message Body"]') ||
           document.querySelector('div[g_editable="true"][role="textbox"]') ||
           document.querySelector('div[contenteditable="true"][aria-multiline="true"]');
  }

  async function attachGmailFile(resumeData) {
    const file = b64ToFile(resumeData.base64, resumeData.name, resumeData.type);
    const dt = new DataTransfer();
    dt.items.add(file);

    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "files"
    )?.set;

    const allInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    const primary = allInputs.find(el => el.name === "Filedata") ||
                    allInputs.find(el => !el.accept || el.accept === "*/*") ||
                    allInputs[0];

    if (primary && nativeSetter) {
      try {
        nativeSetter.call(primary, dt.files);
        primary.dispatchEvent(new Event("change", { bubbles: true }));
        primary.dispatchEvent(new Event("input",  { bubbles: true }));
        console.log("[ColdMailer Gmail] Attached via native setter ✓");
        return;
      } catch (e) { console.warn("[ColdMailer Gmail] Method A failed:", e); }
    }

    const clipBtn = document.querySelector(
      '[data-tooltip*="Attach" i],[aria-label*="Attach files" i],[aria-label*="attach" i],.a1.aaA.aMZ'
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
          console.log("[ColdMailer Gmail] Attached via button intercept ✓");
          return;
        }
      } catch (e) { console.warn("[ColdMailer Gmail] Method B failed:", e); }
    }

    try {
      const zone = document.querySelector('div[aria-label="Message Body"]') ||
                   document.querySelector('div[role="dialog"]') ||
                   document.body;
      zone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
      await sleep(80);
      zone.dispatchEvent(new DragEvent("dragover",  { bubbles: true, cancelable: true, dataTransfer: dt }));
      await sleep(80);
      zone.dispatchEvent(new DragEvent("drop",      { bubbles: true, cancelable: true, dataTransfer: dt }));
      console.log("[ColdMailer Gmail] Attached via drag-drop ✓");
    } catch (e) { console.warn("[ColdMailer Gmail] All attach methods failed:", e); }
  }

  async function hitGmailSend() {
    for (const sel of [
      'div[role="button"][data-tooltip*="Send" i]',
      'div[role="button"][aria-label*="Send" i]',
      'button[aria-label*="Send" i]',
      '.T-I.J-J5-Ji.aoO',
    ]) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { el.click(); return; }
    }
    const target = document.querySelector('div[aria-label="Message Body"]') || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, ctrlKey: true, bubbles: true }));
  }

  // =========================================================================
  //  ZOHO MAIL ENGINE (Dedicated DOM Driver for Zoho Mail)
  // =========================================================================

  async function sendZoho(recipient) {
    await checkPauseAndStop();

    // ── Step 0: Always click "New Mail" first ──
    // We never try to reuse an existing compose form — always open fresh.
    // This avoids false-positive detection of Streams/Inbox panels.
    setStatus("Clicking Zoho 'New Mail'…");

    const newMailBtn = await waitFor(findZohoNewMailBtn, 6000);
    if (!newMailBtn) throw new Error("Zoho 'New Mail' button not found — is Zoho Mail fully loaded?");

    console.log("[ColdMailer Zoho] Found New Mail btn:", newMailBtn.textContent?.trim(), newMailBtn.tagName, newMailBtn.className);

    // Click "New Mail" with every event to make sure Zoho registers it
    newMailBtn.focus();
    newMailBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    newMailBtn.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true, cancelable: true, view: window }));
    newMailBtn.click();
    if (newMailBtn.firstElementChild) {
      try {
        newMailBtn.firstElementChild.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      } catch (_) {}
    }

    await checkPauseAndStop();

    // ── Step 1: Wait for compose tab to open (Subject input + To area) ──
    setStatus("Waiting for Zoho compose tab…");

    // Remember how many tabpanels exist before clicking New Mail
    // After clicking, a new one with Subject should appear
    let composePane = null;
    composePane = await waitFor(() => {
      // Look for a tabpanel or compose div that has a Subject input (bare <input>) visible
      // The compose pane always has an <input> for Subject — that's the most reliable signal
      const allPanels = [
        ...Array.from(document.querySelectorAll('div[role="tabpanel"]')),
        ...Array.from(document.querySelectorAll('div[class*="compose" i], div[id*="compose" i], .zmComposeView'))
      ];
      for (const panel of allPanels) {
        if (!panel.offsetParent || panel.closest('#cold-mailer-hud')) continue;
        // STRICT: must contain a visible text input (Subject field) that is not a search bar
        const inputs = Array.from(panel.querySelectorAll('input[type="text"], input:not([type])'));
        const subjectInp = inputs.find(inp => {
          if (!inp.offsetParent) return false;
          if (inp.closest('#cold-mailer-hud')) return false;
          const p = (inp.placeholder || inp.getAttribute("aria-label") || inp.getAttribute("data-placeholder") || inp.name || "").toLowerCase();
          // Allow bare inputs with no placeholder too — but not search inputs
          const isSearch = (p.includes("search") || (inp.type || "").toLowerCase() === "search");
          if (isSearch) return false;
          // If it has "subject" in label — perfect match
          if (p.includes("subject")) return true;
          // If the panel also has a Send button nearby — it's a compose panel, accept this input
          const hasSendInPanel = panel.querySelector('button[data-action="send"], button.zmSend, .zm-send-btn');
          if (hasSendInPanel) return true;
          return false;
        });
        if (subjectInp) {
          console.log("[ColdMailer Zoho] Found compose pane via subject input:", subjectInp);
          return panel;
        }
      }
      return null;
    }, 15000);

    if (!composePane) {
      throw new Error("Zoho compose tab never opened — please stay on Zoho Mail inbox and try again.");
    }

    console.log("[ColdMailer Zoho] Compose pane found:", composePane.className, composePane.id);
    await sleep(300);
    await checkPauseAndStop();

    // ── Step 2: Find To field ──
    setStatus(`Adding: ${recipient.email}…`);
    const toInput = findZohoToInput(composePane);
    if (!toInput) throw new Error("Zoho 'To' field not found inside compose pane.");

    console.log("[ColdMailer Zoho] To field:", toInput.tagName, toInput.className, toInput.placeholder);
    toInput.focus();
    try { toInput.click(); } catch (_) {}
    await sleep(150);

    if (toInput.tagName === "INPUT" || toInput.tagName === "TEXTAREA") {
      toInput.value = "";
      toInput.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(60);
      for (const ch of recipient.email) {
        await checkPauseAndStop();
        toInput.value += ch;
        toInput.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
        await sleep(22);
      }
    } else {
      // contenteditable div
      toInput.focus();
      try { document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); } catch (_) {}
      toInput.textContent = "";
      toInput.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(60);
      for (const ch of recipient.email) {
        await checkPauseAndStop();
        try { document.execCommand("insertText", false, ch); } catch (_) { toInput.textContent += ch; }
        toInput.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
        await sleep(22);
      }
    }

    await sleep(300);
    await checkPauseAndStop();

    // Commit chip: Enter → comma → Tab
    for (const kv of [{ key: "Enter", kc: 13 }, { key: ",", kc: 188 }, { key: "Tab", kc: 9 }]) {
      toInput.dispatchEvent(new KeyboardEvent("keydown", { key: kv.key, keyCode: kv.kc, which: kv.kc, bubbles: true }));
      toInput.dispatchEvent(new KeyboardEvent("keyup",   { key: kv.key, keyCode: kv.kc, which: kv.kc, bubbles: true }));
      await sleep(120);
    }
    toInput.dispatchEvent(new Event("change", { bubbles: true }));
    toInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await sleep(400);
    await checkPauseAndStop();

    // ── Step 3: Subject ──
    setStatus("Filling subject…");
    const subjectEl = findZohoSubjectInput(composePane);
    if (subjectEl) {
      const subjectText = renderSubject(config.subjectTemplate, recipient);
      subjectEl.focus();
      try { subjectEl.click(); } catch (_) {}
      subjectEl.value = subjectText;
      subjectEl.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: subjectText }));
      subjectEl.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(220);
    }
    await checkPauseAndStop();

    // ── Step 4: Body ──
    setStatus("Writing personalized body…");
    const bodyTarget = await waitFor(() => findZohoBodyTarget(composePane), 8000);
    if (!bodyTarget) throw new Error("Zoho Mail body area not found.");

    const { el: bodyEl, doc: targetDoc, isTextarea } = bodyTarget;
    const bodyText = renderBody(config.bodyTemplate, recipient);
    const resolvedName = (recipient && recipient.name && recipient.name !== "Hiring Manager" && recipient.name !== "Hiring Team")
      ? recipient.name : extractName(recipient.email);

    setStatus(`Writing body for ${recipient.email}…`);
    bodyEl.focus();
    if (typeof bodyEl.click === "function") bodyEl.click();
    await sleep(180);

    if (isTextarea) {
      bodyEl.value = bodyText;
      bodyEl.dispatchEvent(new Event("input", { bubbles: true }));
      bodyEl.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      try { targetDoc.execCommand("selectAll", false, null); targetDoc.execCommand("delete", false, null); } catch (_) {}
      await sleep(80);
      if (bodyEl.innerHTML.includes("Sent using Zoho Mail")) bodyEl.innerHTML = "";

      const formattedHtml = bodyText
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

      let writtenViaExec = false;
      try { writtenViaExec = targetDoc.execCommand("insertHTML", false, formattedHtml); } catch (_) {}
      if (!writtenViaExec || !bodyEl.innerHTML || bodyEl.innerHTML.trim() === "") {
        bodyEl.innerHTML = formattedHtml;
      }

      bodyEl.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      bodyEl.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(250);

      if (bodyEl.innerHTML.includes("Sent using Zoho Mail")) {
        bodyEl.innerHTML = bodyEl.innerHTML
          // (signature cleanup handled below)
          .replace(/Sent using Zoho Mail/gi, "").trim();
      }

      if (bodyEl.innerHTML.toLowerCase().includes("{name}") ||
          bodyEl.innerHTML.toLowerCase().includes("[name]") ||
          /(Hi|Hello|Hey|Dear)s+Name/i.test(bodyEl.innerHTML)) {
        bodyEl.innerHTML = bodyEl.innerHTML
          .replace(/\{name\}/gi, resolvedName).replace(/\[name\]/gi, resolvedName)
          .replace(/(Hi|Hello|Hey|Dear)s+Name/gi, `$1 ${resolvedName}`)
          .replace(/(Hi|Hello|Hey|Dear)s+name/gi, `$1 ${resolvedName}`)
          .replace(/\{company\}/gi, recipient.company || "your company")
          .replace(/\{role\}/gi, recipient.role || "Software Engineer");
      }
    }
    await sleep(100);
    await checkPauseAndStop();

    // ── Step 5: Attach Resume ──
    if (config.resume && config.resume.base64) {
      setStatus(`Attaching ${config.resume.name}…`);
      await sleep(400);
      await attachZohoFile(config.resume, bodyTarget);
      await sleep(3500);
    }
    await checkPauseAndStop();

    // ── Step 6: Send ──
    setStatus(`Sending to ${recipient.email}…`);
    await hitZohoSend(bodyTarget);
    await sleep(1800);
  }

  // ── Zoho Search Guard ──
  function isZohoSearchInput(el) {
    if (!el) return true;
    const p = (el.placeholder || "").toLowerCase();
    const a = (el.getAttribute("aria-label") || "").toLowerCase();
    const n = (el.name || "").toLowerCase();
    const t = (el.type || "").toLowerCase();
    if (t === "search") return true;
    if (p.includes("search") || a.includes("search") || n.includes("search")) return true;
    if (p === "/" || p === "search ( / )") return true;
    if (el.closest("header")) return true;
    let cur = el.parentElement;
    for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
      const cn = (cur.className || "").toLowerCase();
      const id = (cur.id || "").toLowerCase();
      if (cn.includes("search") || id.includes("search")) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // ── Zoho New Mail Button ──
  function findZohoNewMailBtn() {
    // 1. Exact text match "New Mail"
    for (const el of Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"], div, span, a'))) {
      if (el.closest('#cold-mailer-hud')) continue;
      const txt = (el.textContent || "").trim().toLowerCase();
      if ((txt === "new mail" || txt === "+ new mail") && el.offsetParent !== null) {
        // Return the nearest clickable ancestor
        return el.closest('button, [role="button"], a') || el;
      }
    }

    // 2. Starts with "New Mail" (handles "New Mail ▾" or "New Mail +")
    for (const el of Array.from(document.querySelectorAll('button, div[role="button"], a, div[class*="btn" i]'))) {
      if (el.closest('#cold-mailer-hud')) continue;
      const txt = (el.textContent || "").trim().toLowerCase();
      if (txt && txt.startsWith("new mail") && el.offsetParent !== null) return el;
    }

    // 3. Known Zoho class/attribute selectors
    for (const sel of [
      'button.zmNewMail', '.zmNewMail',
      '[data-action="new-mail"]', '[data-action="compose"]', '[data-action*="compose" i]',
      '[aria-label*="New Mail" i]', '[title*="New Mail" i]',
      '[data-test-id*="new-mail" i]', '.zm-new-mail', '.new-mail'
    ]) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  // ── Zoho Subject Input (scoped to compose pane) ──
  function findZohoSubjectInput(pane) {
    const root = pane || document;

    for (const sel of [
      'input[name="subject"]', 'input[name*="subject" i]',
      'input[placeholder*="Subject" i]', 'input[aria-label*="Subject" i]',
      'input[data-placeholder*="Subject" i]',
      '.zmSubject input', '.zm_subject input', 'input.zmSubject', '.zm-compose-subject input'
    ]) {
      const el = root.querySelector(sel);
      if (el && el.offsetParent !== null && !isZohoSearchInput(el)) return el;
    }

    for (const inp of root.querySelectorAll('input[type="text"], input:not([type])')) {
      if (isZohoSearchInput(inp) || inp.closest('#cold-mailer-hud') || !inp.offsetParent) continue;
      const p = (inp.placeholder || inp.getAttribute("aria-label") || inp.getAttribute("data-placeholder") || inp.name || "").toLowerCase();
      if (p.includes("subject")) return inp;
    }

    // Position fallback: last visible text input in compose pane = subject
    const allInputs = Array.from(root.querySelectorAll('input[type="text"], input:not([type])'))
      .filter(el => el.offsetParent !== null && !isZohoSearchInput(el) && !el.closest('#cold-mailer-hud'));
    return allInputs.length > 0 ? allInputs[allInputs.length - 1] : null;
  }

  // ── Zoho To Input (scoped to compose pane) ──
  function findZohoToInput(pane) {
    const root = pane || document;

    for (const sel of [
      '.zmContactSuggest', '.zmContactInput', '.zmTo input', '.zm_to input',
      '.zm-compose-to input', '.zmc-input input', '[data-name="to"] input', '[data-field="to"] input',
      'input[name="to"]', 'input[placeholder*="To" i]', 'input[aria-label*="To" i]',
      'input[data-placeholder*="To" i]', 'textarea[placeholder*="To" i]'
    ]) {
      for (const inp of root.querySelectorAll(sel)) {
        if (inp.offsetParent !== null && !isZohoSearchInput(inp) && !inp.closest('#cold-mailer-hud')) return inp;
      }
    }

    for (const sel of [
      '.zmTo [contenteditable]', '.zm_to [contenteditable]',
      '[data-name="to"] [contenteditable]', '[data-field="to"] [contenteditable]',
      'div[aria-label*="To" i][contenteditable]', 'div[placeholder*="To" i][contenteditable]'
    ]) {
      const el = root.querySelector(sel);
      if (el && el.offsetParent !== null && !el.closest('#cold-mailer-hud')) return el;
    }

    // Row with "To" label → grab its first editable child
    for (const row of root.querySelectorAll('div, tr, li')) {
      if (row.closest('#cold-mailer-hud') || !row.offsetParent) continue;
      const label = [...row.childNodes]
        .filter(n => n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && !n.children.length))
        .map(n => (n.textContent || "").trim().toLowerCase()).join(" ");
      if (!/^tos*$/.test(label) && row.getAttribute("data-field") !== "to" && row.getAttribute("data-name") !== "to") continue;
      for (const inp of row.querySelectorAll('input, textarea, [contenteditable="true"]')) {
        if (inp.offsetParent !== null && !isZohoSearchInput(inp) && !inp.closest('#cold-mailer-hud')) return inp;
      }
    }

    // Fallback: first editable element before the subject input
    const subjectEl = findZohoSubjectInput(pane);
    const all = Array.from(root.querySelectorAll('input[type="text"], input:not([type]), textarea, [contenteditable="true"]'))
      .filter(el => el.offsetParent !== null && !isZohoSearchInput(el) && !el.closest('#cold-mailer-hud') && el !== subjectEl);
    return all.length > 0 ? all[0] : null;
  }

  // ── Zoho Body Target (scoped to compose pane) ──
  function findZohoBodyTarget(pane) {
    const root = pane || document;

    // Rich-text iframe
    for (const iframe of root.querySelectorAll("iframe")) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc) continue;
        const editable = doc.querySelector('div[contenteditable="true"]') ||
          (doc.body && (doc.body.isContentEditable || doc.body.getAttribute("contenteditable") === "true" || doc.designMode === "on") ? doc.body : null) ||
          ((iframe.classList.contains("zmComposeEditor") || (iframe.id || "").includes("compose")) ? doc.body : null);
        if (editable) return { el: editable, doc, isIframe: true, isTextarea: false };
      } catch (_) {}
    }

    // Direct contenteditable
    for (const sel of [
      '.zme-editor-content', 'div[contenteditable="true"].zmComposeEditor',
      'div[contenteditable="true"][id*="editor" i]', 'div[contenteditable="true"][class*="editor" i]',
      'div[contenteditable="true"][data-placeholder*="Message" i]',
      'div[contenteditable="true"][aria-label*="Message" i]',
      'div[contenteditable="true"][aria-label*="Body" i]'
    ]) {
      const el = root.querySelector(sel);
      if (el && el.offsetParent !== null && !el.closest('#cold-mailer-hud')) {
        return { el, doc: document, isIframe: false, isTextarea: false };
      }
    }

    // Any tall contenteditable (> 80px height) that isn't To/Subject
    const subjEl = findZohoSubjectInput(pane);
    const toEl   = findZohoToInput(pane);
    const candidate = Array.from(root.querySelectorAll('div[contenteditable="true"]')).find(el => {
      if (!el.offsetParent || el.closest('#cold-mailer-hud') || el === subjEl || el === toEl) return false;
      return el.getBoundingClientRect().height > 80;
    });
    if (candidate) return { el: candidate, doc: document, isIframe: false, isTextarea: false };

    // Textarea fallback
    for (const sel of [
      'textarea.zm-plain-editor', 'textarea[name*="content" i]',
      'textarea[placeholder*="Message" i]', 'textarea[aria-label*="Message" i]'
    ]) {
      const el = root.querySelector(sel);
      if (el && el.offsetParent !== null && !el.closest('#cold-mailer-hud')) {
        return { el, doc: document, isIframe: false, isTextarea: true };
      }
    }

    return null;
  }

  // ── Zoho Attach File ──
  async function attachZohoFile(resumeData, bodyTarget) {
    const file = b64ToFile(resumeData.base64, resumeData.name, resumeData.type);
    const dt = new DataTransfer();
    dt.items.add(file);
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "files")?.set;
    const docs = [document];
    if (bodyTarget?.doc && bodyTarget.doc !== document) docs.push(bodyTarget.doc);
    let allInputs = [];
    for (const d of docs) allInputs = allInputs.concat(Array.from(d.querySelectorAll('input[type="file"]')));
    const primary = allInputs.find(el => el.name === "Filedata") ||
                    allInputs.find(el => !el.accept || el.accept === "*/*") || allInputs[0];
    if (primary && nativeSetter) {
      try {
        nativeSetter.call(primary, dt.files);
        primary.dispatchEvent(new Event("change", { bubbles: true }));
        primary.dispatchEvent(new Event("input",  { bubbles: true }));
        console.log("[ColdMailer Zoho] Attached ✓"); return;
      } catch (e) { console.warn("[ColdMailer Zoho] Method A:", e); }
    }
    const clipBtn = document.querySelector('.zmAttach, .zm-attach-icon, button[data-action="attach"], [data-tooltip*="Attach" i], [aria-label*="Attach" i], [title*="Attach" i]') ||
      Array.from(document.querySelectorAll('button, div[role="button"], span, i')).find(el => {
        if (el.closest('#cold-mailer-hud')) return false;
        return (el.getAttribute("title") || el.getAttribute("aria-label") || el.textContent || "").toLowerCase().includes("attach") && el.offsetParent;
      });
    if (clipBtn) {
      try {
        const intercepted = await new Promise(resolve => {
          const before = new Set(document.querySelectorAll('input[type="file"]'));
          const obs = new MutationObserver(() => {
            const newInp = Array.from(document.querySelectorAll('input[type="file"]')).find(e => !before.has(e));
            if (newInp) { obs.disconnect(); resolve(newInp); }
          });
          obs.observe(document.body, { childList: true, subtree: true });
          clipBtn.click();
          setTimeout(() => { obs.disconnect(); resolve(null); }, 2000);
        });
        if (intercepted && nativeSetter) {
          nativeSetter.call(intercepted, dt.files);
          intercepted.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
      } catch (e) { console.warn("[ColdMailer Zoho] Method B:", e); }
    }
    try {
      const zone = bodyTarget?.el || document.querySelector('.zmComposeView') || document.body;
      zone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
      await sleep(80);
      zone.dispatchEvent(new DragEvent("dragover",  { bubbles: true, cancelable: true, dataTransfer: dt }));
      await sleep(80);
      zone.dispatchEvent(new DragEvent("drop",      { bubbles: true, cancelable: true, dataTransfer: dt }));
    } catch (e) { console.warn("[ColdMailer Zoho] Method C:", e); }
  }

  // ── Zoho Send Button ──
  async function hitZohoSend(bodyTarget) {
    for (const sel of [
      'button[data-action="send"]', 'button[data-action="mail-send"]',
      'button.zmSend', '.zm-send-btn', '.btnSend'
    ]) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { el.click(); return; }
    }
    for (const el of document.querySelectorAll('button, div[role="button"], a[role="button"], button span, div span, a span')) {
      if (el.closest('#cold-mailer-hud')) continue;
      const txt = (el.textContent || "").trim().toLowerCase();
      if (txt === "send" && el.offsetParent !== null) {
        (el.closest('button, [role="button"], a') || el).click(); return;
      }
    }
    const target = bodyTarget?.el || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown",  { key: "Enter", keyCode: 13, ctrlKey: true, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", keyCode: 13, ctrlKey: true, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup",    { key: "Enter", keyCode: 13, ctrlKey: true, bubbles: true }));
  }

  // ─────────────────────────────────────────
  //  Shared Utilities
  // ─────────────────────────────────────────
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
