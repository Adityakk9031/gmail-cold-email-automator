// Gmail Cold Email Automator - Popup Logic v2.2

let parsedCsvRecipients = [];
let resumeFileData = null;
let activeGmailTabId = null;

// ─────────────────────────────────────────
//  Smart Name Extractor from email address
// ─────────────────────────────────────────
function extractNameFromEmail(email) {
  if (!email || typeof email !== "string") return "Hiring Manager";
  const user = email.split("@")[0].toLowerCase().trim();
  const generic = [
    "hr", "careers", "jobs", "recruiting", "recruitment", "talent", "info",
    "contact", "support", "hiring", "admin", "hello", "team", "people", "apply",
    "noreply", "no-reply", "mail", "enquiries", "office"
  ];
  if (generic.includes(user)) return "Hiring Team";

  // Split on dots, underscores, hyphens, digits
  const parts = user.split(/[._\-\d]+/).filter(p => p.length >= 2);
  if (parts.length > 0) {
    const first = parts[0];
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  }
  return "Hiring Manager";
}

// ─────────────────────────────────────────
//  Subject Template Engine (NEVER prepends greeting!)
// ─────────────────────────────────────────
function renderSubject(tpl, recipient) {
  if (!tpl || typeof tpl !== "string") return "";
  const email = (recipient && recipient.email) ? recipient.email : "";
  let name = (recipient && recipient.name && recipient.name !== "Hiring Manager" && recipient.name !== "Hiring Team")
    ? recipient.name
    : extractNameFromEmail(email);

  if (!name || name.trim() === "") name = extractNameFromEmail(email);
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
//  Body Template Engine (Personalized greeting)
// ─────────────────────────────────────────
function renderBody(tpl, recipient) {
  if (!tpl || typeof tpl !== "string") return "";
  const email = (recipient && recipient.email) ? recipient.email : "";
  let name = (recipient && recipient.name && recipient.name !== "Hiring Manager" && recipient.name !== "Hiring Team")
    ? recipient.name
    : extractNameFromEmail(email);

  if (!name || name.trim() === "") {
    name = extractNameFromEmail(email);
  }

  const company = (recipient && recipient.company && recipient.company !== "your company")
    ? recipient.company
    : "your company";
  const role = (recipient && recipient.role && recipient.role !== "Software Engineer")
    ? recipient.role
    : "Software Engineer";

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
//  Initialization
// ─────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  bindEvents();
  await checkGmailTab();
  await restoreDraftAndSaved();
  updateLivePreview();
});

// ─────────────────────────────────────────
//  Tabs
// ─────────────────────────────────────────
function setupTabs() {
  document.getElementById("tab-csv").addEventListener("click", () => switchTab("csv"));
  document.getElementById("tab-manual").addEventListener("click", () => switchTab("manual"));
}

function switchTab(name) {
  document.getElementById("tab-csv").classList.toggle("active", name === "csv");
  document.getElementById("tab-manual").classList.toggle("active", name === "manual");
  document.getElementById("csv-section").classList.toggle("active", name === "csv");
  document.getElementById("manual-section").classList.toggle("active", name === "manual");
  updateLivePreview();
}

// ─────────────────────────────────────────
//  Event Binding
// ─────────────────────────────────────────
function bindEvents() {
  document.getElementById("csv-file-input").addEventListener("change", handleCsvUpload);
  document.getElementById("resume-file-input").addEventListener("change", handleResumeUpload);

  // Pop out into its own full browser tab
  const popoutBtn = document.getElementById("btn-popout");
  if (popoutBtn) {
    popoutBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html") });
    });
  }

  // Continuous autosave on every single keystroke + live preview update
  const liveInputs = ["email-subject", "email-body", "manual-emails", "send-delay"];
  liveInputs.forEach(id => {
    document.getElementById(id).addEventListener("input", () => {
      saveDraftState();
      updateLivePreview();
    });
  });

  document.getElementById("add-jitter").addEventListener("change", () => {
    saveDraftState();
  });

  // Explicit Save Template button
  document.getElementById("btn-save-template").addEventListener("click", handleSaveTemplate);

  // Clear Template button
  document.getElementById("btn-clear-template").addEventListener("click", handleClearTemplate);

  document.getElementById("btn-start").addEventListener("click", () => launchCampaign(false));
  document.getElementById("btn-test-send").addEventListener("click", () => launchCampaign(true));
}

