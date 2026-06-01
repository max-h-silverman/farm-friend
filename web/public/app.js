// Farm Friend admin SPA.
//
// Order of operations matters: define `window.adminApp` SYNCHRONOUSLY at the
// top of this module, before any await, so Alpine.js can always find it when
// it scans the DOM. To make sure that holds, the Firebase SDK imports are
// loaded *dynamically inside boot()* rather than at module top — top-level
// `import "https://..."` statements force the module to fetch them from the
// network before any of this code runs, which can race with Alpine's init
// and leave `window.adminApp` undefined at the wrong moment. Defining the
// component first and importing on-demand removes that race.

const CANONICAL_ACTIVITIES = [
  "harvest", "gleaning", "weeding", "planting", "transplanting",
  "livestock", "infrastructure", "processing",
];

const TEST_PRESETS = [
  { label: "YES",        value: "YES" },
  { label: "MAYBE",      value: "MAYBE" },
  { label: "HELP",       value: "HELP" },
  { label: "FLAG",       value: "FLAG" },
  { label: "STOP weeding", value: "STOP weeding" },
  { label: "farmer post",  value: "need 2 ppl tomorrow 10am to harvest greens" },
  { label: "vague post",   value: "need help with plum harvest tomorrow" },
  { label: "ambiguous",    value: "yeah idk depends on weather" },
];

// -- Visible error reporter -----------------------------------------------
function showError(msg, err) {
  const fullMsg = err ? `${msg}: ${err?.message || err}` : msg;
  console.error("[farm-friend]", fullMsg, err);
  const banner = document.getElementById("error-banner");
  const text = document.getElementById("error-banner-text");
  if (banner && text) {
    text.textContent = fullMsg;
    banner.hidden = false;
    return;
  }
  // Fallback if the banner isn't in the DOM yet.
  const div = document.createElement("div");
  div.className = "toast-error";
  div.textContent = fullMsg;
  document.body.appendChild(div);
}

function wireErrorBannerClose() {
  const closeBtn = document.getElementById("error-banner-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      document.getElementById("error-banner").hidden = true;
    });
  }
}
// `app.js` is a module, so it runs after parsing — but `DOMContentLoaded`
// may have fired already by the time we get here. Handle both cases.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireErrorBannerClose);
} else {
  wireErrorBannerClose();
}

