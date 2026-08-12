import { clearAccount, loadConfig, saveConfig } from "../background/config-store.js";
import { isMsg } from "../shared/messages.js";
import { RuntimeState } from "../shared/state.js";
import { normalizeHostname, originPattern } from "../shared/allow-sites.js";
import { MIC_CONSTRAINTS } from "../offscreen/media.js";

declare const __SIPJS_REF__: string;

const OPEN_SECTION_KEY = "websipphone.openSection";
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function setAccountStatus(text: string, isError = false): void {
  const el = $("acc-status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function notifyConfigChanged(): void {
  void chrome.runtime.sendMessage({ target: "background", type: "config/changed" }).catch(() => {});
}

// ---- section switching ----
function showSection(name: string): void {
  for (const section of document.querySelectorAll("main section")) {
    (section as HTMLElement).hidden = section.id !== `section-${name}`;
  }
  for (const btn of document.querySelectorAll("nav button")) {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.section === name);
  }
}
for (const btn of document.querySelectorAll("nav button")) {
  btn.addEventListener("click", () => showSection((btn as HTMLElement).dataset.section!));
}

/** Show the section requested via chrome.storage.session, then clear the key. */
function applyRequestedSection(section: string | undefined): void {
  if (section) {
    showSection(section);
    void chrome.storage.session.remove(OPEN_SECTION_KEY);
  }
}

void chrome.storage.session.get(OPEN_SECTION_KEY).then((items) => {
  applyRequestedSection(items[OPEN_SECTION_KEY] as string | undefined);
});

// The options page may already be open when a tab's error action requests a section switch
// (chrome.runtime.openOptionsPage only focuses an existing tab, it doesn't reload it), so also
// react live to the storage write instead of only reading it once at load.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "session") return;
  const change = changes[OPEN_SECTION_KEY];
  if (change && "newValue" in change && change.newValue !== undefined) {
    applyRequestedSection(change.newValue as string);
  }
});

// ---- account ----
function setupPasswordToggle(inputId: string, toggleId: string): void {
  $(toggleId).addEventListener("click", () => {
    const input = $<HTMLInputElement>(inputId);
    input.type = input.type === "password" ? "text" : "password";
  });
}
setupPasswordToggle("acc-password", "acc-pw-toggle");

async function initAccount(): Promise<void> {
  const cfg = await loadConfig();
  if (cfg.account) {
    $<HTMLInputElement>("acc-domain").value = cfg.account.domain;
    $<HTMLInputElement>("acc-username").value = cfg.account.username;
    $<HTMLInputElement>("acc-password").value = cfg.account.password;
  }
}

$("acc-save").addEventListener("click", () => {
  void (async () => {
    const domain = $<HTMLInputElement>("acc-domain").value.trim().toLowerCase();
    const username = $<HTMLInputElement>("acc-username").value.trim();
    const password = $<HTMLInputElement>("acc-password").value;
    if (/[/:\s]/.test(domain)) {
      setAccountStatus("Enter the hostname only (no scheme, port, or path).", true);
      return;
    }
    if (!(domain && username && password)) {
      setAccountStatus("Fill in Domain, Account, and Password, or use Sign Out to clear the account.", true);
      return;
    }
    await saveConfig({ account: { domain, username, password } });
    setAccountStatus("Saved. Web SIP Phone connects when an Allow Site page is open.");
    notifyConfigChanged();
  })();
});

$("acc-signout").addEventListener("click", () => {
  void (async () => {
    await clearAccount();
    for (const id of ["acc-domain", "acc-username", "acc-password"]) {
      $<HTMLInputElement>(id).value = "";
    }
    setAccountStatus("Account and credentials cleared.");
    notifyConfigChanged();
  })();
});

// Registration status indicator: reuse the broadcast display state.
chrome.runtime.onMessage.addListener((raw) => {
  if (isMsg(raw) && raw.target === "options" && raw.type === "state/update") {
    const runtime = raw.state.runtime;
    const text =
      runtime === RuntimeState.Ready
        ? "Registered"
        : runtime === RuntimeState.RegistrationFailed
          ? "Registration failed — check the values above"
          : runtime === RuntimeState.InactiveNoAllowedSite
            ? "Idle (no Allow Site page open)"
            : runtime === RuntimeState.Unconfigured
              ? ""
              : runtime.toLowerCase();
    setAccountStatus(text, runtime === RuntimeState.RegistrationFailed);
  }
  return false;
});