// ─────────────────────────────────────────
//  Continuous Draft Auto-Save
// ─────────────────────────────────────────
function saveDraftState() {
  const draft = {
    subject: document.getElementById("email-subject").value,
    body: document.getElementById("email-body").value,
    manual: document.getElementById("manual-emails").value,
    delay: document.getElementById("send-delay").value,
    addJitter: document.getElementById("add-jitter").checked,
  };
  chrome.storage.local.set({ coldMailerDraft: draft });
}

async function restoreDraftAndSaved() {
  // 1. First restore continuous draft state (what user was currently typing)
  const { coldMailerDraft: draft } = await chrome.storage.local.get(["coldMailerDraft"]);
  if (draft) {
    if (draft.subject !== undefined) document.getElementById("email-subject").value = draft.subject;
    if (draft.body !== undefined) document.getElementById("email-body").value = draft.body;
    if (draft.manual !== undefined) document.getElementById("manual-emails").value = draft.manual;
    if (draft.delay !== undefined) document.getElementById("send-delay").value = draft.delay;
    if (draft.addJitter !== undefined) document.getElementById("add-jitter").checked = draft.addJitter;
  }

  // 2. Check if an explicitly saved template exists to show the badge
  const { coldMailerSavedTemplate: saved } = await chrome.storage.local.get(["coldMailerSavedTemplate"]);
  const badge = document.getElementById("template-saved-status");
  if (badge && saved && (saved.subject || saved.body)) {
    badge.classList.remove("hidden");
  }
}

// ─────────────────────────────────────────
//  Save & Clear Template Handlers
// ─────────────────────────────────────────
function handleSaveTemplate() {
  const subject = document.getElementById("email-subject").value.trim();
  const body = document.getElementById("email-body").value.trim();

  if (!subject && !body) {
    showMsg("Please enter a subject line and body before saving.", "error");
    return;
  }

  saveDraftState();

  chrome.storage.local.set({
    coldMailerSavedTemplate: {
      subject: document.getElementById("email-subject").value,
      body: document.getElementById("email-body").value,
      savedAt: Date.now()
    }
  }, () => {
    const feedback = document.getElementById("save-feedback");
    const badge = document.getElementById("template-saved-status");

    if (badge) badge.classList.remove("hidden");
    if (feedback) {
      feedback.textContent = "✓ Saved!";
      feedback.classList.remove("hidden");
      setTimeout(() => {
        feedback.classList.add("hidden");
      }, 2500);
    }
    showMsg("✓ Template saved for this session!", "success");
    updateLivePreview();
  });
}

function handleClearTemplate() {
  document.getElementById("email-subject").value = "";
  document.getElementById("email-body").value = "";

  chrome.storage.local.remove(["coldMailerSavedTemplate", "coldMailerDraft"], () => {
    const badge = document.getElementById("template-saved-status");
    if (badge) badge.classList.add("hidden");
    showMsg("Template cleared. Fields are now blank.", "info");
    updateLivePreview();
  });
}

// ─────────────────────────────────────────
//  Gmail Tab Detection (Works in popup & tab)
// ─────────────────────────────────────────
async function checkGmailTab() {
  const badge = document.getElementById("connection-status");
  try {
    // 1. Check if active tab is Gmail
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.url?.startsWith("https://mail.google.com/")) {
      activeGmailTabId = activeTab.id;
      badge.textContent = "● Gmail Connected";
      badge.className = "badge badge-connected";
      return;
    }

    // 2. If not active tab (e.g. extension opened in its own tab), search all open tabs for Gmail
    const gmailTabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
    if (gmailTabs.length > 0) {
      activeGmailTabId = gmailTabs[0].id;
      badge.textContent = "● Gmail Connected";
      badge.className = "badge badge-connected";
    } else {
      activeGmailTabId = null;
      badge.textContent = "● Open Gmail Tab";
      badge.className = "badge badge-disconnected";
      showMsg("Please open mail.google.com in a browser tab.", "error");
    }
  } catch (err) {
    badge.textContent = "● Connection Error";
    badge.className = "badge badge-disconnected";
  }
}