// -- Synchronous Alpine component definition ------------------------------
window.adminApp = function adminApp() {
  return {
    // state
    tab: "worklist",
    ready: false,
    pendingUsers: [],
    openFlags: [],
    users: [],
    farms: [],
    opps: [],
    canonicalActivities: CANONICAL_ACTIVITIES,
    testPresets: TEST_PRESETS,
    filters: { farm: "", activity: "" },
    stats: { activeUsers: 0, openOpps: 0, outbound24h: 0 },
    test: {
      // Legacy single-thread fields (still referenced by some helpers).
      userId: "", body: "", running: false,
      // Multi-thread state. `pinnedUserIds` is the ordered list of user ids
      // currently visible as panels. `bodies` is keyed by user id so each
      // panel has its own input box. `runningByUser` is keyed by user id so
      // each panel shows its own busy state. `addPickerId` is the dropdown
      // value used by "+ Pin user" before it's committed via pinUser().
      pinnedUserIds: [],
      bodies: {},
      runningByUser: {},
      addPickerId: "",
      joinPhone: "",
      // Per-persona conversation threads. Key = user.id. Value = array of
      // turns: { kind: "inbound" | "outbound" | "typing" | "error" | "silence",
      //          body, to_phone?, fromLabel? }.
      threads: {},
      // Clear-DB control state. `clearArmed` toggles the type-to-confirm
      // input. `clearConfirmInput` holds what the user typed (must equal
      // "WIPE" before the Wipe button enables). `clearing` shows a busy
      // indicator while the callable runs. `clearResultMessage` shows
      // counts on success or an error message on failure.
      clearArmed: false,
      clearConfirmInput: "",
      clearing: false,
      clearResultMessage: "",
    },
    dayLabels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    expanded: { farmer: null, volunteer: null },
    farmEditor: {
      saving: false, farmId: "", farmName: "",
      typical_start_hour: null, typical_shift_duration_min: null, usual_days_of_week: [],
    },
    userEditor: {
      saving: false, userId: "", userName: "",
      available_days: [], available_start_hour: null, available_end_hour: null,
      max_commit_hours_per_week: null,
    },
    _db: null,
    _functions: null,
    _booted: false,
    _readyMarks: 0,

    async boot() {
      if (this._booted) return;
      this._booted = true;
      try {
        await initializeFirebaseAndAuth(this);
      } catch (e) {
        showError("Bootstrap failed", e);
      }
    },

    _markReady() {
      // We consider the app "ready" once the first snapshot of each critical
      // collection has landed. Used to swap skeletons → empty/full states.
      this._readyMarks = (this._readyMarks || 0) + 1;
      if (this._readyMarks >= 5 && !this.ready) this.ready = true;
    },

    _subscribePending() {
      const { query, collection, where, orderBy, onSnapshot } = window.__fb;
      const q = query(
        collection(this._db, "pending_users"),
        where("status", "==", "pending"),
        orderBy("created_at", "desc"),
      );
      onSnapshot(q, (snap) => {
        this.pendingUsers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        this._markReady();
      }, (err) => showError("pending_users subscription failed", err));
    },

    _subscribeFlags() {
      const { query, collection, where, orderBy, onSnapshot } = window.__fb;
      const q = query(
        collection(this._db, "flags"),
        where("resolved_at", "==", null),
        orderBy("created_at", "desc"),
      );
      onSnapshot(q, (snap) => {
        this.openFlags = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        this._markReady();
      }, (err) => showError("flags subscription failed", err));
    },

    _subscribeUsers() {
      const { query, collection, orderBy, onSnapshot } = window.__fb;
      const q = query(collection(this._db, "users"), orderBy("name"));
      onSnapshot(q, (snap) => {
        this.users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        this._markReady();
      }, (err) => showError("users subscription failed", err));
    },

    _subscribeFarms() {
      const { collection, onSnapshot } = window.__fb;
      onSnapshot(
        collection(this._db, "farms"),
        (snap) => {
          this.farms = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          this._markReady();
        },
        (err) => showError("farms subscription failed", err),
      );
    },

    _subscribeOpps() {
      const { query, collection, orderBy, onSnapshot } = window.__fb;
      const q = query(collection(this._db, "opportunities"), orderBy("created_at", "desc"));
      onSnapshot(q, (snap) => {
        this.opps = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        this._markReady();
      }, (err) => showError("opportunities subscription failed", err));
    },

    async _refreshStats() {
      const { Timestamp, getCountFromServer, query, collection, where } = window.__fb;
      const since = Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
      try {
        const activeUsers = await getCountFromServer(
          query(collection(this._db, "users"), where("status", "==", "active")),
        );
        const openOpps = await getCountFromServer(
          query(collection(this._db, "opportunities"), where("status", "in", ["open", "filling"])),
        );
        const outbound = await getCountFromServer(
          query(
            collection(this._db, "messages"),
            where("direction", "==", "outbound"),
            where("created_at", ">=", since),
          ),
        );
        this.stats = {
          activeUsers: activeUsers.data().count,
          openOpps: openOpps.data().count,
          outbound24h: outbound.data().count,
        };
      } catch (e) {
        console.warn("stats refresh failed", e);
      }
    },

    // ------------- derived state -------------
    get worklistCount() {
      return this.openFlags.length + this.pendingUsers.length;
    },

    get filteredOpps() {
      return this.opps.filter((o) => {
        if (this.filters.farm && o.farm_id !== this.filters.farm) return false;
        if (this.filters.activity) {
          const tags = o.activity_tags || [];
          if (!tags.includes(this.filters.activity)) return false;
        }
        return true;
      });
    },

    get farmerUsers() {
      return this.users.filter((u) => u.role === "farmer" || u.role === "both");
    },

    get volunteerUsers() {
      return this.users.filter((u) => u.role === "volunteer" || u.role === "both");
    },

    farmName(id) {
      if (!id) return "";
      const f = this.farms.find((x) => x.id === id);
      return f ? f.name : id;
    },

    farmForOwner(userId) {
      return this.farms.find((f) => f.owner_user_id === userId);
    },

    farmNameForOwner(userId) {
      const f = this.farmForOwner(userId);
      return f ? f.name : "(no farm yet)";
    },

    hasFarmDefaults(userId) {
      const f = this.farmForOwner(userId);
      if (!f) return false;
      return (
        (f.typical_start_hour !== null && f.typical_start_hour !== undefined) ||
        (f.typical_shift_duration_min !== null && f.typical_shift_duration_min !== undefined) ||
        (Array.isArray(f.usual_days_of_week) && f.usual_days_of_week.length > 0)
      );
    },

    hasAvailability(u) {
      return (
        (Array.isArray(u.available_days) && u.available_days.length > 0) ||
        (u.available_start_hour !== null && u.available_start_hour !== undefined) ||
        (u.available_end_hour !== null && u.available_end_hour !== undefined) ||
        (u.max_commit_hours_per_week !== null && u.max_commit_hours_per_week !== undefined)
      );
    },

    statusClass(status) {
      switch (status) {
        case "open":
        case "filling": return "ok";
        case "full":    return "info";
        case "draft":   return "attention";
        case "cancelled":
        case "expired": return "neutral";
        case "completed": return "neutral";
        default: return "neutral";
      }
    },

    seatsPct(o) {
      if (!o.headcount_needed) return 0;
      const pct = ((o.seats_filled || 0) / o.headcount_needed) * 100;
      return Math.min(100, Math.max(0, pct));
    },

    formatTime(ts) {
      if (!ts) return "";
      const d = ts.toDate ? ts.toDate() : new Date(ts);
      return d.toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
    },

    // ------------- Roster expansion -------------
    toggleFarmer(u) {
      if (this.expanded.farmer === u.id) {
        this.expanded.farmer = null;
        return;
      }
      const f = this.farmForOwner(u.id);
      if (!f) {
        showError("No farm found for this farmer.");
        return;
      }
      this.farmEditor = {
        saving: false, farmId: f.id, farmName: f.name,
        typical_start_hour: f.typical_start_hour ?? null,
        typical_shift_duration_min: f.typical_shift_duration_min ?? null,
        usual_days_of_week: Array.isArray(f.usual_days_of_week) ? [...f.usual_days_of_week] : [],
      };
      this.expanded.farmer = u.id;
      this.expanded.volunteer = null;
    },

    async saveFarmDefaults() {
      this.farmEditor.saving = true;
      try {
        const call = window.__fb.httpsCallable(this._functions, "update_farm_defaults");
        await call({
          farm_id: this.farmEditor.farmId,
          typical_start_hour: this.farmEditor.typical_start_hour,
          typical_shift_duration_min: this.farmEditor.typical_shift_duration_min,
          usual_days_of_week: this.farmEditor.usual_days_of_week,
        });
        this.expanded.farmer = null;
      } catch (e) {
        showError("Save defaults failed", e);
      } finally {
        this.farmEditor.saving = false;
      }
    },

    toggleVolunteer(u) {
      if (this.expanded.volunteer === u.id) {
        this.expanded.volunteer = null;
        return;
      }
      this.userEditor = {
        saving: false, userId: u.id, userName: u.name,
        available_days: Array.isArray(u.available_days) ? [...u.available_days] : [],
        available_start_hour: u.available_start_hour ?? null,
        available_end_hour: u.available_end_hour ?? null,
        max_commit_hours_per_week: u.max_commit_hours_per_week ?? null,
      };
      this.expanded.volunteer = u.id;
      this.expanded.farmer = null;
    },

    async saveUserAvailability() {
      this.userEditor.saving = true;
      try {
        const call = window.__fb.httpsCallable(this._functions, "update_user_availability");
        await call({
          user_id: this.userEditor.userId,
          available_days: this.userEditor.available_days,
          available_start_hour: this.userEditor.available_start_hour,
          available_end_hour: this.userEditor.available_end_hour,
          max_commit_hours_per_week: this.userEditor.max_commit_hours_per_week,
        });
        this.expanded.volunteer = null;
      } catch (e) {
        showError("Save availability failed", e);
      } finally {
        this.userEditor.saving = false;
      }
    },

    // ------------- Worklist actions -------------
    async approve(pending, role) {
      const call = window.__fb.httpsCallable(this._functions, "approve_pending_user");
      try { await call({ pending_id: pending.id, role }); }
      catch (e) { showError("Approve failed", e); }
    },

    async reject(pending) {
      const { updateDoc, doc, serverTimestamp } = window.__fb;
      try {
        await updateDoc(doc(this._db, "pending_users", pending.id), {
          status: "rejected",
          resolved_at: serverTimestamp(),
        });
      } catch (e) {
        showError("Reject failed", e);
      }
    },

    async suspend(user) {
      const call = window.__fb.httpsCallable(this._functions, "suspend_user");
      try { await call({ user_id: user.id }); }
      catch (e) { showError("Suspend failed", e); }
    },

    async resolve(flag) {
      const call = window.__fb.httpsCallable(this._functions, "resolve_flag");
      try { await call({ flag_id: flag.id }); }
      catch (e) { showError("Resolve failed", e); }
    },

    // ------------- System Test -------------
    threadFor(userId) {
      if (!userId) return [];
      if (!this.test.threads[userId]) this.test.threads[userId] = [];
      return this.test.threads[userId];
    },

    bodyFor(userId) {
      return this.test.bodies[userId] || "";
    },

    setBodyFor(userId, value) {
      this.test.bodies = { ...this.test.bodies, [userId]: value };
    },

    runningFor(userId) {
      return !!this.test.runningByUser[userId];
    },

    isPhoneThread(userId) {
      return typeof userId === "string" && userId.startsWith("phone:");
    },

    phoneForThread(userId) {
      return this.isPhoneThread(userId) ? userId.slice("phone:".length) : "";
    },

    userLabel(userId) {
      if (this.isPhoneThread(userId)) return `Unapproved phone · ${this.phoneForThread(userId)}`;
      const u = this.users.find((x) => x.id === userId);
      return u ? `${u.name} · ${u.role}` : userId;
    },

    availableUsersToPin() {
      // Users who aren't already pinned.
      const pinned = new Set(this.test.pinnedUserIds);
      return this.users.filter((u) => !pinned.has(u.id));
    },

    pinUser(userId) {
      if (!userId) return;
      if (this.test.pinnedUserIds.includes(userId)) return;
      this.test.pinnedUserIds.push(userId);
      this.test.addPickerId = "";
    },

    normalizeTestPhone(value) {
      const raw = String(value || "").trim();
      if (!raw) return "";
      if (raw.startsWith("+")) return `+${raw.slice(1).replace(/\D/g, "")}`;
      const digits = raw.replace(/\D/g, "");
      if (digits.length === 10) return `+1${digits}`;
      if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
      return digits ? `+${digits}` : "";
    },

    pinPhone() {
      const phone = this.normalizeTestPhone(this.test.joinPhone);
      if (!phone || phone.length < 8) return;
      const key = `phone:${phone}`;
      if (!this.test.pinnedUserIds.includes(key)) {
        this.test.pinnedUserIds.push(key);
      }
      this.test.joinPhone = "";
      if (!this.test.bodies[key]) this.setBodyFor(key, "JOIN");
    },

    unpinUser(userId) {
      this.test.pinnedUserIds = this.test.pinnedUserIds.filter((id) => id !== userId);
    },

    clearThread(userId) {
      if (userId) this.test.threads[userId] = [];
    },

    fillPreset(userId, value) {
      this.setBodyFor(userId, value);
    },

    async runTest(userId) {
      // Backwards-compat: if called with no arg, fall back to the legacy
      // single-thread state. New panel-based UI always passes userId.
      if (!userId) userId = this.test.userId;
      const body = (this.test.bodies[userId] ?? this.test.body ?? "").trim();
      if (!userId || !body) return;
      const user = this.users.find((u) => u.id === userId);
      const phone = this.phoneForThread(userId);
      const fromLabel = user
        ? `${user.name} (${user.phone})`
        : phone || userId;

      const thread = this.threadFor(userId);
      thread.push({ kind: "inbound", body, fromLabel });
      // Animated "typing" indicator while dispatch + agent run. Simulator
      // only — real SMS has no typing-indicator equivalent on the carrier
      // side, so this is a UI affordance for the System Test page only.
      thread.push({ kind: "typing" });
      this.setBodyFor(userId, "");
      this.test.runningByUser = { ...this.test.runningByUser, [userId]: true };
      const removeTyping = () => {
        const idx = thread.findIndex((t) => t.kind === "typing");
        if (idx !== -1) thread.splice(idx, 1);
      };
      try {
        const call = window.__fb.httpsCallable(this._functions, "simulate_inbound_sms");
        const payload = phone ? { phone, body } : { user_id: userId, body };
        const resp = await call(payload);
        const outbound = resp.data?.outbound || [];
        removeTyping();
        if (outbound.length === 0) {
          thread.push({ kind: "silence" });
        } else {
          for (const m of outbound) {
            const recipient = this.users.find((u) => u.phone === m.to_phone);
            const toLabel = recipient
              ? `${recipient.name} (${m.to_phone})`
              : m.to_phone;
            thread.push({ kind: "outbound", body: m.body, to_phone: m.to_phone, toLabel });
          }
        }
      } catch (e) {
        removeTyping();
        thread.push({ kind: "error", body: e?.message || String(e) });
      } finally {
        this.test.runningByUser = { ...this.test.runningByUser, [userId]: false };
      }
    },

    async clearTestData() {
      // Server gates on the literal "WIPE"; the UI gates the button too,
      // but double-check before calling.
      if (this.test.clearConfirmInput !== "WIPE") return;
      this.test.clearing = true;
      this.test.clearResultMessage = "";
      try {
        const call = window.__fb.httpsCallable(this._functions, "clear_test_data");
        const resp = await call({ confirm: "WIPE" });
        const d = resp.data?.deleted || {};
        const parts = [];
        if (d.opportunities) parts.push(`${d.opportunities} opp`);
        if (d.opportunities_subcollections) parts.push(`${d.opportunities_subcollections} sub-doc`);
        if (d.messages) parts.push(`${d.messages} msg`);
        if (d.offers) parts.push(`${d.offers} offer`);
        if (d.flags) parts.push(`${d.flags} flag`);
        const summary = parts.length ? parts.join(", ") : "nothing to delete";
        this.test.clearResultMessage = `Cleared: ${summary}.`;
        // Also clear every visible thread so the UI matches the DB.
        for (const uid of this.test.pinnedUserIds) {
          this.test.threads[uid] = [];
        }
      } catch (e) {
        this.test.clearResultMessage = `Clear failed: ${e?.message || e}`;
      } finally {
        this.test.clearing = false;
        this.test.clearArmed = false;
        this.test.clearConfirmInput = "";
        // Auto-fade the result after 8 seconds so it doesn't linger forever.
        setTimeout(() => {
          this.test.clearResultMessage = "";
        }, 8000);
      }
    },

    // Legacy aliases so older bindings still work if anything references them.
    activeThread() { return this.threadFor(this.test.userId); },
    clearActiveThread() { this.clearThread(this.test.userId); },
  };
};

