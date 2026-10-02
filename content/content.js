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
  //  ZOHO MAIL ENGINE (Clean Step-by-Step Automation)
  //  1. Click New Mail
  //  2. Type recipient email in To
  //  3. Type Subject
  //  4. Type Body with name extracted from email
  //  5. Drag & drop resume attachment
  //  6. Press Send
  // =========================================================================

  async function sendZoho(recipient) {
    await checkPauseAndStop();

    // ── STEP 1: Open / Switch to Compose Window ──
    let isComposeReady = zohoIsComposeOpen();

    if (!isComposeReady) {
      // First check if an existing compose tab is in the tab bar
      const switched = zohoSwitchToComposeTab();
      if (switched) {
        await sleep(400);
        isComposeReady = zohoIsComposeOpen();
      }
    }

    if (!isComposeReady) {
      setStatus("Clicking 'New Mail'…");
      const newMailBtn = await waitFor(zohoFindNewMailBtn, 8000);
      if (!newMailBtn) throw new Error("'New Mail' button not found on Zoho Mail interface.");

      console.log("[ColdMailer Zoho] Clicking New Mail:", newMailBtn);
      zohoClick(newMailBtn);
      await checkPauseAndStop();

      // Wait up to 10s for compose fields to appear
      setStatus("Waiting for compose tab…");
      isComposeReady = await waitFor(() => zohoIsComposeOpen(), 10000);

      // If still not open, dispatch keyboard shortcut 'c'
      if (!isComposeReady) {
        console.log("[ColdMailer Zoho] Trying keyboard shortcut 'c'…");
        zohoTriggerComposeShortcut();
        isComposeReady = await waitFor(() => zohoIsComposeOpen(), 6000);
      }

      if (!isComposeReady) {
        throw new Error("Zoho compose tab never opened — please click 'New Mail' manually in Zoho Mail, then run again.");
      }
    }

    await sleep(600); // let Zoho render all compose fields
    await checkPauseAndStop();

    const composePane = zohoFindComposePane();

    // ── STEP 2: Type recipient email address in To field ──
    setStatus(`Adding: ${recipient.email}…`);
    const toInput = await waitFor(() => zohoFindToInput(composePane), 6000);
    if (!toInput) throw new Error("Zoho 'To' field not found inside compose window.");

    console.log("[ColdMailer Zoho] Found To input:", toInput);
    toInput.focus();
    try { toInput.click(); } catch (_) {}
    await sleep(150);

    if (toInput.tagName === 'INPUT' || toInput.tagName === 'TEXTAREA') {
      toInput.value = '';
      toInput.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(60);
      for (const ch of recipient.email) {
        await checkPauseAndStop();
        toInput.value += ch;
        toInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
        await sleep(20);
      }
    } else {
      // contenteditable container
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
      } catch (_) {}
      toInput.textContent = '';
      toInput.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(60);
      for (const ch of recipient.email) {
        await checkPauseAndStop();
        try {
          document.execCommand('insertText', false, ch);
        } catch (_) {
          toInput.textContent += ch;
        }
        toInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
        await sleep(20);
      }
    }

    await sleep(250);
    await checkPauseAndStop();

    // Commit chip: Enter -> comma -> Tab
    for (const kv of [{ key: 'Enter', code: 13 }, { key: ',', code: 188 }, { key: 'Tab', code: 9 }]) {
      toInput.dispatchEvent(new KeyboardEvent('keydown', { key: kv.key, keyCode: kv.code, which: kv.code, bubbles: true }));
      toInput.dispatchEvent(new KeyboardEvent('keyup',   { key: kv.key, keyCode: kv.code, which: kv.code, bubbles: true }));
      await sleep(100);
    }
    toInput.dispatchEvent(new Event('change', { bubbles: true }));
    toInput.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    await sleep(350);
    await checkPauseAndStop();

    // ── STEP 3: Type Subject ──
    setStatus('Filling subject…');
    const subjectEl = zohoFindSubjectInput(composePane);
    if (subjectEl) {
      const subjectText = renderSubject(config.subjectTemplate, recipient);
      subjectEl.focus();
      try { subjectEl.click(); } catch (_) {}
      subjectEl.value = subjectText;
      subjectEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: subjectText }));
      subjectEl.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(220);
    }
    await checkPauseAndStop();

    // ── STEP 4: Type Body with personalized name from email ──
    setStatus('Writing email body…');
    const bodyInfo = await waitFor(() => zohoFindBody(composePane), 8000);
    if (!bodyInfo) throw new Error("Zoho Mail body area not found.");

    const { el: bodyEl, doc: targetDoc, isTextarea } = bodyInfo;
    const bodyText = renderBody(config.bodyTemplate, recipient);
    const resolvedName = (recipient && recipient.name && recipient.name !== 'Hiring Manager' && recipient.name !== 'Hiring Team')
      ? recipient.name
      : extractName(recipient.email);

    setStatus(`Writing body for ${recipient.email}…`);
    bodyEl.focus();
    if (typeof bodyEl.click === 'function') bodyEl.click();
    await sleep(200);

    if (isTextarea) {
      bodyEl.value = bodyText;
      bodyEl.dispatchEvent(new Event('input', { bubbles: true }));
      bodyEl.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      try {
        targetDoc.execCommand('selectAll', false, null);
        targetDoc.execCommand('delete', false, null);
      } catch (_) {}
      await sleep(80);

      bodyEl.innerHTML = '';

      const formattedHtml = bodyText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');

      let writtenViaExec = false;
      try {
        writtenViaExec = targetDoc.execCommand('insertHTML', false, formattedHtml);
      } catch (_) {}

      if (!writtenViaExec || !bodyEl.innerHTML || bodyEl.innerHTML.trim() === '') {
        bodyEl.innerHTML = formattedHtml;
      }

      bodyEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      bodyEl.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(250);

      // Clean default Zoho signature if still present
      if (bodyEl.innerHTML.includes('Sent using Zoho Mail')) {
        bodyEl.innerHTML = bodyEl.innerHTML.replace(/Sent using Zoho Mail/gi, '').trim();
      }

      // Safety placeholder check
      if (bodyEl.innerHTML.toLowerCase().includes('{name}') ||
          bodyEl.innerHTML.toLowerCase().includes('[name]') ||
          /\b(Hi|Hello|Hey|Dear)\s+Name\b/i.test(bodyEl.innerHTML)) {
        bodyEl.innerHTML = bodyEl.innerHTML
          .replace(/\{name\}/gi, resolvedName)
          .replace(/\[name\]/gi, resolvedName)
          .replace(/\b(Hi|Hello|Hey|Dear)\s+Name\b/gi, '$1 ' + resolvedName)
          .replace(/\b(Hi|Hello|Hey|Dear)\s+name\b/gi, '$1 ' + resolvedName)
          .replace(/\{company\}/gi, recipient.company || 'your company')
          .replace(/\{role\}/gi, recipient.role || 'Software Engineer');
      }
    }
    await sleep(150);
    await checkPauseAndStop();

    // ── STEP 5: Drag & drop resume into body ──
    if (config.resume && config.resume.base64) {
      setStatus(`Attaching ${config.resume.name}…`);
      await sleep(350);

      const file = b64ToFile(config.resume.base64, config.resume.name, config.resume.type);
      const dt = new DataTransfer();
      dt.items.add(file);

      const dropTargets = [bodyEl];
      if (targetDoc && targetDoc.body && targetDoc.body !== bodyEl) dropTargets.push(targetDoc.body);

      for (const target of dropTargets) {
        target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        await sleep(80);
        target.dispatchEvent(new DragEvent('dragover',  { bubbles: true, cancelable: true, dataTransfer: dt }));
        await sleep(80);
        target.dispatchEvent(new DragEvent('drop',      { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      console.log('[ColdMailer Zoho] Dispatched drag & drop onto body ✓');

      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files')?.set;
      const fileInput = (targetDoc || document).querySelector('input[type="file"]') || document.querySelector('input[type="file"]');
      if (fileInput && nativeSetter) {
        try {
          nativeSetter.call(fileInput, dt.files);
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_) {}
      }

      await sleep(3200); // wait for upload
    }
    await checkPauseAndStop();

    // ── STEP 6: Press Send ──
    setStatus(`Sending to ${recipient.email}…`);
    await zohoClickSend(composePane);
    await sleep(1800);
  }

  // ── Helper: Checks if Compose Window is Currently Open ──
  function zohoIsComposeOpen() {
    const s = zohoFindSubjectInput();
    const b = zohoFindSendBtn();
    return (s || b) ? true : false;
  }

  // ── Helper: Switch to an already-open Compose Tab if present ──
  function zohoSwitchToComposeTab() {
    for (const el of document.querySelectorAll('[role="tab"], .zmTab, li, div, span, a')) {
      if (el.closest('#cold-mailer-hud')) continue;
      const txt = (el.textContent || '').trim().toLowerCase();
      if ((txt.includes('no subj') || txt === 'compose') && el.offsetParent !== null) {
        console.log('[ColdMailer Zoho] Found open compose tab in tab bar:', el);
        zohoClick(el);
        return true;
      }
    }
    return false;
  }

  // ── Helper: Dispatches human-like mouse events (with elementFromPoint) ──
  function zohoClick(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'nearest' }); } catch (_) {}
    el.focus();

    const rect = el.getBoundingClientRect();
    const cx = Math.max(0, rect.left + Math.min(20, rect.width / 2));
    const cy = Math.max(0, rect.top + rect.height / 2);
    const evtParams = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };

    // 1. Dispatch directly onto element underneath cursor at coordinates
    try {
      const hitEl = document.elementFromPoint(cx, cy);
      if (hitEl && hitEl !== el) {
        hitEl.dispatchEvent(new PointerEvent('pointerdown', evtParams));
        hitEl.dispatchEvent(new MouseEvent('mousedown', evtParams));
        hitEl.dispatchEvent(new PointerEvent('pointerup', evtParams));
        hitEl.dispatchEvent(new MouseEvent('mouseup', evtParams));
        hitEl.click();
      }
    } catch (_) {}

    // 2. Dispatch on the target element itself
    el.dispatchEvent(new PointerEvent('pointerdown', evtParams));
    el.dispatchEvent(new MouseEvent('mousedown', evtParams));
    el.dispatchEvent(new PointerEvent('pointerup', evtParams));
    el.dispatchEvent(new MouseEvent('mouseup', evtParams));
    el.click();
    el.dispatchEvent(new MouseEvent('click', evtParams));

    // 3. Dispatch on child if any
    if (el.firstElementChild) {
      try {
        el.firstElementChild.click();
      } catch (_) {}
    }
  }

  // ── Helper: Trigger keyboard shortcut 'c' to compose ──
  function zohoTriggerComposeShortcut() {
    for (const target of [document.body, document]) {
      for (const k of ['c', 'C']) {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: 'KeyC', keyCode: 67, which: 67, bubbles: true, cancelable: true }));
        target.dispatchEvent(new KeyboardEvent('keypress', { key: k, code: 'KeyC', keyCode: 67, which: 67, bubbles: true, cancelable: true }));
        target.dispatchEvent(new KeyboardEvent('keyup',   { key: k, code: 'KeyC', keyCode: 67, which: 67, bubbles: true, cancelable: true }));
      }
    }
  }

  // ── Helper: Strict search bar guard ──
  function zohoIsSearchBar(el) {
    if (!el) return true;
    const p = (el.placeholder || '').toLowerCase();
    const a = (el.getAttribute('aria-label') || '').toLowerCase();
    const t = (el.type || '').toLowerCase();
    const n = (el.name || '').toLowerCase();
    if (t === 'search') return true;
    if (p.includes('search') || a.includes('search') || n.includes('search')) return true;
    if (p === '/' || p === 'search ( / )') return true;
    if (el.closest('header, [class*="search" i], [id*="search" i], .zmSearch')) return true;
    return false;
  }

  // ── Helper: Find "New Mail" button in sidebar (Exact matching, NOT startsWith) ──
  function zohoFindNewMailBtn() {
    // Priority 1: Exact text on clickable element
    for (const el of document.querySelectorAll('button, [role="button"], a, span, div')) {
      if (el.closest('#cold-mailer-hud')) continue;
      if (el.offsetParent === null) continue;

      // Exact text match on leaf or direct text node
      const directText = (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3)
        ? el.childNodes[0].nodeValue.trim().toLowerCase()
        : null;
      const fullText = (el.innerText || el.textContent || '').trim().toLowerCase();

      if (directText === 'new mail' || directText === '+ new mail') {
        return el.closest('button, [role="button"], a') || el;
      }
      if ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && (fullText === 'new mail' || fullText === '+ new mail')) {
        return el;
      }
      if ((fullText === 'new mail' || fullText === '+ new mail') && el.children.length <= 1) {
        return el.closest('button, [role="button"], a') || el;
      }
    }

    // Priority 2: Standard Zoho class and attribute selectors
    for (const sel of [
      'button.zmNewMail', '.zmNewMail',
      '[data-action="new-mail"]', '[data-action="compose"]', '[data-action*="compose" i]',
      '[aria-label*="New Mail" i]', '[title*="New Mail" i]',
      '[data-test-id*="new-mail" i]', '.zm-new-mail', '.new-mail'
    ]) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null && !el.closest('#cold-mailer-hud')) return el;
    }

    return null;
  }

  // ── Helper: Find Compose Pane container ──
  function zohoFindComposePane() {
    for (const sel of [
      'div[role="tabpanel"]:not([aria-hidden="true"])',
      '.zmComposeView',
      'div[id*="compose" i]',
      'div[class*="composeTab" i]',
      'div[class*="ComposeView" i]',
      'div[role="tabpanel"]'
    ]) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.offsetParent !== null && !el.closest('#cold-mailer-hud, header, nav, aside')) {
          if (el.querySelector('input[placeholder*="Subject" i], input[name*="subject" i], [title="Send"], button.zmSend')) {
            return el;
          }
        }
      }
    }
    return document.body;
  }

  // ── Helper: Find Subject Input ──
  function zohoFindSubjectInput(pane) {
    const root = pane || document;
    for (const sel of [
      'input[placeholder*="Subject" i]',
      'input[aria-label*="Subject" i]',
      'input[data-placeholder*="Subject" i]',
      'input[name="subject"]',
      'input[name*="subject" i]',
      '.zmSubject input',
      '.zm-compose-subject input',
      'input.zmSubject'
    ]) {
      const el = root.querySelector(sel);
      if (el && el.offsetParent !== null && !zohoIsSearchBar(el) && !el.closest('#cold-mailer-hud')) {
        return el;
      }
    }
    for (const inp of root.querySelectorAll('input[type="text"], input:not([type])')) {
      if (!inp.offsetParent || zohoIsSearchBar(inp) || inp.closest('#cold-mailer-hud')) continue;
      const p = (inp.placeholder || inp.getAttribute('aria-label') || inp.name || '').toLowerCase();
      if (p.includes('subject')) return inp;
    }
    return null;
  }

  // ── Helper: Find To Input ──
  function zohoFindToInput(pane) {
    const root = pane || document;
    for (const sel of [
      '.zmContactSuggest', '.zmContactInput', '.zmTo input', '.zm_to input',
      '.zm-compose-to input', '[data-name="to"] input', '[data-field="to"] input',
      'input[name="to"]', 'input[placeholder*="To" i]', 'input[aria-label*="To" i]',
      'input[data-placeholder*="To" i]',
      '.zmTo [contenteditable="true"]', '.zm_to [contenteditable="true"]',
      '[data-name="to"] [contenteditable="true"]', '[data-field="to"] [contenteditable="true"]',
      'div[aria-label*="To" i][contenteditable="true"]',
      'div[placeholder*="To" i][contenteditable="true"]'
    ]) {
      for (const el of root.querySelectorAll(sel)) {
        if (el.offsetParent !== null && !zohoIsSearchBar(el) && !el.closest('#cold-mailer-hud')) {
          return el;
        }
      }
    }
    for (const row of root.querySelectorAll('div, tr, li, section')) {
      if (!row.offsetParent || row.closest('#cold-mailer-hud')) continue;
      const txt = (row.childNodes[0]?.textContent || row.textContent || '').trim().toLowerCase();
      if (/^to\b/i.test(txt) || row.getAttribute('data-field') === 'to' || row.getAttribute('data-name') === 'to') {
        const editables = row.querySelectorAll('input, textarea, [contenteditable="true"]');
        for (const el of editables) {
          if (el.offsetParent !== null && !zohoIsSearchBar(el) && !el.closest('#cold-mailer-hud')) {
            return el;
          }
        }
      }
    }
    const subj = zohoFindSubjectInput(pane);
    const all = Array.from(root.querySelectorAll('input[type="text"], input:not([type]), textarea, [contenteditable="true"]'))
      .filter(el => el.offsetParent !== null && !zohoIsSearchBar(el) && !el.closest('#cold-mailer-hud') && el !== subj);
    if (all.length > 0) return all[0];
    return null;
  }

  // ── Helper: Find Body Editor ──
  function zohoFindBody(pane) {
    const root = pane || document;
    for (const iframe of root.querySelectorAll('iframe')) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc) continue;
        const editable =
          doc.querySelector('div[contenteditable="true"]') ||
          (doc.body && (doc.body.isContentEditable || doc.body.getAttribute('contenteditable') === 'true' || doc.designMode === 'on') ? doc.body : null);
        if (editable) return { el: editable, doc, isIframe: true, isTextarea: false };
      } catch (_) {}
    }
    for (const sel of [
      '.zme-editor-content',
      'div[contenteditable="true"].zmComposeEditor',
      'div[contenteditable="true"][class*="editor" i]',
      'div[contenteditable="true"][id*="editor" i]',
      'div[contenteditable="true"][data-placeholder]',
      'div[contenteditable="true"][aria-label*="Message" i]',
      'div[contenteditable="true"][aria-label*="Body" i]'
    ]) {
      const el = root.querySelector(sel);
      if (el && el.offsetParent !== null && !el.closest('#cold-mailer-hud')) {
        return { el, doc: document, isIframe: false, isTextarea: false };
      }
    }
    const subj = zohoFindSubjectInput(pane);
    const to = zohoFindToInput(pane);
    const tall = Array.from(root.querySelectorAll('div[contenteditable="true"]')).find(el => {
      if (!el.offsetParent || el.closest('#cold-mailer-hud') || el === subj || el === to) return false;
      return el.getBoundingClientRect().height > 80;
    });
    if (tall) return { el: tall, doc: document, isIframe: false, isTextarea: false };
    for (const el of root.querySelectorAll('textarea')) {
      if (el.offsetParent !== null && !el.closest('#cold-mailer-hud') && !zohoIsSearchBar(el)) {
        return { el, doc: document, isIframe: false, isTextarea: true };
      }
    }
    return null;
  }

  // ── Helper: Find Send Button ──
  function zohoFindSendBtn(pane) {
    const root = pane || document;
    for (const sel of [
      'button[data-action="send"]',
      'button[data-action="mail-send"]',
      'button.zmSend',
      '.zm-send-btn',
      '.btnSend',
      '[title="Send"][class*="btn" i]',
      '[aria-label="Send"][class*="btn" i]',
      '[title="Send"]',
      '[aria-label="Send"]'
    ]) {
      const el = root.querySelector(sel);
      if (el && el.offsetParent !== null && !el.closest('#cold-mailer-hud')) return el;
    }
    for (const el of root.querySelectorAll('button, [role="button"], a, div[class*="btn" i]')) {
      if (el.closest('#cold-mailer-hud')) continue;
      const txt = (el.textContent || '').trim().toLowerCase();
      if (txt === 'send' && el.offsetParent !== null) {
        return el;
      }
    }
    return null;
  }

  // ── Helper: Click Send Button ──
  async function zohoClickSend(pane) {
    const btn = zohoFindSendBtn(pane);
    if (btn) {
      console.log('[ColdMailer Zoho] Clicking Send button:', btn);
      zohoClick(btn);
      return;
    }
    console.log('[ColdMailer Zoho] Send button not found — using Ctrl+Enter fallback');
    const target = pane || document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, ctrlKey: true, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, ctrlKey: true, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, ctrlKey: true, bubbles: true }));
  }

  // ─────────────────────────────────────────
  //  Shared Utilities
  // ─────────────────────────────────────────
  function b64ToFile(dataUrl, name, type) {
    const [, data] = dataUrl.split(',');
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