// ─────────────────────────────────────────
//  CSV Handling
// ─────────────────────────────────────────
function handleCsvUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    parsedCsvRecipients = parseCsv(ev.target.result);
    const info = document.getElementById("csv-preview-info");
    if (!parsedCsvRecipients.length) {
      info.textContent = "⚠️ No valid email addresses found in CSV.";
    } else {
      info.textContent = `✓ Loaded ${parsedCsvRecipients.length} recipients from ${file.name}`;
      showMsg(`${parsedCsvRecipients.length} recipients loaded!`, "success");
    }
    info.classList.remove("hidden");
    updateLivePreview();
  };
  reader.readAsText(file);
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/["']/g, ""));
  const emailIdx   = headers.findIndex(h => h.includes("email"));
  const nameIdx    = headers.findIndex(h => h === "name" || h === "first name" || h === "firstname");
  const companyIdx = headers.findIndex(h => h.includes("company") || h.includes("org"));
  const roleIdx    = headers.findIndex(h => h.includes("role") || h.includes("title") || h.includes("position"));

  if (emailIdx === -1) {
    showMsg("CSV must have an 'Email' column.", "error");
    return [];
  }

  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvRow(lines[i]);
    const email = cols[emailIdx]?.trim().replace(/["']/g, "");
    if (!email || !email.includes("@")) continue;

    const csvName = nameIdx >= 0 ? cols[nameIdx]?.trim().replace(/["']/g, "") : "";
    const name = csvName || extractNameFromEmail(email);

    results.push({
      email,
      name,
      company: companyIdx >= 0 ? (cols[companyIdx]?.trim() || "your company") : "your company",
      role:    roleIdx    >= 0 ? (cols[roleIdx]?.trim()    || "Software Engineer") : "Software Engineer",
    });
  }
  return results;
}

function splitCsvRow(line) {
  const cols = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inQ) { inQ = true; continue; }
    if (ch === '"' && inQ)  { inQ = false; continue; }
    if (ch === "," && !inQ) { cols.push(cur); cur = ""; continue; }
    cur += ch;
  }
  cols.push(cur);
  return cols;
}

// ─────────────────────────────────────────
//  Resume Upload
// ─────────────────────────────────────────
function handleResumeUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    resumeFileData = { name: file.name, type: file.type || "application/pdf", base64: reader.result };
    document.getElementById("resume-label").innerHTML = `✓ <strong>${file.name}</strong>`;
    document.getElementById("resume-size").textContent = `${(file.size / 1048576).toFixed(2)} MB`;
  };
  reader.readAsDataURL(file);
}

// ─────────────────────────────────────────
//  Get Current Recipients
// ─────────────────────────────────────────
function getRecipients() {
  const csvActive = document.getElementById("tab-csv").classList.contains("active");
  if (csvActive) return parsedCsvRecipients;

  const raw = document.getElementById("manual-emails").value;
  return raw
    .split(/[\n,;]+/)
    .map(e => e.trim())
    .filter(e => e.includes("@"))
    .map(email => ({
      email,
      name: extractNameFromEmail(email),
      company: "your company",
      role: "Software Engineer",
    }));
}

