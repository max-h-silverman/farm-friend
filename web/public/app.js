// Farm Friend admin SPA.
//
// Order of operations matters: define `window.adminApp` SYNCHRONOUSLY at the
// top of this module, before any await, so Alpine.js can always find it when
// it scans the DOM. All async work happens inside boot() which Alpine calls
// after the component initializes.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, collection, onSnapshot, query, where, orderBy, getCountFromServer, Timestamp,
  updateDoc, doc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getFunctions, httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";

const CANONICAL_ACTIVITIES = [
  "harvest", "gleaning", "weeding", "planting", "transplanting",
  "livestock", "infrastructure", "processing",
];

// -- Visible error reporter -----------------------------------------------
function showError(msg, err) {
  const fullMsg = err ? `${msg}: ${err?.message || err}` : msg;
  console.error("[farm-friend]", fullMsg, err);
  const banner = document.getElementById("error-banner");
  if (banner) {
    banner.textContent = fullMsg;
    banner.hidden = false;
  } else {
    // banner not in DOM yet — fall back to inline div
    const div = document.createElement("div");
    div.style.cssText =
      "position:fixed;top:0;left:0;right:0;background:#b94b4b;color:white;padding:12px;font-family:monospace;z-index:9999;";
    div.textContent = fullMsg;
    document.body.appendChild(div);
  }
}

// -- Synchronous Alpine component definition ------------------------------
// Defined BEFORE any await so it's always present when Alpine boots.
// The boot() method does the actual async wiring.
window.adminApp = function adminApp() {
  return {
    // state
    tab: "worklist",
    pendingUsers: [],
    openFlags: [],
    users: [],
    farms: [],
    opps: [],
    canonicalActivities: CANONICAL_ACTIVITIES,
    filters: { farm: "", activity: "" },
    stats: { activeUsers: 0, openOpps: 0, outbound24h: 0 },
    _db: null,
    _functions: null,
    _booted: false,

    async boot() {
      if (this._booted) return;
      this._booted = true;
      try {
        await initializeFirebaseAndAuth(this);
      } catch (e) {
        showError("Bootstrap failed", e);
      }
    },

    _subscribePending() {
      const q = query(
        collection(this._db, "pending_users"),
        where("status", "==", "pending"),
        orderBy("created_at", "desc"),
      );
      onSnapshot(q, (snap) => {
        this.pendingUsers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      }, (err) => showError("pending_users subscription failed", err));
    },

    _subscribeFlags() {
      const q = query(
        collection(this._db, "flags"),
        where("resolved_at", "==", null),
        orderBy("created_at", "desc"),
      );
      onSnapshot(q, (snap) => {
        this.openFlags = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      }, (err) => showError("flags subscription failed", err));
    },

    _subscribeUsers() {
      const q = query(collection(this._db, "users"), orderBy("name"));
      onSnapshot(q, (snap) => {
        this.users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      }, (err) => showError("users subscription failed", err));
    },

    _subscribeFarms() {
      onSnapshot(
        collection(this._db, "farms"),
        (snap) => {
          this.farms = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        },
        (err) => showError("farms subscription failed", err),
      );
    },

    _subscribeOpps() {
      const q = query(collection(this._db, "opportunities"), orderBy("created_at", "desc"));
      onSnapshot(q, (snap) => {
        this.opps = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      }, (err) => showError("opportunities subscription failed", err));
    },

    async _refreshStats() {
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

    farmName(id) {
      const f = this.farms.find((x) => x.id === id);
      return f ? f.name : id;
    },

    formatTime(ts) {
      if (!ts) return "";
      const d = ts.toDate ? ts.toDate() : new Date(ts);
      return d.toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
    },

    async approve(pending, role) {
      const call = httpsCallable(this._functions, "approve_pending_user");
      try { await call({ pending_id: pending.id, role }); }
      catch (e) { showError("Approve failed", e); }
    },

    async reject(pending) {
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
      const call = httpsCallable(this._functions, "suspend_user");
      try { await call({ user_id: user.id }); }
      catch (e) { showError("Suspend failed", e); }
    },

    async resolve(flag) {
      const call = httpsCallable(this._functions, "resolve_flag");
      try { await call({ flag_id: flag.id }); }
      catch (e) { showError("Resolve failed", e); }
    },
  };
};

// -- Async Firebase initialization ----------------------------------------
async function initializeFirebaseAndAuth(component) {
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
  const appMain = document.getElementById("app");
  const authStatus = document.getElementById("auth-status");

  document.getElementById("signin-btn").addEventListener("click", async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) { showError("Sign-in failed", e); }
  });

  // Event-delegated sign-out (works regardless of which path rendered the button).
  authStatus.addEventListener("click", (e) => {
    if (e.target && e.target.id === "signout-btn") {
      signOut(auth).catch((err) => showError("Sign-out failed", err));
    }
  });

  function signOutButtonHtml() {
    return ` <button class="ghost" id="signout-btn">Sign out</button>`;
  }

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      signInGate.hidden = false;
      appMain.hidden = true;
      authStatus.textContent = "";
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
      authStatus.innerHTML =
        `Signed in as ${user.email} — not an admin yet.` + signOutButtonHtml();
      return;
    }
    signInGate.hidden = true;
    appMain.hidden = false;
    authStatus.innerHTML = `${user.email}` + signOutButtonHtml();

    // Start Firestore subscriptions now that the user is admin-authenticated.
    component._subscribePending();
    component._subscribeFlags();
    component._subscribeUsers();
    component._subscribeFarms();
    component._subscribeOpps();
    component._refreshStats();
  });
}