// Held by initializeFirebaseAndAuth so the subscription helpers and callable
// wrappers below can use them without re-importing every call.
let _fb = null;

async function loadFirebase() {
  if (_fb) return _fb;
  const [appMod, authMod, fsMod, fnMod] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js"),
    import("https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"),
    import("https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js"),
  ]);
  _fb = {
    initializeApp: appMod.initializeApp,
    getAuth: authMod.getAuth,
    GoogleAuthProvider: authMod.GoogleAuthProvider,
    signInWithPopup: authMod.signInWithPopup,
    onAuthStateChanged: authMod.onAuthStateChanged,
    signOut: authMod.signOut,
    getFirestore: fsMod.getFirestore,
    collection: fsMod.collection,
    onSnapshot: fsMod.onSnapshot,
    query: fsMod.query,
    where: fsMod.where,
    orderBy: fsMod.orderBy,
    getCountFromServer: fsMod.getCountFromServer,
    Timestamp: fsMod.Timestamp,
    updateDoc: fsMod.updateDoc,
    doc: fsMod.doc,
    serverTimestamp: fsMod.serverTimestamp,
    getFunctions: fnMod.getFunctions,
    httpsCallable: fnMod.httpsCallable,
  };
  // Expose for the methods on the component (which run after boot completes).
  window.__fb = _fb;
  return _fb;
}