// ---- about ----
$("about-version").textContent = chrome.runtime.getManifest().version;
$("about-sipjs").textContent = __SIPJS_REF__;

void initAccount();

// ---- allow sites ----
let siteMutation: Promise<void> = Promise.resolve();
function mutateSites(fn: (sites: string[]) => string[] | null): Promise<void> {
  const run = siteMutation.then(async () => {
    const cfg = await loadConfig();
    const next = fn(cfg.allowSites);
    if (next === null) {
      return;
    }
    await saveConfig({ allowSites: next });
    notifyConfigChanged();
  });
  // Keep the queue alive after failures; callers observe `run` for the real outcome.
  siteMutation = run.catch(() => {});
  return run;
}

async function renderSites(): Promise<void> {
  const cfg = await loadConfig();
  const list = $("site-list");
  list.replaceChildren();
  for (const host of cfg.allowSites) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = host;
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      void (async () => {
        try {
          await mutateSites((sites) => sites.filter((h) => h !== host));
        } catch {
          $("site-error").textContent = "Could not remove the site. Please try again.";
          return;
        }
        // Revoke where possible; failure is non-fatal (design.md §5.2).
        await chrome.permissions.remove({ origins: [originPattern(host)] }).catch(() => {});
        await renderSites();
      })();
    });
    li.append(span, remove);
    list.appendChild(li);
  }
}

$("site-add").addEventListener("click", () => {
  void (async () => {
    $("site-error").textContent = "";
    const host = normalizeHostname($<HTMLInputElement>("site-input").value);
    if (!host) {
      $("site-error").textContent = "Enter a bare hostname, e.g. crm.example.com";
      return;
    }
    const cfg = await loadConfig();
    if (cfg.allowSites.includes(host)) {
      $("site-error").textContent = "Already configured.";
      return;
    }
    const granted = await chrome.permissions.request({ origins: [originPattern(host)] });
    if (!granted) {
      $("site-error").textContent = "Chrome permission was not granted.";
      return;
    }
    try {
      await mutateSites((sites) => (sites.includes(host) ? null : [...sites, host]));
    } catch {
      await chrome.permissions.remove({ origins: [originPattern(host)] }).catch(() => {});
      $("site-error").textContent = "Could not save the site. Please try again.";
      return;
    }
    $<HTMLInputElement>("site-input").value = "";
    await renderSites();
  })();
});

// ---- advanced: microphone ----
$("mic-test").addEventListener("click", () => {
  void (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
      stream.getTracks().forEach((t) => t.stop());
      $("mic-status").textContent = "Microphone OK.";
      notifyConfigChanged(); // runtime may now pass its mic gate
    } catch {
      $("mic-status").textContent =
        "Microphone blocked. Click the mic icon in the address bar or check chrome://settings/content/microphone, then test again.";
    }
  })();
});

// ---- advanced: TURN ----
setupPasswordToggle("turn-credential", "turn-cred-toggle");

async function initTurn(): Promise<void> {
  const cfg = await loadConfig();
  if (cfg.turn) {
    $<HTMLInputElement>("turn-enabled").checked = cfg.turn.enabled;
    $<HTMLInputElement>("turn-url").value = cfg.turn.url;
    $<HTMLInputElement>("turn-username").value = cfg.turn.username;
    $<HTMLInputElement>("turn-credential").value = cfg.turn.credential;
  }
}

$("turn-save").addEventListener("click", () => {
  void (async () => {
    await saveConfig({
      turn: {
        enabled: $<HTMLInputElement>("turn-enabled").checked,
        url: $<HTMLInputElement>("turn-url").value.trim(),
        username: $<HTMLInputElement>("turn-username").value.trim(),
        credential: $<HTMLInputElement>("turn-credential").value
      }
    });
    notifyConfigChanged();
  })();
});

void renderSites();
void initTurn();
