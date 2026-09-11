// Gmail Cold Email Automator - Content Script v1.3
// Injected into https://mail.google.com/*

(() => {
  // ── De-register any OLD message listener from previous script version ──
  // We do this by storing the handler on window so we can remove it.
  if (window.__COLD_MAILER_LISTENER__) {
    chrome.runtime.onMessage.removeListener(window.__COLD_MAILER_LISTENER__);
  }

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
    document.querySelectorAll('div[role="dialog"]').forEach(d => {
      if (d.querySelector('input[name="subjectbox"]')) {
        const btn = d.querySelector('[aria-label*="Discard" i],[data-tooltip*="Discard" i]');
        if (btn) btn.click();
      }
    });
    await sleep(300);
    await checkPauseAndStop();

    // ── 1. Click Compose ──
    setStatus("Opening compose…");
    const composeBtn = await waitFor(findComposeBtn, 6000);
    if (!composeBtn) throw new Error("Compose button not found — is Gmail fully loaded?");
    composeBtn.click();
    await checkPauseAndStop();

    // ── 2. Wait for To field (proves the compose form is ready) ──
    setStatus("Waiting for compose form…");
    const toInput = await waitFor(() => {
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
    }, 12000);
    if (!toInput) throw new Error("'To' field never appeared — refresh Gmail and try again.");
    await sleep(250);
    await checkPauseAndStop();

    // ── 3. Type recipient email char-by-char (Gmail needs this for its chip engine) ──
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

    // Tab → converts email text to a proper chip in Gmail
    toInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", keyCode: 9, bubbles: true }));
    toInput.dispatchEvent(new KeyboardEvent("keyup",   { key: "Tab", keyCode: 9, bubbles: true }));
    await sleep(450);
    await checkPauseAndStop();

    // ── 4. Subject (Never prepends greeting!) ──
    setStatus("Filling subject…");
    const subjectEl = await waitFor(() =>
      document.querySelector('input[name="subjectbox"]') ||
      document.querySelector('input[aria-label*="Subject" i]')
    , 5000);

    if (subjectEl) {
      // Use renderSubject — ONLY replaces tags, NEVER prepends 'Hi [Name],'!
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
    const bodyEl = await waitFor(() =>
      document.querySelector('div[aria-label="Message Body"]') ||
      document.querySelector('div[g_editable="true"][role="textbox"]') ||
      document.querySelector('div[contenteditable="true"][aria-multiline="true"]')
    , 6000);
    if (!bodyEl) throw new Error("Body area not found.");

    // Apply template to body
    const bodyText = renderBody(config.bodyTemplate, recipient);

    // Show resolved name prominently in HUD
    const resolvedName = extractName(recipient.email);
    setStatus(`Writing body for ${recipient.email}…`);

    bodyEl.focus();
    bodyEl.click();
    await sleep(180);

    // Clear existing content (Gmail may have a pre-filled signature)
    try {
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    } catch (_) {}
    await sleep(80);

    // Write via innerHTML — converts \n to <br> and escapes HTML properly
    bodyEl.innerHTML = bodyText
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");

    // Tell Gmail the content changed
    bodyEl.dispatchEvent(new InputEvent("input",  { bubbles: true, inputType: "insertText" }));
    bodyEl.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(300);

    // ── POST-WRITE SAFETY CHECK ──
    // If {name}, [name], or "Hi Name" still appears in the body, force replace it directly on innerHTML
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
    await sleep(100);
    await checkPauseAndStop();

    // ── 6. Attach Resume ──
    if (config.resume && config.resume.base64) {
      setStatus(`Attaching ${config.resume.name}…`);
      await sleep(400);
      await attachFile(config.resume);
      await sleep(3500);
    }
    await checkPauseAndStop();

    // ── 7. Send ──
    setStatus(`Sending to ${recipient.email}…`);
    await hitSend();
    await sleep(1500);
  }

  // ─────────────────────────────────────────
  //  Helpers
  // ─────────────────────────────────────────

  function findComposeBtn() {
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

  async function attachFile(resumeData) {
    const file = b64ToFile(resumeData.base64, resumeData.name, resumeData.type);
    const dt = new DataTransfer();
    dt.items.add(file);

    // Method A: native HTMLInputElement.files setter (bypasses Gmail's non-configurable property)
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "files"
    )?.set;

    const allInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    const primary   = allInputs.find(el => el.name === "Filedata") ||
                      allInputs.find(el => !el.accept || el.accept === "*/*") ||
                      allInputs[0];

    if (primary && nativeSetter) {
      try {
        nativeSetter.call(primary, dt.files);
        primary.dispatchEvent(new Event("change", { bubbles: true }));
        primary.dispatchEvent(new Event("input",  { bubbles: true }));
        console.log("[ColdMailer] Attached via native setter ✓");
        return;
      } catch (e) { console.warn("[ColdMailer] Method A failed:", e); }
    }

    // Method B: click paperclip, intercept new file input
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
          console.log("[ColdMailer] Attached via button intercept ✓");
          return;
        }
      } catch (e) { console.warn("[ColdMailer] Method B failed:", e); }
    }

    // Method C: drag-and-drop fallback
    try {
      const zone = document.querySelector('div[aria-label="Message Body"]') ||
                   document.querySelector('div[role="dialog"]') ||
                   document.body;
      zone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
      await sleep(80);
      zone.dispatchEvent(new DragEvent("dragover",  { bubbles: true, cancelable: true, dataTransfer: dt }));
      await sleep(80);
      zone.dispatchEvent(new DragEvent("drop",      { bubbles: true, cancelable: true, dataTransfer: dt }));
      console.log("[ColdMailer] Attached via drag-drop ✓");
    } catch (e) { console.warn("[ColdMailer] All attach methods failed:", e); }
  }

  async function hitSend() {
    for (const sel of [
      'div[role="button"][data-tooltip*="Send" i]',
      'div[role="button"][aria-label*="Send" i]',
      'button[aria-label*="Send" i]',
      '.T-I.J-J5-Ji.aoO',
    ]) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { el.click(); return; }
    }
    // Fallback: Ctrl+Enter
    const target = document.querySelector('div[aria-label="Message Body"]') || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, ctrlKey: true, bubbles: true }));
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
        <div class="cm-hud-title">🚀 Cold Mailer</div>
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