// ─────────────────────────────────────────
//  Real-Time Live Preview Update
// ─────────────────────────────────────────
function updateLivePreview() {
  const recipients = getRecipients();
  const countBadge = document.getElementById("recipient-count-badge");
  if (countBadge) {
    countBadge.textContent = `${recipients.length} email${recipients.length === 1 ? "" : "s"}`;
  }

  const rawSubject = document.getElementById("email-subject").value;
  const rawBody = document.getElementById("email-body").value;

  const targetEmailEl = document.getElementById("preview-target-email");
  const extractedNameEl = document.getElementById("preview-extracted-name");
  const previewSubjectEl = document.getElementById("preview-subject-text");
  const previewBodyEl = document.getElementById("preview-body-text");

  if (!rawSubject && !rawBody && recipients.length === 0) {
    if (targetEmailEl) targetEmailEl.textContent = "Target: (Enter an email above)";
    if (extractedNameEl) extractedNameEl.textContent = "-";
    if (previewSubjectEl) previewSubjectEl.textContent = "(Subject will appear here)";
    if (previewBodyEl) previewBodyEl.textContent = "(Enter subject and body above to see live preview)";
    return;
  }

  // Sample recipient to preview against
  const sampleRecipient = recipients.length > 0 
    ? recipients[0] 
    : { email: "lalitha.sushrutha@juspay.in", name: "Lalitha", company: "Juspay", role: "Software Engineer" };

  const actualName = sampleRecipient.name || extractNameFromEmail(sampleRecipient.email);

  if (targetEmailEl) targetEmailEl.textContent = `Target: ${sampleRecipient.email}`;
  if (extractedNameEl) extractedNameEl.textContent = actualName;

  if (previewSubjectEl) {
    const renderedSubject = renderSubject(rawSubject, sampleRecipient);
    previewSubjectEl.textContent = renderedSubject || "(No subject entered)";
  }

  if (previewBodyEl) {
    const renderedBody = renderBody(rawBody, sampleRecipient);
    previewBodyEl.textContent = renderedBody || "(No body entered)";
  }
}

// ─────────────────────────────────────────
//  Launch Campaign
// ─────────────────────────────────────────
async function launchCampaign(testOnly) {
  await checkGmailTab();
  if (!activeGmailTabId) {
    showMsg("Please make sure Gmail is open in a browser tab!", "error");
    return;
  }

  const recipients = getRecipients();
  if (!recipients.length) {
    showMsg("Please provide at least one recipient email!", "error");
    return;
  }

  const subject = document.getElementById("email-subject").value.trim();
  const body = document.getElementById("email-body").value.trim();
  if (!subject) {
    showMsg("Please enter a subject line.", "error");
    return;
  }
  if (!body) {
    showMsg("Please enter an email body.", "error");
    return;
  }

  saveDraftState();

  const delay = Math.max(15, parseInt(document.getElementById("send-delay").value, 10) || 30);
  const addJitter = document.getElementById("add-jitter").checked;
  const targets = testOnly ? [recipients[0]] : recipients;

  showMsg(testOnly ? "Sending 1 test email…" : `Launching ${targets.length}-email campaign…`, "info");

  const payload = {
    action: "START_CAMPAIGN",
    recipients: targets,
    subjectTemplate: subject,
    bodyTemplate: body,
    resume: resumeFileData,
    delaySeconds: delay,
    addJitter,
    testOnly,
  };

  try {
    await ensureContentScriptReady(activeGmailTabId);
    const res = await chrome.tabs.sendMessage(activeGmailTabId, payload);
    if (res?.status === "STARTED") {
      showMsg("✓ Campaign started! Switch to Gmail tab to view progress.", "success");
      setTimeout(() => {
        // If it's a popup, close; if in full tab, keep open
        if (window.innerWidth <= 550) window.close();
      }, 1600);
    } else {
      showMsg(res?.message || "Could not contact Gmail. Please refresh the Gmail tab.", "error");
    }
  } catch (err) {
    console.error(err);
    showMsg("Failed to communicate with Gmail. Refresh Gmail tab and try again.", "error");
  }
}

// ─────────────────────────────────────────
//  Auto-Inject Content Script if not loaded
// ─────────────────────────────────────────
async function ensureContentScriptReady(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { action: "PING" }).catch(() => null);
    if (ping?.status === "PONG") return true;

    // Not yet loaded in this tab — inject dynamically
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content/content.css"]
    }).catch(() => null);

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/content.js"]
    });

    await new Promise(r => setTimeout(r, 250));
    return true;
  } catch (e) {
    console.warn("[ColdMailer] Content script auto-inject:", e);
    return false;
  }
}

// ─────────────────────────────────────────
//  Status Message
// ─────────────────────────────────────────
function showMsg(text, type = "info") {
  const el = document.getElementById("status-message");
  el.textContent = text;
  el.className = `status-msg ${type}`;
  el.classList.remove("hidden");
}