// -- Async Firebase initialization ----------------------------------------
async function initializeFirebaseAndAuth(component) {
  const fb = await loadFirebase();
  const {
    initializeApp, getAuth, GoogleAuthProvider, signInWithPopup,
    onAuthStateChanged, signOut, getFirestore, getFunctions,
  } = fb;

  // 1. Fetch the auto-injected Firebase config from Hosting.
  let config;
  try {
    const resp = await fetch("/__/firebase/init.json");
    if (!resp.ok) {
      throw new Error(`init.json returned ${resp.status}. Are you viewing this on Firebase Hosting?`);
    }
    config = await resp.json();
  } catch (e) {
    showError("Could not load Firebase config", e);
    return;
  }

  // 2. Init Firebase services.
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, "us-west1");

  component._db = db;
  component._functions = functions;

  // 3. Auth gate.
  const signInGate = document.getElementById("signin-gate");
  const signInPending = document.getElementById("signin-pending");
  const appMain = document.getElementById("app");
  const authStatus = document.getElementById("auth-status");

  document.getElementById("signin-btn").addEventListener("click", async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) { showError("Sign-in failed", e); }
  });

  // Event-delegated sign-out (works regardless of which path rendered the button).
  authStatus.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action='signout']");
    if (btn) {
      signOut(auth).catch((err) => showError("Sign-out failed", err));
    }
  });

  function authMetaHtml(user) {
    return `
      <span class="email">${user.email}</span>
      <button class="icon-btn" data-action="signout" title="Sign out" aria-label="Sign out">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M16 17l5-5-5-5"/>
          <path d="M21 12H9"/>
          <path d="M13 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h7"/>
        </svg>
      </button>`;
  }

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      signInGate.hidden = false;
      appMain.hidden = true;
      authStatus.innerHTML = "";
      if (signInPending) signInPending.hidden = true;
      return;
    }
    let token;
    try {
      token = await user.getIdTokenResult(/*forceRefresh=*/ true);
    } catch (e) {
      showError("Could not read auth token", e);
      return;
    }
    if (!token.claims.admin) {
      signInGate.hidden = false;
      appMain.hidden = true;
      authStatus.innerHTML = "";
      if (signInPending) {
        signInPending.hidden = false;
        signInPending.textContent =
          `Signed in as ${user.email}. Waiting for admin access.`;
      }
      return;
    }
    signInGate.hidden = true;
    appMain.hidden = false;
    authStatus.innerHTML = authMetaHtml(user);

    // Start Firestore subscriptions now that the user is admin-authenticated.
    component._subscribePending();
    component._subscribeFlags();
    component._subscribeUsers();
    component._subscribeFarms();
    component._subscribeOpps();
    component._refreshStats();
  });
}
