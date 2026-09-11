# 🚀 Gmail Cold Email Automator

A lightweight, privacy-focused Chrome/Edge extension (Manifest V3) that automates personalized cold outreach directly within Gmail, complete with automated resume attachments, smart name extraction, anti-spam jitter delays, and an interactive in-page HUD.

---

## ✨ Features

- **Smart Name Personalization:** Automatically extracts the recipient's first name from their email address (e.g. `lalitha.sushrutha@juspay.in` → `Lalitha`, `alex_smith@company.com` → `Alex`, `hr@company.com` → `Hiring Team`) and customizes the email greeting seamlessly.
- **Dedicated Template Setup & Live Preview:** Real-time live preview renders your personalized subject and body as you type.
- **Continuous Autosave:** Never lose your subject or body when switching tabs to copy text — keystrokes are automatically persisted locally.
- **Pop-out Full Tab Mode:** Click **⛶ Open in Tab** to manage your campaign in a dedicated tab that never closes when switching windows.
- **Automated Resume Attachments:** Attaches your PDF or Word document automatically to each outgoing compose window.
- **Spam & Rate-Limit Protection:** Configurable delay between sends with natural randomized human jitter (±4–8s) to protect your sender reputation.
- **In-Page Floating Control HUD:** Draggable, minimizable progress overlay injected directly into Gmail with real-time **Pause**, **Resume**, and **Stop** controls.
- **100% Client-Side & Private:** Operates entirely within your local browser session. No external servers, no tracking, and no credentials exposed.

---

## 🛠️ Installation (Developer Mode)

1. Clone or download this repository:
   ```bash
   git clone https://github.com/Adityakk9031/gmail-cold-email-automator.git
   ```
2. Open Google Chrome or Microsoft Edge and navigate to:
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
3. Toggle on **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the root directory of this repository.
5. The **Gmail Cold Email Automator** icon will appear in your extensions toolbar!

---

## 📖 How to Use

1. Open **[Gmail](https://mail.google.com)** in a browser tab.
2. Click the extension icon in your browser toolbar (or click **⛶ Open in Tab**).
3. **Step 1 - Recipients:**
   - Upload a `recipients.csv` file (columns: `Email`, `Name`, `Company`, `Role`), or
   - Switch to **Paste Emails** and paste addresses one per line.
4. **Step 2 - Subject & Template Setup:**
   - Enter your Subject line.
   - Enter your Email Body starting with `Hi Name,`.
   - Verify how it looks in the **Live Preview** card below.
   - *(Optional)* Click **💾 Save Template** to lock it in for your session.
5. **Step 3 - Resume Attachment:**
   - Drop your resume (`.pdf` or `.docx`).
6. **Step 4 - Spam Protection:**
   - Set the delay between emails (e.g. 30s) and enable human jitter.
7. Click **🧪 Test 1 Email** to verify, or **🚀 Start Campaign** to launch!

---

## 📁 Repository Structure

```
├── manifest.json            # Manifest V3 extension configuration
├── icons/                   # Extension icons (16px, 48px, 128px)
├── popup/
│   ├── popup.html           # Popup and pop-out full-tab UI
│   ├── popup.css            # Dark-theme styling and responsive layout
│   └── popup.js             # Form validation, CSV parser, name extraction & draft persistence
├── content/
│   ├── content.js           # Gmail DOM automation engine & interactive HUD
│   └── content.css          # HUD styling and animations
└── README.md
```

---

## 👨‍💻 Author

**Aditya Kumar Singh**
- GitHub: [@Adityakk9031](https://github.com/Adityakk9031)
- Email: [adityakrsingh9056@gmail.com](mailto:adityakrsingh9056@gmail.com)

---

## 📄 License

MIT License. Free for personal and commercial use.
